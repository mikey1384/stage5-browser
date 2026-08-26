export const ACTION_PHASES = [
  'observe',
  'plan',
  'preflight',
  'prepare',
  'dispatch',
  'reconcile',
  'finalize',
] as const;

export type ActionPhase = (typeof ACTION_PHASES)[number];

export type ActionDispatchState =
  | 'not_attempted'
  | 'not_dispatched'
  | 'possibly_dispatched'
  | 'dispatched';

export type ActionTerminalOutcome = 'failed' | 'succeeded';

export type NoDispatchRecoveryReason =
  | 'activation_lost_before_input'
  | 'target_changed_before_input'
  | 'transient_observation_miss';

export interface ActionPhaseTransition {
  phase: ActionPhase;
  enteredAtMs: number;
  attempt: number;
}

export interface NoDispatchRecovery {
  reason: NoDispatchRecoveryReason;
  authorizedAtMs: number;
  completedDispatchAttempts: number;
}

export interface ActionPhaseSnapshot {
  actionId: string;
  action: string;
  startedAtMs: number;
  deadlineAtMs: number;
  currentPhase: ActionPhase | null;
  transitions: readonly ActionPhaseTransition[];
  dispatchState: ActionDispatchState;
  dispatchAttempts: number;
  recovery: NoDispatchRecovery | null;
  terminalOutcome: ActionTerminalOutcome | null;
  completedAtMs: number | null;
}

export interface DispatchConclusion {
  actionDispatched: boolean | 'unknown';
}
