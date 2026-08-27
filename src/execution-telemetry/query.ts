import type {
  BrowserCommandName,
  BrowserExecutionTrace,
  BrowserExecutionTraceSummary,
  ExecutionTraceConclusion,
} from '../execution-telemetry-dependencies.js';

export interface ExecutionTraceFilters {
  agentId?: string | null;
  command?: BrowserCommandName | 'recover' | null;
  outcome?: BrowserExecutionTrace['outcome'] | null;
  detail?: 'summary' | 'full';
}

export function normalizeTrace(trace: Partial<BrowserExecutionTrace>): BrowserExecutionTrace {
  const conclusion: Record<string, unknown> = isRecord(trace.conclusion) ? trace.conclusion : {};
  const host: Record<string, unknown> = isRecord(trace.host) ? trace.host : {};
  return {
    ...trace,
    host: {
      version: typeof host.version === 'string' ? host.version : null,
      behaviorVersion: typeof host.behaviorVersion === 'number' ? host.behaviorVersion : null,
      toolCatalogVersion: typeof host.toolCatalogVersion === 'number' ? host.toolCatalogVersion : null,
      toolCount: typeof host.toolCount === 'number' ? host.toolCount : null,
    },
    conclusion: {
      ...conclusion,
      activationTransport: typeof conclusion.activationTransport === 'string' ? conclusion.activationTransport : null,
      controlRecovery: isRecord(conclusion.controlRecovery) ? conclusion.controlRecovery : null,
      controlRevealInteraction: typeof conclusion.controlRevealInteraction === 'string'
        ? conclusion.controlRevealInteraction
        : null,
      selectionReconciliation: isRecord(conclusion.selectionReconciliation) ? conclusion.selectionReconciliation : null,
      selectionInteraction: typeof conclusion.selectionInteraction === 'string' ? conclusion.selectionInteraction : null,
      searchableSelection: isRecord(conclusion.searchableSelection) ? conclusion.searchableSelection : null,
      formFieldRebinding: isRecord(conclusion.formFieldRebinding) ? conclusion.formFieldRebinding : null,
      profileOwnership: isRecord(conclusion.profileOwnership) ? conclusion.profileOwnership : null,
      handoffRelease: isRecord(conclusion.handoffRelease) ? conclusion.handoffRelease : null,
      nativeReattach: isRecord(conclusion.nativeReattach) ? conclusion.nativeReattach : null,
    },
  } as BrowserExecutionTrace;
}

export function summarizeTrace(trace: BrowserExecutionTrace): BrowserExecutionTraceSummary {
  const conclusion = Object.fromEntries(
    Object.entries(trace.conclusion).filter(([, value]) =>
      value !== null && !(Array.isArray(value) && value.length === 0)),
  ) as Partial<ExecutionTraceConclusion>;
  return {
    traceId: trace.traceId,
    recordedAtMs: trace.recordedAtMs,
    operationId: trace.operationId,
    agentId: trace.agentId,
    command: trace.command,
    manager: trace.manager,
    durationMs: trace.durationMs,
    outcome: trace.outcome,
    errorCode: trace.errorCode,
    reason: trace.reason,
    actions: trace.actions.map((action) => ({
      action: action.action,
      durationMs: action.durationMs,
      dispatchState: action.dispatchState,
      dispatchAttempts: action.dispatchAttempts,
      recoveryReason: action.recoveryReason,
      terminalOutcome: action.terminalOutcome,
      phaseMs: Object.fromEntries(action.phases.map(({ phase, durationMs }) => [phase, durationMs])),
    })),
    conclusion,
  };
}

export function privacyContract(): BrowserExecutionTrace['privacy'] {
  return {
    urls: 'omitted',
    selectors: 'omitted',
    names: 'omitted',
    values: 'omitted',
    pageContent: 'omitted',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
