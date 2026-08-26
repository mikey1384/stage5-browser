import { randomUUID } from 'node:crypto';

import type { ViewportPreparationTelemetry } from '../../protocol/telemetry.js';
import { ACTION_PHASES, type ActionDispatchState, type ActionPhase, type ActionPhaseSnapshot, type ActionPhaseTransition, type ActionTerminalOutcome, type DispatchConclusion, type NoDispatchRecovery, type NoDispatchRecoveryReason } from './types.js';

const phaseIndex = (phase: ActionPhase): number => ACTION_PHASES.indexOf(phase);

export class ActionPhaseInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionPhaseInvariantError';
  }
}

export class ActionPhaseSession {
  readonly actionId: string;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  private currentPhase: ActionPhase | null = null;
  private readonly transitions: ActionPhaseTransition[] = [];
  private dispatchState: ActionDispatchState = 'not_attempted';
  private dispatchAttempts = 0;
  private recovery: NoDispatchRecovery | null = null;
  private viewportPreparation: ViewportPreparationTelemetry | null = null;
  private terminalOutcome: ActionTerminalOutcome | null = null;
  private completedAtMs: number | null = null;

  constructor(
    readonly action: string,
    timeoutMs: number,
    private readonly now: () => number = Date.now,
    actionId = randomUUID(),
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new ActionPhaseInvariantError('An action phase session requires a positive timeout.');
    }
    this.actionId = actionId;
    this.startedAtMs = now();
    this.deadlineAtMs = this.startedAtMs + timeoutMs;
  }

  enter(phase: Exclude<ActionPhase, 'dispatch' | 'finalize'>): void {
    this.assertActive();
    const expected = this.expectedNextPhase();
    if (phase !== expected) {
      throw new ActionPhaseInvariantError(
        `Cannot enter ${phase}; the next action phase is ${expected ?? 'terminal'}.`,
      );
    }
    this.recordTransition(phase);
  }

  beginDispatch(): void {
    this.assertActive();
    if (this.currentPhase !== 'prepare') {
      throw new ActionPhaseInvariantError('Dispatch requires completed preparation.');
    }
    if (this.dispatchState !== 'not_attempted') {
      throw new ActionPhaseInvariantError('The dispatch gate cannot be entered after possible input.');
    }
    this.dispatchAttempts += 1;
    this.recordTransition('dispatch');
  }

  concludeDispatch(conclusion: DispatchConclusion): void {
    this.assertActive();
    if (this.currentPhase !== 'dispatch') {
      throw new ActionPhaseInvariantError('Dispatch evidence can only be recorded in the dispatch phase.');
    }
    this.dispatchState = conclusion.actionDispatched === true
      ? 'dispatched'
      : conclusion.actionDispatched === false
        ? 'not_dispatched'
        : 'possibly_dispatched';
  }

  recoverBeforeDispatch(reason: NoDispatchRecoveryReason): void {
    this.assertActive();
    if (this.currentPhase !== 'dispatch' || this.dispatchState !== 'not_dispatched') {
      throw new ActionPhaseInvariantError(
        'Pre-dispatch recovery requires authoritative proof that no input was dispatched.',
      );
    }
    if (this.recovery !== null) {
      throw new ActionPhaseInvariantError('Only one bounded pre-dispatch recovery is permitted.');
    }
    this.recovery = {
      reason,
      authorizedAtMs: this.now(),
      completedDispatchAttempts: this.dispatchAttempts,
    };
    this.dispatchState = 'not_attempted';
    this.currentPhase = 'plan';
  }

  beginFinalization(): void {
    this.assertActive();
    if (this.currentPhase === 'finalize') return;
    this.recordTransition('finalize');
  }

  recordViewportPreparation(evidence: ViewportPreparationTelemetry): void {
    this.assertActive();
    if (this.currentPhase !== 'prepare') {
      throw new ActionPhaseInvariantError('Viewport preparation evidence belongs to the prepare phase.');
    }
    const prior = this.viewportPreparation;
    this.viewportPreparation = prior === null ? { ...evidence } : {
      attempts: prior.attempts + evidence.attempts,
      movements: prior.movements + evidence.movements,
      horizontalMovement: prior.horizontalMovement || evidence.horizontalMovement,
      verticalMovement: prior.verticalMovement || evidence.verticalMovement,
      nestedSurfaceMovement: prior.nestedSurfaceMovement || evidence.nestedSurfaceMovement,
      documentMovement: prior.documentMovement || evidence.documentMovement,
      composedBoundaryTraversed: prior.composedBoundaryTraversed || evidence.composedBoundaryTraversed,
      completedInViewport: evidence.completedInViewport,
    };
  }

  complete(outcome: ActionTerminalOutcome): void {
    this.assertActive();
    if (this.currentPhase !== 'finalize') {
      throw new ActionPhaseInvariantError('An action must enter finalization before completing.');
    }
    this.terminalOutcome = outcome;
    this.completedAtMs = this.now();
  }

  ensureFailed(): void {
    if (this.terminalOutcome !== null) return;
    this.beginFinalization();
    this.complete('failed');
  }

  remainingMs(): number {
    return Math.max(0, this.deadlineAtMs - this.now());
  }

  snapshot(): ActionPhaseSnapshot {
    return {
      actionId: this.actionId,
      action: this.action,
      startedAtMs: this.startedAtMs,
      deadlineAtMs: this.deadlineAtMs,
      currentPhase: this.currentPhase,
      transitions: this.transitions.map((transition) => ({ ...transition })),
      dispatchState: this.dispatchState,
      dispatchAttempts: this.dispatchAttempts,
      recovery: this.recovery === null ? null : { ...this.recovery },
      viewportPreparation: this.viewportPreparation === null ? null : { ...this.viewportPreparation },
      terminalOutcome: this.terminalOutcome,
      completedAtMs: this.completedAtMs,
    };
  }

  private expectedNextPhase(): Exclude<ActionPhase, 'dispatch' | 'finalize'> | null {
    if (this.currentPhase === null) return 'observe';
    if (this.currentPhase === 'observe') return 'plan';
    if (this.currentPhase === 'plan') return 'preflight';
    if (this.currentPhase === 'preflight') return 'prepare';
    if (this.currentPhase === 'dispatch') return 'reconcile';
    return null;
  }

  private recordTransition(phase: ActionPhase): void {
    if (this.currentPhase === 'finalize') {
      throw new ActionPhaseInvariantError('No action phase can follow finalization.');
    }
    if (
      phase !== 'finalize' &&
      this.currentPhase !== null &&
      phaseIndex(phase) <= phaseIndex(this.currentPhase)
    ) {
      throw new ActionPhaseInvariantError(`The ${phase} phase would move the action backwards.`);
    }
    this.currentPhase = phase;
    this.transitions.push({
      phase,
      enteredAtMs: this.now(),
      attempt: phase === 'prepare' || phase === 'dispatch' ? this.dispatchAttempts + (phase === 'prepare' ? 1 : 0) : 1,
    });
  }

  private assertActive(): void {
    if (this.terminalOutcome !== null) {
      throw new ActionPhaseInvariantError('The action phase session is already complete.');
    }
  }
}
