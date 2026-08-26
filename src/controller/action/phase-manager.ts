import { ActionPhaseInvariantError, ActionPhaseSession } from './phase-session.js';

export class ActionPhaseManager {
  private readonly active = new Map<string, ActionPhaseSession>();
  private readonly completed = new Array<ReturnType<ActionPhaseSession['snapshot']>>();

  begin(action: string, timeoutMs: number): ActionPhaseSession {
    const session = new ActionPhaseSession(action, timeoutMs);
    this.active.set(session.actionId, session);
    return session;
  }

  finish(session: ActionPhaseSession): void {
    if (!this.active.delete(session.actionId)) {
      throw new ActionPhaseInvariantError('The action phase session is not owned by this manager.');
    }
    this.completed.push(session.snapshot());
    if (this.completed.length > 100) this.completed.splice(0, this.completed.length - 100);
  }

  drainCompleted(): Array<ReturnType<ActionPhaseSession['snapshot']>> {
    return this.completed.splice(0, this.completed.length);
  }

  snapshot(actionId: string) {
    return this.active.get(actionId)?.snapshot() ?? null;
  }

  get activeCount(): number {
    return this.active.size;
  }
}
