import { describe, expect, it } from 'vitest';

import { ActionPhaseInvariantError, ActionPhaseSession } from '../src/controller/action/phase-session.js';
import { ActionPhaseManager } from '../src/controller/action/phase-manager.js';

function advanceToPreparation(session: ActionPhaseSession): void {
  session.enter('observe');
  session.enter('plan');
  session.enter('preflight');
  session.enter('prepare');
}

describe('ActionPhaseManager', () => {
  it('enforces the complete phase order around one dispatch gate', () => {
    let now = 10;
    const session = new ActionPhaseSession('click', 1_000, () => now++);
    advanceToPreparation(session);
    session.beginDispatch();
    session.concludeDispatch({ actionDispatched: true });
    session.enter('reconcile');
    session.beginFinalization();
    session.complete('succeeded');

    expect(session.snapshot()).toMatchObject({
      dispatchState: 'dispatched',
      dispatchAttempts: 1,
      terminalOutcome: 'succeeded',
    });
    expect(session.snapshot().transitions.map(({ phase }) => phase)).toEqual([
      'observe', 'plan', 'preflight', 'prepare', 'dispatch', 'reconcile', 'finalize',
    ]);
  });

  it('allows one recovery only after authoritative no-dispatch evidence', () => {
    const session = new ActionPhaseSession('click', 1_000);
    advanceToPreparation(session);
    session.beginDispatch();
    session.concludeDispatch({ actionDispatched: false });
    session.recoverBeforeDispatch('activation_lost_before_input');
    session.enter('preflight');
    session.enter('prepare');
    session.beginDispatch();
    session.concludeDispatch({ actionDispatched: true });
    session.enter('reconcile');
    session.beginFinalization();
    session.complete('succeeded');

    expect(session.snapshot()).toMatchObject({
      dispatchAttempts: 2,
      dispatchState: 'dispatched',
      recovery: { reason: 'activation_lost_before_input', completedDispatchAttempts: 1 },
    });
  });

  it('records one read-only recovery before the first dispatch attempt', () => {
    const session = new ActionPhaseSession('select_option', 1_000);
    session.enter('observe');
    session.enter('plan');
    session.recordPreDispatchRecovery('target_changed_before_input');
    session.enter('preflight');
    session.enter('prepare');
    session.beginDispatch();
    session.concludeDispatch({ actionDispatched: true });
    session.enter('reconcile');
    session.beginFinalization();
    session.complete('succeeded');

    expect(session.snapshot()).toMatchObject({
      dispatchAttempts: 1,
      dispatchState: 'dispatched',
      recovery: { reason: 'target_changed_before_input', completedDispatchAttempts: 0 },
    });
  });

  it('blocks recovery after possible input and blocks a second recovery', () => {
    const possible = new ActionPhaseSession('click', 1_000);
    advanceToPreparation(possible);
    possible.beginDispatch();
    possible.concludeDispatch({ actionDispatched: 'unknown' });
    expect(() => possible.recoverBeforeDispatch('activation_lost_before_input'))
      .toThrow(ActionPhaseInvariantError);

    const repeated = new ActionPhaseSession('click', 1_000);
    advanceToPreparation(repeated);
    repeated.beginDispatch();
    repeated.concludeDispatch({ actionDispatched: false });
    repeated.recoverBeforeDispatch('activation_lost_before_input');
    repeated.enter('preflight');
    repeated.enter('prepare');
    repeated.beginDispatch();
    repeated.concludeDispatch({ actionDispatched: false });
    expect(() => repeated.recoverBeforeDispatch('activation_lost_before_input'))
      .toThrow(ActionPhaseInvariantError);
  });

  it('requires preparation before dispatch and finalization before completion', () => {
    const session = new ActionPhaseSession('fill', 1_000);
    expect(() => session.beginDispatch()).toThrow(ActionPhaseInvariantError);
    session.enter('observe');
    expect(() => session.complete('failed')).toThrow(ActionPhaseInvariantError);
    session.ensureFailed();
    expect(session.snapshot().terminalOutcome).toBe('failed');
  });

  it('keeps sessions scoped to their owning manager', () => {
    const manager = new ActionPhaseManager();
    const session = manager.begin('scroll', 1_000);
    expect(manager.activeCount).toBe(1);
    session.ensureFailed();
    manager.finish(session);
    expect(manager.activeCount).toBe(0);
    expect(() => manager.finish(session)).toThrow(ActionPhaseInvariantError);
  });

  it('drains completed phase evidence exactly once for command telemetry', () => {
    const manager = new ActionPhaseManager();
    const session = manager.begin('select_option', 1_000);
    advanceToPreparation(session);
    session.beginDispatch();
    session.concludeDispatch({ actionDispatched: true });
    session.enter('reconcile');
    session.beginFinalization();
    session.complete('succeeded');
    manager.finish(session);

    expect(manager.drainCompleted()).toEqual([
      expect.objectContaining({ action: 'select_option', dispatchState: 'dispatched', terminalOutcome: 'succeeded' }),
    ]);
    expect(manager.drainCompleted()).toEqual([]);
  });

  it('snapshots an in-flight dispatch without draining or finalizing it', () => {
    const manager = new ActionPhaseManager();
    const session = manager.begin('select_option', 1_000);
    advanceToPreparation(session);
    session.beginDispatch();
    session.concludeDispatch({ actionDispatched: 'unknown' });

    expect(manager.snapshotAll()).toEqual([
      expect.objectContaining({
        action: 'select_option',
        dispatchState: 'possibly_dispatched',
        terminalOutcome: null,
      }),
    ]);
    expect(manager.activeCount).toBe(1);
    expect(manager.drainCompleted()).toEqual([]);
  });
});
