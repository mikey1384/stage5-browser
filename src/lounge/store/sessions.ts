import { type LoungeCloseSessionInput, type LoungeCloseSessionResult, type LoungeHeartbeatInput, type LoungeHeartbeatResult, type LoungeJoinInput, type LoungeJoinResult, LoungeStoreError, randomUUID } from './dependencies.js';
import { assertBoundedText, assertIdentifier, operationTime, sessionLease } from './model.js';
import type { LoungeStoreContext } from './runtime.js';

export const sessionsOperations = {
  join(input: LoungeJoinInput): LoungeJoinResult {
    assertIdentifier(input.loungeId, 'loungeId');
    assertIdentifier(input.agentId, 'agentId');
    assertBoundedText(input.displayName, 'displayName', 100);
    assertBoundedText(input.provider, 'provider', 50);
    assertIdentifier(input.clientInstanceId, 'clientInstanceId');
    const nowMs = operationTime(input.nowMs);
    const leaseMs = sessionLease(input.leaseMs);
    const sessionId = randomUUID();

    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO lounges (id, display_name, created_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(input.loungeId, input.loungeId, nowMs);
      this.database.prepare(`
        INSERT INTO agents (id, display_name, provider, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          provider = excluded.provider,
          updated_at_ms = excluded.updated_at_ms
      `).run(input.agentId, input.displayName.trim(), input.provider.trim(), nowMs, nowMs);
      this.database.prepare(`
        INSERT INTO memberships (lounge_id, agent_id, joined_at_ms, left_at_ms)
        VALUES (?, ?, ?, NULL)
        ON CONFLICT(lounge_id, agent_id) DO UPDATE SET left_at_ms = NULL
      `).run(input.loungeId, input.agentId, nowMs);

      const superseded = this.database.prepare(`
        UPDATE sessions
        SET state = 'offline', lease_until_ms = ?, closed_at_ms = ?
        WHERE lounge_id = ? AND agent_id = ? AND closed_at_ms IS NULL
      `).run(nowMs, nowMs, input.loungeId, input.agentId);
      this.database.prepare(`
        INSERT INTO sessions (
          id,
          lounge_id,
          agent_id,
          client_instance_id,
          state,
          started_at_ms,
          heartbeat_at_ms,
          lease_until_ms,
          closed_at_ms
        ) VALUES (?, ?, ?, ?, 'connected_non_wakeable', ?, ?, ?, NULL)
      `).run(
        sessionId,
        input.loungeId,
        input.agentId,
        input.clientInstanceId,
        nowMs,
        nowMs,
        nowMs + leaseMs,
      );

      return {
        loungeId: input.loungeId,
        agentId: input.agentId,
        sessionId,
        state: 'connected_non_wakeable',
        joinedAtMs: nowMs,
        leaseUntilMs: nowMs + leaseMs,
        supersededSessionCount: Number(superseded.changes),
      };
    });
  },

  heartbeat(input: LoungeHeartbeatInput): LoungeHeartbeatResult {
    assertIdentifier(input.sessionId, 'sessionId');
    const nowMs = operationTime(input.nowMs);
    const leaseMs = sessionLease(input.leaseMs);
    this.requireSession(input.sessionId);
    const result = this.database.prepare(`
      UPDATE sessions
      SET state = ?, heartbeat_at_ms = ?, lease_until_ms = ?
      WHERE id = ? AND closed_at_ms IS NULL
    `).run(input.state, nowMs, nowMs + leaseMs, input.sessionId);
    if (Number(result.changes) !== 1) {
      throw new LoungeStoreError('SESSION_CLOSED', 'The Lounge session is no longer active.');
    }
    return {
      sessionId: input.sessionId,
      state: input.state,
      heartbeatAtMs: nowMs,
      leaseUntilMs: nowMs + leaseMs,
    };
  },

  closeSession(input: LoungeCloseSessionInput): LoungeCloseSessionResult {
    assertIdentifier(input.sessionId, 'sessionId');
    const nowMs = operationTime(input.nowMs);
    const result = this.database.prepare(`
      UPDATE sessions
      SET state = 'offline', heartbeat_at_ms = ?, lease_until_ms = ?, closed_at_ms = ?
      WHERE id = ? AND closed_at_ms IS NULL
    `).run(nowMs, nowMs, nowMs, input.sessionId);
    return { sessionId: input.sessionId, closed: Number(result.changes) === 1 };
  },
} satisfies Record<string, unknown> & ThisType<LoungeStoreContext>;

export type SessionsOperations = typeof sessionsOperations;
