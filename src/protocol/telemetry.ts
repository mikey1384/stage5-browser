import type { BrowserCommandName } from './commands.js';
import type { BrowserActionManager, BrowserCommandContract, BrowserPhaseSystem } from './command-contracts.js';
import type { ControlPopupAssociationProof, ControlPopupOwnershipEvidence, ControlPopupSurfaceProof, PostconditionCheck } from './controls.js';

export interface ViewportPreparationTelemetry {
  attempts: number;
  movements: number;
  horizontalMovement: boolean;
  verticalMovement: boolean;
  nestedSurfaceMovement: boolean;
  documentMovement: boolean;
  composedBoundaryTraversed: boolean;
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
  targetState: {
    visible: boolean | null;
    enabled: boolean | null;
    inViewport: boolean | null;
    viewportEvidence: 'clipped_geometry' | 'exact_hit_test_override' | 'none' | null;
    receivesPointerEvents: boolean | null;
    pointerHitPoint: 'center' | 'alternate' | null;
  } | null;
}

export interface BrowserExecutionTrace {
  schemaVersion: 1;
  traceId: string;
  recordedAtMs: number;
  operationId: string;
  agentId: string | null;
  command: BrowserCommandName | 'recover';
  manager: BrowserActionManager | 'recovery_manager';
  phaseSystem: BrowserPhaseSystem;
  dispatchBoundary: BrowserCommandContract['dispatch'];
  replayPolicy: BrowserCommandContract['replay'];
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
  traces: BrowserExecutionTrace[];
  limit: number;
  operationId: string | null;
  privacy: BrowserExecutionTrace['privacy'];
}
