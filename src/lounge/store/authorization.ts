import { LoungeStoreError } from './dependencies.js';
import { type SessionRow } from './model.js';
import type { LoungeStoreContext } from './runtime.js';

export const authorizationOperations = {
  requireManagerSession(sessionId: string): SessionRow {
    const session = this.requireSession(sessionId);
    if (!this.managerAgentIds.has(session.agent_id)) {
      throw new LoungeStoreError(
        'MANAGER_ACCESS_REQUIRED',
        'This Lounge connection is not authorized for manager access.',
      );
    }
    return session;
  },

  requireSession(sessionId: string): SessionRow {
    const session = this.database.prepare(`
      SELECT
        id AS session_id,
        lounge_id,
        agent_id,
        closed_at_ms
      FROM sessions
      WHERE id = ?
    `).get(sessionId) as SessionRow | undefined;
    if (session === undefined) {
      throw new LoungeStoreError('SESSION_NOT_FOUND', 'The Lounge session does not exist.');
    }
    if (session.closed_at_ms !== null) {
      throw new LoungeStoreError('SESSION_CLOSED', 'The Lounge session is no longer active.');
    }
    return session;
  },
} satisfies Record<string, unknown> & ThisType<LoungeStoreContext>;

export type AuthorizationOperations = typeof authorizationOperations;
