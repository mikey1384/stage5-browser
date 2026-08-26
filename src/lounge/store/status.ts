import { type LoungeMemberStatus, type LoungeSentMessageStatus, type LoungeStatusInput, type LoungeStatusResult } from './dependencies.js';
import { MAX_RECENT_SENT_MESSAGES, type MemberRow, type SentDeliveryRow, assertIdentifier, operationTime, presenceFor } from './model.js';
import type { LoungeStoreContext } from './runtime.js';

export const statusOperations = {
  status(input: LoungeStatusInput): LoungeStatusResult {
    assertIdentifier(input.sessionId, 'sessionId');
    const nowMs = operationTime(input.nowMs);
    const session = this.requireSession(input.sessionId);
    const memberRows = this.database.prepare(`
      SELECT
        a.id AS agent_id,
        a.display_name,
        a.provider,
        latest.state AS session_state,
        latest.heartbeat_at_ms,
        latest.lease_until_ms,
        SUM(CASE WHEN inbox_message.id IS NOT NULL AND d.state = 'pending' THEN 1 ELSE 0 END)
          AS pending_messages,
        SUM(CASE WHEN inbox_message.id IS NOT NULL AND d.state = 'delivered' THEN 1 ELSE 0 END)
          AS delivered_messages
      FROM memberships membership
      JOIN agents a ON a.id = membership.agent_id
      LEFT JOIN sessions latest ON latest.id = (
        SELECT s.id
        FROM sessions s
        WHERE
          s.lounge_id = membership.lounge_id AND
          s.agent_id = membership.agent_id AND
          s.closed_at_ms IS NULL
        ORDER BY s.started_at_ms DESC
        LIMIT 1
      )
      LEFT JOIN deliveries d ON d.recipient_agent_id = a.id
      LEFT JOIN messages inbox_message ON
        inbox_message.id = d.message_id AND
        inbox_message.lounge_id = membership.lounge_id
      WHERE membership.lounge_id = ? AND membership.left_at_ms IS NULL
      GROUP BY
        a.id,
        a.display_name,
        a.provider,
        latest.state,
        latest.heartbeat_at_ms,
        latest.lease_until_ms
      ORDER BY a.id
    `).all(session.lounge_id) as unknown as MemberRow[];
    const members: LoungeMemberStatus[] = memberRows.map((row) => ({
      agentId: row.agent_id,
      displayName: row.display_name,
      provider: row.provider,
      presence: presenceFor(row, nowMs),
      lastHeartbeatAtMs: row.heartbeat_at_ms,
      leaseUntilMs: row.lease_until_ms,
      pendingMessages: Number(row.pending_messages),
      deliveredMessages: Number(row.delivered_messages),
    }));

    const sentRows = this.database.prepare(`
      WITH recent_messages AS (
        SELECT id, sequence, kind, task_key, created_at_ms
        FROM messages
        WHERE lounge_id = ? AND sender_agent_id = ?
        ORDER BY sequence DESC
        LIMIT ?
      )
      SELECT
        m.id AS message_id,
        m.sequence,
        m.kind,
        m.task_key,
        m.created_at_ms,
        d.recipient_agent_id,
        d.state AS delivery_state,
        d.updated_at_ms AS delivery_updated_at_ms
      FROM recent_messages m
      LEFT JOIN deliveries d ON d.message_id = m.id
      ORDER BY m.sequence DESC, d.recipient_agent_id
    `).all(
      session.lounge_id,
      session.agent_id,
      MAX_RECENT_SENT_MESSAGES,
    ) as unknown as SentDeliveryRow[];
    const sentById = new Map<string, LoungeSentMessageStatus>();
    for (const row of sentRows) {
      let message = sentById.get(row.message_id);
      if (message === undefined) {
        if (sentById.size >= MAX_RECENT_SENT_MESSAGES) {
          continue;
        }
        message = {
          messageId: row.message_id,
          sequence: row.sequence,
          kind: row.kind,
          taskKey: row.task_key,
          createdAtMs: row.created_at_ms,
          recipients: [],
        };
        sentById.set(row.message_id, message);
      }
      if (
        row.recipient_agent_id !== null &&
        row.delivery_state !== null &&
        row.delivery_updated_at_ms !== null
      ) {
        message.recipients.push({
          agentId: row.recipient_agent_id,
          state: row.delivery_state,
          updatedAtMs: row.delivery_updated_at_ms,
        });
      }
    }

    return {
      requestingAgentId: session.agent_id,
      members,
      recentSentMessages: [...sentById.values()],
      ...this.currentNotice(session.lounge_id),
    };
  },
} satisfies Record<string, unknown> & ThisType<LoungeStoreContext>;

export type StatusOperations = typeof statusOperations;
