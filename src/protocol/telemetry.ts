import type { BrowserCommandName } from './commands.js';
import type { BrowserActionManager, BrowserCommandContract, BrowserPhaseSystem } from './command-contracts.js';
import type {
  ControlPopupAssociationProof,
  ControlPopupOwnershipEvidence,
  ControlPopupSurfaceProof,
  ControlRecoveryEvidence,
  ControlSelectionReconciliationEvidence,
  PostconditionCheck,
} from './controls.js';
import type { NativeReattachObservation } from './browser-state.js';

export interface ViewportPreparationTelemetry {
  attempts: number;
  movements: number;
  horizontalMovement: boolean;
  verticalMovement: boolean;
  nestedSurfaceMovement: boolean;
  documentMovement: boolean;
  composedBoundaryTraversed: boolean;
  pointerContactRecovery: boolean;
  completedInViewport: boolean;
  reachStrategy: 'pointer_viewport' | 'postconditioned_keyboard';
}

export interface WorkerActionPhaseTelemetry {
  action: string;
  startedAtMs: number;
  deadlineAtMs: number;
  transitions: Array<{
    phase: 'observe' | 'plan' | 'preflight' | 'prepare' | 'dispatch' | 'reconcile' | 'finalize';
    enteredAtMs: number;
    attempt: number;
  }>;
  dispatchState: 'not_attempted' | 'not_dispatched' | 'possibly_dispatched' | 'dispatched';
  dispatchAttempts: number;
  recovery: {
    reason: 'activation_lost_before_input' | 'target_changed_before_input' | 'transient_observation_miss';
    authorizedAtMs: number;
    completedDispatchAttempts: number;
  } | null;
  viewportPreparation?: ViewportPreparationTelemetry | null;
  terminalOutcome: 'failed' | 'succeeded' | null;
  completedAtMs: number | null;
}

export interface WorkerCommandTelemetry {
  actionPhases: WorkerActionPhaseTelemetry[];
}

export interface ExecutionActionTrace {
  action: string;
  durationMs: number | null;
  dispatchState: WorkerActionPhaseTelemetry['dispatchState'];
  dispatchAttempts: number;
  recoveryReason: NonNullable<WorkerActionPhaseTelemetry['recovery']>['reason'] | null;
  viewportPreparation: ViewportPreparationTelemetry | null;
  terminalOutcome: WorkerActionPhaseTelemetry['terminalOutcome'];
  phases: Array<{
    phase: WorkerActionPhaseTelemetry['transitions'][number]['phase'];
    attempt: number;
    offsetMs: number;
    durationMs: number | null;
  }>;
}

export interface ExecutionTraceConclusion {
  actionDispatched: boolean | 'unknown' | null;
  clickDispatched: boolean | 'unknown' | null;
  postconditionPassed: boolean | null;
  checks: Array<{
    kind: PostconditionCheck['kind'];
    passed: boolean;
    observed: boolean | null | 'redacted_string';
  }>;
  selectionDesiredState: boolean | null;
  selectionObservedState: boolean | null;
  selectionEffectObserved: boolean | null;
  selectedRepresentationObserved: boolean | null;
  popupClosed: boolean | null;
  popupAssociationProof: ControlPopupAssociationProof | null;
  popupSurfaceProof: ControlPopupSurfaceProof | null;
  renderedPopupCount: number | null;
  popupOwnership: ControlPopupOwnershipEvidence | null;
  controlRecovery: ControlRecoveryEvidence | null;
  selectionReconciliation: ControlSelectionReconciliationEvidence | null;
  profileOwnership: {
    classification:
      | 'abandoned'
      | 'authentication_handoff_pending'
      | 'busy_other_stage5_session'
      | 'controlled'
      | 'current_owner'
      | 'dedicated_browser_control_unavailable'
      | 'external_owner'
      | 'invalid'
      | 'none'
      | 'owned_active'
      | 'owned_orphaned'
      | 'owner_process_unavailable'
      | 'reconnectable_stage5_browser'
      | 'unknown_lock_owner';
    ownership: 'none' | 'not_proven' | 'proven' | null;
    lockOwnerProcess: 'none' | 'not_running_or_unreadable' | 'running' | null;
    applicationIdentity: 'matched' | 'mismatched' | 'unverified' | null;
    loopbackControl: 'absent' | 'ambiguous' | 'available' | 'unverified' | null;
    recovery:
      | 'automatic_reattach'
      | 'automatic_owned_restart'
      | 'close_dedicated_browser_normally'
      | 'do_not_modify_locks'
      | 'none'
      | 'return_to_authentication_handoff'
      | null;
    ownerWorkerRunning: boolean | null;
    heartbeat: 'fresh' | 'stale' | 'unavailable' | null;
    browserProcess: 'matched' | 'mismatched' | 'not_running' | 'unavailable' | null;
    controlMode: 'human_handoff' | 'native_cdp' | 'playwright' | null;
    phase: 'close_requested' | 'human_input' | 'launching' | 'owned_active' | 'process_exited' | 'profile_unlocked' | null;
  } | null;
  handoffRelease: {
    strategy: 'native_same_process' | 'process_relaunch';
    phase: 'close_requested' | 'process_exited' | 'profile_unlocked' | 'human_input';
    closeRequestCompleted: boolean | null;
    processReused: boolean | null;
    ownershipRetained: boolean | null;
  } | null;
  nativeReattach: NativeReattachObservation | null;
  targetState: {
    visible: boolean | null;
    enabled: boolean | null;
    inViewport: boolean | null;
    viewportEvidence: 'clipped_geometry' | 'exact_hit_test_override' | 'none' | null;
    receivesPointerEvents: boolean | null;
    pointerHitPoint: 'center' | 'alternate' | null;
  } | null;
}

export interface ExecutionActionTraceSummary {
  action: string;
  durationMs: number | null;
  dispatchState: WorkerActionPhaseTelemetry['dispatchState'];
  dispatchAttempts: number;
  recoveryReason: NonNullable<WorkerActionPhaseTelemetry['recovery']>['reason'] | null;
  terminalOutcome: WorkerActionPhaseTelemetry['terminalOutcome'];
  phaseMs: Partial<Record<WorkerActionPhaseTelemetry['transitions'][number]['phase'], number | null>>;
}

export interface BrowserExecutionTraceSummary {
  traceId: string;
  recordedAtMs: number;
  operationId: string;
  agentId: string | null;
  command: BrowserCommandName | 'recover';
  manager: BrowserActionManager | 'recovery_manager';
  durationMs: number;
  outcome: BrowserExecutionTrace['outcome'];
  errorCode: string | null;
  reason: string | null;
  actions: ExecutionActionTraceSummary[];
  conclusion: Partial<ExecutionTraceConclusion>;
}

export interface BrowserExecutionTrace {
  schemaVersion: 1 | 2;
  traceId: string;
  recordedAtMs: number;
  operationId: string;
  agentId: string | null;
  command: BrowserCommandName | 'recover';
  manager: BrowserActionManager | 'recovery_manager';
  phaseSystem: BrowserPhaseSystem;
  dispatchBoundary: BrowserCommandContract['dispatch'];
  replayPolicy: BrowserCommandContract['replay'];
  host: {
    version: string | null;
    behaviorVersion: number | null;
    toolCatalogVersion: number | null;
    toolCount: number | null;
  };
  worker: { version: string | null; protocolVersion: number | null };
  startedAt: string;
  completedAt: string;
  durationMs: number;
  outcome: 'succeeded' | 'failed' | 'timed_out';
  errorCode: string | null;
  reason: string | null;
  actions: ExecutionActionTrace[];
  conclusion: ExecutionTraceConclusion;
  privacy: {
    urls: 'omitted';
    selectors: 'omitted';
    names: 'omitted';
    values: 'omitted';
    pageContent: 'omitted';
  };
}

export interface ExecutionTraceList {
  traces: Array<BrowserExecutionTrace | BrowserExecutionTraceSummary>;
  limit: number;
  operationId: string | null;
  agentId: string | null;
  command: BrowserCommandName | 'recover' | null;
  outcome: BrowserExecutionTrace['outcome'] | null;
  detail: 'summary' | 'full';
  privacy: BrowserExecutionTrace['privacy'];
}
