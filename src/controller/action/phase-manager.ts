import { ActionPhaseInvariantError, ActionPhaseSession } from './phase-session.js';

export class ActionPhaseManager {
  private readonly active = new Map<string, ActionPhaseSession>();

  begin(action: string, timeoutMs: number): ActionPhaseSession {
    const session = new ActionPhaseSession(action, timeoutMs);
    this.active.set(session.actionId, session);
    return session;
  }

  finish(session: ActionPhaseSession): void {
    if (!this.active.delete(session.actionId)) {
      throw new ActionPhaseInvariantError('The action phase session is not owned by this manager.');
    }
  }

  snapshot(actionId: string) {
    return this.active.get(actionId)?.snapshot() ?? null;
  }

  get activeCount(): number {
    return this.active.size;
  }
}
