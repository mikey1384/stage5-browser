import { type LoungeHistoryInput, type LoungeHistoryMessage, type LoungeHistoryRecipient, type LoungeHistoryResult, LoungeStoreError, randomUUID } from './dependencies.js';
import { type HistoryDeliveryRow, type HistoryMessageRow, MAX_HISTORY_MESSAGES, assertIdentifier, operationTime, optionalSequence } from './model.js';
import type { LoungeStoreContext } from './runtime.js';

export const historyOperations = {
  history(input: LoungeHistoryInput): LoungeHistoryResult {
    assertIdentifier(input.sessionId, 'sessionId');
    const nowMs = operationTime(input.nowMs);
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_MESSAGES) {
      throw new LoungeStoreError(
        'INVALID_ARGUMENT',
        `limit must be between 1 and ${MAX_HISTORY_MESSAGES}.`,
      );
    }
    const beforeSequence = optionalSequence(input.beforeSequence, 'beforeSequence');
    const afterSequence = optionalSequence(input.afterSequence, 'afterSequence');
    if (beforeSequence !== null && afterSequence !== null) {
      throw new LoungeStoreError(
        'INVALID_ARGUMENT',
        'beforeSequence and afterSequence are mutually exclusive.',
      );
    }
    const session = this.requireManagerSession(input.sessionId);

    return this.transaction(() => {
      const select = (where: string, order: 'ASC' | 'DESC', cursor?: number): HistoryMessageRow[] =>
        this.database.prepare(`
          SELECT
            m.id AS message_id,
            m.sequence,
            m.lounge_id,
            m.sender_agent_id,
            sender.display_name AS sender_display_name,
            m.kind,
            m.body,
            m.reply_to_message_id,
            m.task_key,
            m.created_at_ms
          FROM messages m
          JOIN agents sender ON sender.id = m.sender_agent_id
          WHERE m.lounge_id = ? ${where}
          ORDER BY m.sequence ${order}
          LIMIT ?
        `).all(
          ...(cursor === undefined
            ? [session.lounge_id, limit]
            : [session.lounge_id, cursor, limit]),
        ) as unknown as HistoryMessageRow[];
      let rows: HistoryMessageRow[];
      if (afterSequence !== null) {
        rows = select('AND m.sequence > ?', 'ASC', afterSequence);
      } else if (beforeSequence !== null) {
        rows = select('AND m.sequence < ?', 'DESC', beforeSequence).reverse();
      } else {
        rows = select('', 'DESC').reverse();
      }

      const recipientsByMessage = new Map<string, LoungeHistoryRecipient[]>();
      if (rows.length > 0) {
        const placeholders = rows.map(() => '?').join(', ');
        const deliveries = this.database.prepare(`
          SELECT
            message_id,
            recipient_agent_id,
            state,
            delivered_at_ms,
            seen_at_ms,
            acted_at_ms,
            updated_at_ms
          FROM deliveries
          WHERE message_id IN (${placeholders})
          ORDER BY message_id, recipient_agent_id
        `).all(...rows.map((row) => row.message_id)) as unknown as HistoryDeliveryRow[];
        for (const delivery of deliveries) {
          const recipients = recipientsByMessage.get(delivery.message_id) ?? [];
          recipients.push({
            agentId: delivery.recipient_agent_id,
            state: delivery.state,
            deliveredAtMs: delivery.delivered_at_ms,
            seenAtMs: delivery.seen_at_ms,
            actedAtMs: delivery.acted_at_ms,
            updatedAtMs: delivery.updated_at_ms,
          });
          recipientsByMessage.set(delivery.message_id, recipients);
        }
      }
      const messages: LoungeHistoryMessage[] = rows.map((row) => ({
        messageId: row.message_id,
        sequence: row.sequence,
        loungeId: row.lounge_id,
        senderAgentId: row.sender_agent_id,
        senderDisplayName: row.sender_display_name,
        kind: row.kind,
        body: row.body,
        replyToMessageId: row.reply_to_message_id,
        taskKey: row.task_key,
        createdAtMs: row.created_at_ms,
        recipients: recipientsByMessage.get(row.message_id) ?? [],
        authority: 'coordination_only',
      }));
      const oldestSequence = messages[0]?.sequence ?? null;
      const newestSequence = messages.at(-1)?.sequence ?? null;
      const exists = (comparison: '<' | '<=' | '>' | '>=', sequence: number): boolean => {
        const row = this.database.prepare(`
          SELECT 1 AS present
          FROM messages
          WHERE lounge_id = ? AND sequence ${comparison} ?
          LIMIT 1
        `).get(session.lounge_id, sequence) as { present: number } | undefined;
        return row !== undefined;
      };
      const hasOlder = oldestSequence === null
        ? (afterSequence !== null && exists('<=', afterSequence))
        : exists('<', oldestSequence);
      const hasNewer = newestSequence === null
        ? (beforeSequence !== null && exists('>=', beforeSequence))
        : exists('>', newestSequence);
      const auditId = randomUUID();
      this.database.prepare(`
        INSERT INTO lounge_history_audits (
          id,
          lounge_id,
          manager_agent_id,
          session_id,
          before_sequence,
          after_sequence,
          requested_limit,
          result_count,
          oldest_sequence,
          newest_sequence,
          created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        auditId,
        session.lounge_id,
        session.agent_id,
        session.session_id,
        beforeSequence,
        afterSequence,
        limit,
        messages.length,
        oldestSequence,
        newestSequence,
        nowMs,
      );
      return {
        loungeId: session.lounge_id,
        requestingAgentId: session.agent_id,
        auditId,
        auditedAtMs: nowMs,
        messages,
        page: {
          limit,
          beforeSequence,
          afterSequence,
          oldestSequence,
          newestSequence,
          hasOlder,
          hasNewer,
        },
      };
    });
  },
} satisfies Record<string, unknown> & ThisType<LoungeStoreContext>;

export type HistoryOperations = typeof historyOperations;
