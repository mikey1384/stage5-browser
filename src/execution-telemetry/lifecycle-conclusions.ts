import type {
  ExecutionTraceConclusion,
  SerializedStage5BrowserError,
} from '../execution-telemetry-dependencies.js';

const HANDOFF_RELEASE_STRATEGIES = new Set<NonNullable<ExecutionTraceConclusion['handoffRelease']>['strategy']>([
  'native_same_process',
  'process_relaunch',
]);
const HANDOFF_RELEASE_PHASES = new Set<NonNullable<ExecutionTraceConclusion['handoffRelease']>['phase']>([
  'close_requested',
  'process_exited',
  'profile_unlocked',
  'human_input',
]);
const NATIVE_REATTACH_RESOLUTIONS = new Set<NonNullable<ExecutionTraceConclusion['nativeReattach']>['resolution']>([
  'not_recorded',
  'initial_exact',
  'settled_exact',
  'unresolved',
]);

export function handoffReleaseConclusion(
  result: unknown,
  error: SerializedStage5BrowserError | null,
): ExecutionTraceConclusion['handoffRelease'] {
  const direct = isRecord(result) && isRecord(result.handoffRelease)
    ? result.handoffRelease
    : error?.details;
  if (!isRecord(direct)) return null;
  const strategy = direct.strategy ?? direct.releaseStrategy;
  const phase = direct.phase;
  if (
    typeof strategy !== 'string'
    || !HANDOFF_RELEASE_STRATEGIES.has(strategy as NonNullable<ExecutionTraceConclusion['handoffRelease']>['strategy'])
    || typeof phase !== 'string'
    || !HANDOFF_RELEASE_PHASES.has(phase as NonNullable<ExecutionTraceConclusion['handoffRelease']>['phase'])
  ) return null;
  return {
    strategy: strategy as NonNullable<ExecutionTraceConclusion['handoffRelease']>['strategy'],
    phase: phase as NonNullable<ExecutionTraceConclusion['handoffRelease']>['phase'],
    closeRequestCompleted: nullableBoolean(direct.closeRequestCompleted) ?? null,
    processReused: nullableBoolean(direct.processReused) ?? null,
    ownershipRetained: nullableBoolean(direct.ownershipRetained) ?? null,
  };
}

export function nativeReattachConclusion(
  result: unknown,
  error: SerializedStage5BrowserError | null,
): ExecutionTraceConclusion['nativeReattach'] {
  const direct = isRecord(result) && isRecord(result.nativeReattach)
    ? result.nativeReattach
    : isRecord(error?.details?.nativeReattach)
      ? error.details.nativeReattach
      : null;
  if (direct === null) return null;
  const resolution = direct.resolution;
  if (
    typeof direct.selectedTargetRecorded !== 'boolean'
    || !boundedInteger(direct.initialPageCount, 100)
    || !boundedInteger(direct.finalPageCount, 100)
    || nullableBoolean(direct.selectedTargetInitiallyObserved) === undefined
    || nullableBoolean(direct.selectedTargetObserved) === undefined
    || typeof direct.discoveryWaitAttempted !== 'boolean'
    || !boundedInteger(direct.discoveryWaitMs, 1_000)
    || typeof resolution !== 'string'
    || !NATIVE_REATTACH_RESOLUTIONS.has(
      resolution as NonNullable<ExecutionTraceConclusion['nativeReattach']>['resolution'],
    )
  ) return null;
  return {
    selectedTargetRecorded: direct.selectedTargetRecorded,
    initialPageCount: direct.initialPageCount as number,
    finalPageCount: direct.finalPageCount as number,
    selectedTargetInitiallyObserved: direct.selectedTargetInitiallyObserved as boolean | null,
    selectedTargetObserved: direct.selectedTargetObserved as boolean | null,
    discoveryWaitAttempted: direct.discoveryWaitAttempted,
    discoveryWaitMs: direct.discoveryWaitMs as number,
    resolution: resolution as NonNullable<ExecutionTraceConclusion['nativeReattach']>['resolution'],
  };
}

function boundedInteger(value: unknown, maximum: number): boolean {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function nullableBoolean(value: unknown): boolean | null | undefined {
  return value === null || typeof value === 'boolean' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
