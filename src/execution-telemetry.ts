import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  browserCommandContract,
  MCP_HOST_BEHAVIOR_VERSION,
  MCP_TOOL_COUNT,
  STAGE5_BROWSER_VERSION,
  TOOL_CATALOG_VERSION,
  type BrowserCommandName,
  type BrowserExecutionTrace,
  type ExecutionTraceConclusion,
  type ExecutionTraceList,
  type PostconditionCheck,
  type RuntimeProcessInfo,
  type SerializedStage5BrowserError,
  type WorkerCommandTelemetry,
} from './execution-telemetry-dependencies.js';
import {
  handoffReleaseConclusion,
  nativeReattachConclusion,
  profileOwnershipConclusion,
} from './execution-telemetry/lifecycle-conclusions.js';
import { normalizeTrace, privacyContract, summarizeTrace, type ExecutionTraceFilters } from './execution-telemetry/query.js';
import {
  activationTransportConclusion,
  controlRevealInteractionConclusion,
  formFieldRebindingConclusion,
  searchableSelectionConclusion,
  selectionInteractionConclusion,
} from './execution-telemetry/interaction-conclusions.js';
import {
  boundedNullableInteger,
  isRecord,
  nullableBoolean,
  valuesForKey,
} from './execution-telemetry/value-readers.js';

const MAX_TELEMETRY_BYTES = 4 * 1_024 * 1_024;
const RETAINED_TELEMETRY_BYTES = 2 * 1_024 * 1_024;
const SAFE_REASON = /^[a-z][a-z0-9_]{0,99}$/u;
const CHECK_KINDS = new Set<PostconditionCheck['kind']>(['download', 'new_page_url', 'popup_closed', 'selected', 'selection_representation', 'url', 'visible']);
const POPUP_ASSOCIATION_PROOFS = new Set<ExecutionTraceConclusion['popupAssociationProof']>([
  'active_descendant',
  'explicit',
  'structural',
  'focused',
  'expanded',
  'spatial',
  'agent_declared',
  'post_dispatch_unique',
]);
const POPUP_SURFACE_PROOFS = new Set<ExecutionTraceConclusion['popupSurfaceProof']>(['semantic_role', 'positioned_option_group']);
const POPUP_OWNER_PROOF_TIERS = new Set<NonNullable<ExecutionTraceConclusion['popupOwnership']>['proofTier']>([
  'expanded',
  'focused',
  'spatial',
  'structural',
  'none',
]);
const POPUP_OWNER_DECISION_STATES = new Set<NonNullable<ExecutionTraceConclusion['popupOwnership']>['decision']>([
  'covered_siblings_excluded',
  'decisive_distance',
  'missing',
  'single_candidate',
  'structural_conflict',
  'tie_or_near',
  'unbounded',
]);
type PopupOwnerTargetFirstMiss = NonNullable<NonNullable<ExecutionTraceConclusion['popupOwnership']>['targetFirstMiss']>;
const POPUP_OWNER_TARGET_FIRST_MISSES = new Set<PopupOwnerTargetFirstMiss>([
  'competing_structural_owner',
  'insufficient_focus_or_expansion',
  'not_spatial',
  'relation_unavailable',
  'target_unavailable',
]);
const VIEWPORT_EVIDENCE = new Set<NonNullable<ExecutionTraceConclusion['targetState']>['viewportEvidence']>([
  'clipped_geometry',
  'exact_hit_test_override',
  'none',
]);
const POINTER_HIT_POINTS = new Set<NonNullable<ExecutionTraceConclusion['targetState']>['pointerHitPoint']>(['center', 'alternate']);
const REQUESTED_CONTROL_RESOLUTIONS = new Set<NonNullable<ExecutionTraceConclusion['controlRecovery']>['requestedControlResolution']>([
  'resolved',
  'missing',
  'recovered_observed_owner',
]);
const POPUP_OWNER_DECISIONS = new Set<NonNullable<ExecutionTraceConclusion['controlRecovery']>['popupOwnerDecision']>([
  'not_required',
  'required',
  'unavailable',
  'consumed',
]);
const SELECTION_TARGET_RESOLUTIONS = new Set<NonNullable<ExecutionTraceConclusion['selectionReconciliation']>['targetResolution']>([
  'retained_exact',
  'retained_scope_after_control_replacement',
  'rebound_exact',
  'unresolved',
]);
const SELECTION_TERMINAL_PROOFS = new Set<NonNullable<ExecutionTraceConclusion['selectionReconciliation']>['terminalProof']>([
  'selected_state',
  'representation_change',
  'popup_closed',
  'unresolved',
]);

export type { ExecutionTraceFilters } from './execution-telemetry/query.js';

export interface BuildExecutionTraceInput {
  operationId: string;
  agentId: string | null;
  command: BrowserCommandName | 'recover';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  outcome: 'succeeded' | 'failed' | 'timed_out';
  error: SerializedStage5BrowserError | null;
  result: unknown;
  workerRuntime: RuntimeProcessInfo | null;
  workerTelemetry: WorkerCommandTelemetry | null;
}

export class ExecutionTelemetryJournal {
  private readonly filePath: string;
  private initialized = false;

  constructor(artifactsDir: string) {
    this.filePath = path.join(artifactsDir, 'execution-telemetry.jsonl');
  }

  async append(trace: BrowserExecutionTrace): Promise<void> {
    if (!this.initialized) {
      await mkdir(path.dirname(this.filePath), {
        recursive: true,
        mode: 0o700,
      });
      this.initialized = true;
    }
    await this.compactIfNeeded();
    await appendFile(this.filePath, `${JSON.stringify(trace)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(this.filePath, 0o600);
  }

  async list(operationId: string | null, limit: number, filters: ExecutionTraceFilters = {}): Promise<ExecutionTraceList> {
    const agentId = filters.agentId ?? null;
    const command = filters.command ?? null;
    const outcome = filters.outcome ?? null;
    const detail = filters.detail ?? 'full';
    let contents: string;
    try {
      contents = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { traces: [], limit, operationId, agentId, command, outcome, detail, privacy: privacyContract() };
      }
      throw error;
    }
    const traces = contents
      .trimEnd()
      .split('\n')
      .flatMap((line) => {
        try {
          const trace = JSON.parse(line) as Partial<BrowserExecutionTrace>;
          return (trace.schemaVersion === 1 || trace.schemaVersion === 2) && typeof trace.operationId === 'string' ? [normalizeTrace(trace)] : [];
        } catch {
          return [];
        }
      })
      .filter((trace) => operationId === null || trace.operationId === operationId)
      .filter((trace) => agentId === null || trace.agentId === agentId)
      .filter((trace) => command === null || trace.command === command)
      .filter((trace) => outcome === null || trace.outcome === outcome);
    const selected = traces.slice(-limit);
    return {
      traces: detail === 'full' ? selected : selected.map(summarizeTrace),
      limit,
      operationId,
      agentId,
      command,
      outcome,
      detail,
      privacy: privacyContract(),
    };
  }

  private async compactIfNeeded(): Promise<void> {
    let size: number;
    try {
      size = (await stat(this.filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (size < MAX_TELEMETRY_BYTES) return;
    const contents = await readFile(this.filePath, 'utf8');
    const retainedStart = Math.max(0, contents.length - RETAINED_TELEMETRY_BYTES);
    const firstCompleteLine = contents.indexOf('\n', retainedStart) + 1;
    const retained = firstCompleteLine <= 0 ? '' : contents.slice(firstCompleteLine);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, retained, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.filePath);
    await chmod(this.filePath, 0o600);
  }
}

export function buildExecutionTrace(input: BuildExecutionTraceInput): BrowserExecutionTrace {
  const contract =
    input.command === 'recover'
      ? {
          manager: 'recovery_manager' as const,
          phaseSystem: 'supervisor_recovery' as const,
          dispatch: 'lifecycle_transition' as const,
          replay: 'supervisor_only' as const,
        }
      : browserCommandContract(input.command);
  return {
    schemaVersion: 2,
    traceId: randomUUID(),
    recordedAtMs: Date.now(),
    operationId: input.operationId,
    agentId: input.agentId,
    command: input.command,
    manager: contract.manager,
    phaseSystem: contract.phaseSystem,
    dispatchBoundary: contract.dispatch,
    replayPolicy: contract.replay,
    host: {
      version: STAGE5_BROWSER_VERSION,
      behaviorVersion: MCP_HOST_BEHAVIOR_VERSION,
      toolCatalogVersion: TOOL_CATALOG_VERSION,
      toolCount: MCP_TOOL_COUNT,
    },
    worker: {
      version: input.workerRuntime?.version ?? null,
      protocolVersion: input.workerRuntime?.protocolVersion ?? null,
    },
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: Math.max(0, input.durationMs),
    outcome: input.outcome,
    errorCode: input.error?.code ?? null,
    reason: safeReason(input.error?.details?.reason),
    actions: (input.workerTelemetry?.actionPhases ?? []).map((action) => ({
      action: action.action,
      durationMs: action.completedAtMs === null ? null : Math.max(0, action.completedAtMs - action.startedAtMs),
      dispatchState: action.dispatchState,
      dispatchAttempts: action.dispatchAttempts,
      recoveryReason: action.recovery?.reason ?? null,
      viewportPreparation: action.viewportPreparation ?? null,
      terminalOutcome: action.terminalOutcome,
      phases: action.transitions.map((transition, index, transitions) => ({
        phase: transition.phase,
        attempt: transition.attempt,
        offsetMs: Math.max(0, transition.enteredAtMs - action.startedAtMs),
        durationMs: phaseDuration(transition.enteredAtMs, transitions[index + 1]?.enteredAtMs, action.completedAtMs),
      })),
    })),
    conclusion: conclusionFrom(input.result, input.error, input.workerTelemetry),
    privacy: privacyContract(),
  };
}

function conclusionFrom(result: unknown, error: SerializedStage5BrowserError | null, workerTelemetry: WorkerCommandTelemetry | null): ExecutionTraceConclusion {
  const combined = { result, error };
  const checks = checkSummaries(combined);
  const explicitActionDispatched = dispatchConclusion(valuesForKey(combined, 'actionDispatched'));
  return {
    actionDispatched: explicitActionDispatched ?? phaseDispatchConclusion(workerTelemetry),
    clickDispatched: dispatchConclusion(valuesForKey(combined, 'clickDispatched')),
    activationTransport: activationTransportConclusion(combined),
    postconditionPassed: postconditionPassed(combined),
    checks,
    selectionDesiredState: directBoolean(result, 'selected'),
    selectionObservedState: booleanConclusion(valuesForKey(combined, 'selectedState')),
    selectionEffectObserved: booleanConclusion(valuesForKey(combined, 'selectionEffectObserved')),
    selectedRepresentationObserved: booleanConclusion(valuesForKey(combined, 'selectedRepresentationObserved')),
    popupClosed: booleanConclusion(valuesForKey(combined, 'popupClosed')),
    popupAssociationProof: enumConclusion(valuesForKey(combined, 'associationProof'), POPUP_ASSOCIATION_PROOFS),
    popupSurfaceProof: enumConclusion(valuesForKey(combined, 'surfaceProof'), POPUP_SURFACE_PROOFS),
    renderedPopupCount: boundedIntegerConclusion(valuesForKey(combined, 'renderedPopupCount'), 50),
    popupOwnership: popupOwnershipConclusion(combined),
    controlRecovery: controlRecoveryConclusion(combined),
    controlRevealInteraction: controlRevealInteractionConclusion(combined),
    selectionReconciliation: selectionReconciliationConclusion(combined),
    selectionInteraction: selectionInteractionConclusion(combined),
    searchableSelection: searchableSelectionConclusion(combined),
    formFieldRebinding: formFieldRebindingConclusion(combined),
    profileOwnership: profileOwnershipConclusion(result, error),
    handoffRelease: handoffReleaseConclusion(result, error),
    nativeReattach: nativeReattachConclusion(result, error),
    targetState: targetStateConclusion(combined),
  };
}

function selectionReconciliationConclusion(value: unknown): ExecutionTraceConclusion['selectionReconciliation'] {
  const observed = valuesForKey(value, 'reconciliation').flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const targetResolution = candidate.targetResolution;
    const terminalProof = candidate.terminalProof;
    const attempts = boundedNullableInteger(candidate.attempts, 100);
    const durationMs = boundedNullableInteger(candidate.durationMs, 60_000);
    if (
      typeof targetResolution !== 'string' ||
      !SELECTION_TARGET_RESOLUTIONS.has(targetResolution as NonNullable<ExecutionTraceConclusion['selectionReconciliation']>['targetResolution']) ||
      typeof terminalProof !== 'string' ||
      !SELECTION_TERMINAL_PROOFS.has(terminalProof as NonNullable<ExecutionTraceConclusion['selectionReconciliation']>['terminalProof']) ||
      attempts === undefined || attempts === null || durationMs === undefined || durationMs === null
    ) return [];
    return [{
      targetResolution: targetResolution as NonNullable<ExecutionTraceConclusion['selectionReconciliation']>['targetResolution'],
      attempts,
      durationMs,
      terminalProof: terminalProof as NonNullable<ExecutionTraceConclusion['selectionReconciliation']>['terminalProof'],
    }];
  });
  const unique = new Map(observed.map((candidate) => [JSON.stringify(candidate), candidate]));
  return unique.size === 1 ? [...unique.values()][0]! : null;
}

function directBoolean(value: unknown, key: string): boolean | null {
  if (!isRecord(value)) return null;
  return typeof value[key] === 'boolean' ? value[key] : null;
}

function phaseDispatchConclusion(telemetry: WorkerCommandTelemetry | null): true | 'unknown' | null {
  const states = telemetry?.actionPhases.map((phase) => phase.dispatchState) ?? [];
  if (states.includes('dispatched')) return true;
  if (states.includes('possibly_dispatched')) return 'unknown';
  return null;
}

function checkSummaries(value: unknown): ExecutionTraceConclusion['checks'] {
  const candidates = valuesForKey(value, 'checks').flatMap((candidate) => (Array.isArray(candidate) ? candidate : []));
  return candidates.slice(0, 20).flatMap((candidate) => {
    if (!isRecord(candidate) || !CHECK_KINDS.has(candidate.kind as PostconditionCheck['kind']) || typeof candidate.passed !== 'boolean') return [];
    const observed =
      typeof candidate.observed === 'string'
        ? ('redacted_string' as const)
        : typeof candidate.observed === 'boolean' || candidate.observed === null
          ? candidate.observed
          : null;
    return [
      {
        kind: candidate.kind as PostconditionCheck['kind'],
        passed: candidate.passed,
        observed,
      },
    ];
  });
}

function postconditionPassed(value: unknown): boolean | null {
  for (const candidate of valuesForKey(value, 'postcondition')) {
    if (isRecord(candidate) && typeof candidate.passed === 'boolean') return candidate.passed;
  }
  return null;
}

function dispatchConclusion(values: unknown[]): boolean | 'unknown' | null {
  if (values.includes(true)) return true;
  if (values.includes('unknown')) return 'unknown';
  return values.includes(false) ? false : null;
}

function booleanConclusion(values: unknown[]): boolean | null {
  if (values.includes(true)) return true;
  return values.includes(false) ? false : null;
}

function enumConclusion<T extends string>(values: unknown[], allowed: Set<T | null>): T | null {
  const observed = new Set(values.filter((value): value is T => typeof value === 'string' && allowed.has(value as T)));
  return observed.size === 1 ? [...observed][0]! : null;
}

function boundedIntegerConclusion(values: unknown[], maximum: number): number | null {
  const observed = new Set(values.filter((value): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maximum));
  return observed.size === 1 ? [...observed][0]! : null;
}

function popupOwnershipConclusion(value: unknown): ExecutionTraceConclusion['popupOwnership'] {
  const observed = valuesForKey(value, 'popupOwnership').flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const proofTier = candidate.proofTier;
    const decision = candidate.decision;
    if (
      typeof proofTier !== 'string' ||
      !POPUP_OWNER_PROOF_TIERS.has(proofTier as NonNullable<ExecutionTraceConclusion['popupOwnership']>['proofTier']) ||
      typeof decision !== 'string' ||
      !POPUP_OWNER_DECISION_STATES.has(decision as NonNullable<ExecutionTraceConclusion['popupOwnership']>['decision'])
    )
      return [];
    const candidateCount = boundedNullableInteger(candidate.candidateCount, 100);
    const exteriorCandidateCount = boundedNullableInteger(candidate.exteriorCandidateCount, 100);
    const overlappingCandidateCount = boundedNullableInteger(candidate.overlappingCandidateCount, 100);
    const surfaceCoveredCandidateCount = boundedNullableInteger(candidate.surfaceCoveredCandidateCount, 100);
    const targetFirstMiss = typeof candidate.targetFirstMiss === 'string' &&
      POPUP_OWNER_TARGET_FIRST_MISSES.has(candidate.targetFirstMiss as PopupOwnerTargetFirstMiss)
      ? candidate.targetFirstMiss as PopupOwnerTargetFirstMiss
      : null;
    if (
      candidateCount === undefined ||
      exteriorCandidateCount === undefined ||
      overlappingCandidateCount === undefined ||
      surfaceCoveredCandidateCount === undefined
    )
      return [];
    return [
      {
        proofTier: proofTier as NonNullable<ExecutionTraceConclusion['popupOwnership']>['proofTier'],
        candidateCount,
        exteriorCandidateCount,
        overlappingCandidateCount,
        surfaceCoveredCandidateCount,
        decision: decision as NonNullable<ExecutionTraceConclusion['popupOwnership']>['decision'],
        ...(targetFirstMiss === null ? {} : { targetFirstMiss }),
      },
    ];
  });
  const unique = new Map(observed.map((candidate) => [JSON.stringify(candidate), candidate]));
  return unique.size === 1 ? [...unique.values()][0]! : null;
}

function controlRecoveryConclusion(value: unknown): ExecutionTraceConclusion['controlRecovery'] {
  const observed = valuesForKey(value, 'controlRecovery').flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const requestedControlResolution = candidate.requestedControlResolution;
    const popupOwnerDecision = candidate.popupOwnerDecision;
    if (
      typeof requestedControlResolution !== 'string' ||
      !REQUESTED_CONTROL_RESOLUTIONS.has(
        requestedControlResolution as NonNullable<ExecutionTraceConclusion['controlRecovery']>['requestedControlResolution'],
      ) ||
      typeof popupOwnerDecision !== 'string' ||
      !POPUP_OWNER_DECISIONS.has(popupOwnerDecision as NonNullable<ExecutionTraceConclusion['controlRecovery']>['popupOwnerDecision'])
    )
      return [];
    const activeCandidateCount = boundedNullableInteger(candidate.activeCandidateCount, 100);
    const exposedCandidateCount = boundedNullableInteger(candidate.exposedCandidateCount, 12);
    const issuedCapabilityCount = boundedNullableInteger(candidate.issuedCapabilityCount, 12);
    const candidatesTruncated = nullableBoolean(candidate.candidatesTruncated);
    const requestedControlIsCandidate = nullableBoolean(candidate.requestedControlIsCandidate);
    const agentJudgmentAvailable = nullableBoolean(candidate.agentJudgmentAvailable);
    if (
      activeCandidateCount === undefined ||
      exposedCandidateCount === undefined ||
      issuedCapabilityCount === undefined ||
      candidatesTruncated === undefined ||
      requestedControlIsCandidate === undefined ||
      agentJudgmentAvailable === undefined
    )
      return [];
    return [
      {
        requestedControlResolution: requestedControlResolution as NonNullable<ExecutionTraceConclusion['controlRecovery']>['requestedControlResolution'],
        popupOwnerDecision: popupOwnerDecision as NonNullable<ExecutionTraceConclusion['controlRecovery']>['popupOwnerDecision'],
        activeCandidateCount,
        exposedCandidateCount,
        issuedCapabilityCount,
        candidatesTruncated,
        requestedControlIsCandidate,
        agentJudgmentAvailable,
      },
    ];
  });
  const unique = new Map(observed.map((candidate) => [JSON.stringify(candidate), candidate]));
  return unique.size === 1 ? [...unique.values()][0]! : null;
}

function targetStateConclusion(value: unknown): ExecutionTraceConclusion['targetState'] {
  const states = valuesForKey(value, 'targetState').filter(isRecord);
  if (states.length === 0) return null;
  return {
    visible: booleanConclusion(states.map((state) => state.visible)),
    enabled: booleanConclusion(states.map((state) => state.enabled)),
    inViewport: booleanConclusion(states.map((state) => state.inViewport)),
    viewportEvidence: enumConclusion(
      states.map((state) => state.viewportEvidence),
      VIEWPORT_EVIDENCE,
    ),
    receivesPointerEvents: booleanConclusion(states.map((state) => state.receivesPointerEvents)),
    pointerHitPoint: enumConclusion(
      states.map((state) => state.pointerHitPoint),
      POINTER_HIT_POINTS,
    ),
  };
}

function phaseDuration(startedAtMs: number, nextAtMs: number | undefined, completedAtMs: number | null): number | null {
  const endedAtMs = nextAtMs ?? completedAtMs;
  return endedAtMs === null || endedAtMs === undefined ? null : Math.max(0, endedAtMs - startedAtMs);
}

function safeReason(value: unknown): string | null {
  return typeof value === 'string' && SAFE_REASON.test(value) ? value : null;
}
