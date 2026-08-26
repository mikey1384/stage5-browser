import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { browserCommandContract, type BrowserCommandName, type BrowserExecutionTrace, type ExecutionTraceConclusion, type ExecutionTraceList, type PostconditionCheck, type RuntimeProcessInfo, type SerializedStage5BrowserError, type WorkerCommandTelemetry } from './execution-telemetry-dependencies.js';

const MAX_TELEMETRY_BYTES = 4 * 1_024 * 1_024;
const RETAINED_TELEMETRY_BYTES = 2 * 1_024 * 1_024;
const SAFE_REASON = /^[a-z][a-z0-9_]{0,99}$/u;
const CHECK_KINDS = new Set<PostconditionCheck['kind']>([
  'download',
  'new_page_url',
  'popup_closed',
  'selected',
  'selection_representation',
  'url',
  'visible',
]);

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
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      this.initialized = true;
    }
    await this.compactIfNeeded();
    await appendFile(this.filePath, `${JSON.stringify(trace)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(this.filePath, 0o600);
  }

  async list(operationId: string | null, limit: number): Promise<ExecutionTraceList> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { traces: [], limit, operationId, privacy: privacyContract() };
      }
      throw error;
    }
    const traces = contents.trimEnd().split('\n').flatMap((line) => {
      try {
        const trace = JSON.parse(line) as Partial<BrowserExecutionTrace>;
        return trace.schemaVersion === 1 && typeof trace.operationId === 'string'
          ? [trace as BrowserExecutionTrace]
          : [];
      } catch {
        return [];
      }
    }).filter((trace) => operationId === null || trace.operationId === operationId);
    return { traces: traces.slice(-limit), limit, operationId, privacy: privacyContract() };
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
  const contract = input.command === 'recover'
    ? {
      manager: 'recovery_manager' as const,
      phaseSystem: 'supervisor_recovery' as const,
      dispatch: 'lifecycle_transition' as const,
      replay: 'supervisor_only' as const,
    }
    : browserCommandContract(input.command);
  return {
    schemaVersion: 1,
    traceId: randomUUID(),
    recordedAtMs: Date.now(),
    operationId: input.operationId,
    agentId: input.agentId,
    command: input.command,
    manager: contract.manager,
    phaseSystem: contract.phaseSystem,
    dispatchBoundary: contract.dispatch,
    replayPolicy: contract.replay,
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
    conclusion: conclusionFrom(input.result, input.error),
    privacy: privacyContract(),
  };
}

function conclusionFrom(result: unknown, error: SerializedStage5BrowserError | null): ExecutionTraceConclusion {
  const combined = { result, error };
  const checks = checkSummaries(combined);
  return {
    actionDispatched: dispatchConclusion(valuesForKey(combined, 'actionDispatched')),
    clickDispatched: dispatchConclusion(valuesForKey(combined, 'clickDispatched')),
    postconditionPassed: postconditionPassed(combined),
    checks,
    selectionEffectObserved: booleanConclusion(valuesForKey(combined, 'selectionEffectObserved')),
    selectedRepresentationObserved: booleanConclusion(valuesForKey(combined, 'selectedRepresentationObserved')),
    popupClosed: booleanConclusion(valuesForKey(combined, 'popupClosed')),
  };
}

function checkSummaries(value: unknown): ExecutionTraceConclusion['checks'] {
  const candidates = valuesForKey(value, 'checks').flatMap((candidate) =>
    Array.isArray(candidate) ? candidate : []);
  return candidates.slice(0, 20).flatMap((candidate) => {
    if (!isRecord(candidate) || !CHECK_KINDS.has(candidate.kind as PostconditionCheck['kind']) || typeof candidate.passed !== 'boolean') return [];
    const observed = typeof candidate.observed === 'string'
      ? 'redacted_string' as const
      : typeof candidate.observed === 'boolean' || candidate.observed === null
        ? candidate.observed
        : null;
    return [{ kind: candidate.kind as PostconditionCheck['kind'], passed: candidate.passed, observed }];
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

function valuesForKey(value: unknown, key: string, depth = 0, ancestors = new WeakSet<object>()): unknown[] {
  if (depth > 8 || value === null || typeof value !== 'object' || ancestors.has(value)) return [];
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.flatMap((candidate) => valuesForKey(candidate, key, depth + 1, ancestors));
    const record = value as Record<string, unknown>;
    return [
      ...(record[key] === undefined ? [] : [record[key]]),
      ...Object.values(record).flatMap((candidate) => valuesForKey(candidate, key, depth + 1, ancestors)),
    ];
  } finally {
    ancestors.delete(value);
  }
}

function phaseDuration(startedAtMs: number, nextAtMs: number | undefined, completedAtMs: number | null): number | null {
  const endedAtMs = nextAtMs ?? completedAtMs;
  return endedAtMs === null || endedAtMs === undefined ? null : Math.max(0, endedAtMs - startedAtMs);
}

function safeReason(value: unknown): string | null {
  return typeof value === 'string' && SAFE_REASON.test(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function privacyContract(): BrowserExecutionTrace['privacy'] {
  return { urls: 'omitted', selectors: 'omitted', names: 'omitted', values: 'omitted', pageContent: 'omitted' };
}
