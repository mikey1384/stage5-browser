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
const PROFILE_CLASSIFICATIONS = new Set<NonNullable<ExecutionTraceConclusion['profileOwnership']>['classification']>([
  'abandoned',
  'authentication_handoff_pending',
  'busy_other_stage5_session',
  'controlled',
  'current_owner',
  'dedicated_browser_control_unavailable',
  'external_owner',
  'invalid',
  'none',
  'owned_active',
  'owned_orphaned',
  'owner_process_unavailable',
  'reconnectable_stage5_browser',
  'unknown_lock_owner',
]);
const PROFILE_OWNERSHIPS = new Set<NonNullable<NonNullable<ExecutionTraceConclusion['profileOwnership']>['ownership']>>([
  'none',
  'not_proven',
  'proven',
]);

export function profileOwnershipConclusion(
  result: unknown,
  error: SerializedStage5BrowserError | null,
): ExecutionTraceConclusion['profileOwnership'] {
  const direct = isRecord(result) && isRecord(result.profileOwner)
    ? result.profileOwner
    : isRecord(error?.details?.profileOwner)
      ? error.details.profileOwner
      : null;
  if (direct === null || !member(direct.classification, PROFILE_CLASSIFICATIONS)) return null;
  const lease = isRecord(direct.lease) ? direct.lease : null;
  const ownership = member(direct.ownership, PROFILE_OWNERSHIPS)
    ? direct.ownership
    : typeof direct.ownershipProven === 'boolean'
      ? direct.ownershipProven ? 'proven' : 'not_proven'
      : null;
  return {
    classification: direct.classification,
    ownership,
    lockOwnerProcess: enumValue(direct.lockOwnerProcess, ['none', 'not_running_or_unreadable', 'running']),
    applicationIdentity: enumValue(direct.applicationIdentity, ['matched', 'mismatched', 'unverified']),
    loopbackControl: enumValue(direct.loopbackControl, ['absent', 'ambiguous', 'available', 'unverified']),
    recovery: enumValue(direct.recovery, [
      'automatic_reattach', 'automatic_owned_restart', 'close_dedicated_browser_normally',
      'do_not_modify_locks', 'none', 'return_to_authentication_handoff',
    ]),
    ownerWorkerRunning: nullableBoolean(direct.ownerWorkerRunning ?? lease?.ownerWorkerRunning) ?? null,
    heartbeat: enumValue(direct.heartbeat ?? lease?.heartbeat, ['fresh', 'stale', 'unavailable']),
    browserProcess: enumValue(direct.browserProcess ?? lease?.browserProcess, [
      'matched', 'mismatched', 'not_running', 'unavailable',
    ]),
    controlMode: enumValue(direct.controlMode ?? lease?.controlMode, [
      'human_handoff', 'native_cdp', 'playwright',
    ]),
    phase: enumValue(direct.phase ?? lease?.phase, [
      'close_requested', 'human_input', 'launching', 'owned_active', 'process_exited', 'profile_unlocked',
    ]),
  };
}

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

function member<Value extends string>(value: unknown, allowed: ReadonlySet<Value>): value is Value {
  return typeof value === 'string' && allowed.has(value as Value);
}

function enumValue<const Value extends string>(value: unknown, allowed: readonly Value[]): Value | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? value as Value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
