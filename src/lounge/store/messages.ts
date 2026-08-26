import { LOUNGE_MESSAGE_KINDS, type LoungeAckInput, type LoungeAckItemResult, type LoungeAckResult, type LoungeClaimInboxInput, type LoungeClaimInboxResult, type LoungeDeliveryState, type LoungeInboxMessage, type LoungeSendInput, type LoungeSendResult, LoungeStoreError, randomUUID } from './dependencies.js';
import { type ExistingMessageRow, type InboxRow, MAX_INBOX_CLAIM, MAX_MESSAGE_BODY_BYTES, assertBoundedText, assertIdentifier, deliveryRank, messagePayloadHash, normalizedRecipients, operationTime } from './model.js';
import type { LoungeStoreContext } from './runtime.js';

export const messagesOperations = {
  send(input: LoungeSendInput): LoungeSendResult {
    assertIdentifier(input.sessionId, 'sessionId');
    if (!(LOUNGE_MESSAGE_KINDS as readonly string[]).includes(input.kind)) {
      throw new LoungeStoreError('INVALID_ARGUMENT', 'Unsupported Lounge message kind.');
    }
    assertBoundedText(input.body, 'body', MAX_MESSAGE_BODY_BYTES);
    if (Buffer.byteLength(input.body, 'utf8') > MAX_MESSAGE_BODY_BYTES) {
      throw new LoungeStoreError(
        'INVALID_ARGUMENT',
        `body must be no larger than ${MAX_MESSAGE_BODY_BYTES} UTF-8 bytes.`,
      );
    }
    assertBoundedText(input.idempotencyKey, 'idempotencyKey', 120);
    if (input.replyToMessageId !== null && input.replyToMessageId !== undefined) {
      assertIdentifier(input.replyToMessageId, 'replyToMessageId');
    }
    if (input.taskKey !== null && input.taskKey !== undefined) {
      assertBoundedText(input.taskKey, 'taskKey', 100);
    }
    const nowMs = operationTime(input.nowMs);
    const requestedRecipients = normalizedRecipients(input.toAgentIds);
    const replyToMessageId = input.replyToMessageId ?? null;
    const taskKey = input.taskKey ?? null;
    const session = this.requireSession(input.sessionId);

    return this.transaction(() => {
      if (replyToMessageId !== null) {
        const reply = this.database.prepare(
          'SELECT lounge_id FROM messages WHERE id = ?',
        ).get(replyToMessageId) as { lounge_id: string } | undefined;
        if (reply === undefined || reply.lounge_id !== session.lounge_id) {
          throw new LoungeStoreError(
            'REPLY_TARGET_NOT_FOUND',
            'The reply target is not a message in this Lounge.',
          );
        }
      }

      let recipients: string[];
      if (requestedRecipients === null) {
        recipients = (this.database.prepare(`
          SELECT agent_id
          FROM memberships
          WHERE lounge_id = ? AND left_at_ms IS NULL AND agent_id <> ?
          ORDER BY agent_id
        `).all(session.lounge_id, session.agent_id) as Array<{ agent_id: string }>).map(
          (row) => row.agent_id,
        );
      } else {
        recipients = requestedRecipients.filter((agentId) => agentId !== session.agent_id);
        if (recipients.length === 0) {
          throw new LoungeStoreError(
            'INVALID_ARGUMENT',
            'A direct Lounge message must name at least one other room member.',
          );
        }
        const membership = this.database.prepare(`
          SELECT 1
          FROM memberships
          WHERE lounge_id = ? AND agent_id = ? AND left_at_ms IS NULL
        `);
        for (const agentId of recipients) {
          if (membership.get(session.lounge_id, agentId) === undefined) {
            throw new LoungeStoreError(
              'RECIPIENT_NOT_IN_LOUNGE',
              'Every direct recipient must already be a member of the Lounge.',
              { agentId },
            );
          }
        }
      }

      const payloadHash = messagePayloadHash({
        kind: input.kind,
        body: input.body,
        recipients,
        replyToMessageId,
        taskKey,
      });
      const existing = this.database.prepare(`
        SELECT id, sequence, lounge_id, sender_agent_id, payload_hash, created_at_ms
        FROM messages
        WHERE lounge_id = ? AND sender_agent_id = ? AND idempotency_key = ?
      `).get(
        session.lounge_id,
        session.agent_id,
        input.idempotencyKey,
      ) as ExistingMessageRow | undefined;
      if (existing !== undefined) {
        if (existing.payload_hash !== payloadHash) {
          throw new LoungeStoreError(
            'IDEMPOTENCY_CONFLICT',
            'The idempotency key was already used for a different Lounge message.',
          );
        }
        const originalRecipients = (this.database.prepare(`
          SELECT recipient_agent_id
          FROM deliveries
          WHERE message_id = ?
          ORDER BY recipient_agent_id
        `).all(existing.id) as Array<{ recipient_agent_id: string }>).map(
          (row) => row.recipient_agent_id,
        );
        return {
          messageId: existing.id,
          sequence: existing.sequence,
          loungeId: existing.lounge_id,
          senderAgentId: existing.sender_agent_id,
          recipientAgentIds: originalRecipients,
          duplicate: true,
          createdAtMs: existing.created_at_ms,
        };
      }

      const messageId = randomUUID();
      const insertion = this.database.prepare(`
        INSERT INTO messages (
          id,
          lounge_id,
          sender_agent_id,
          kind,
          body,
          reply_to_message_id,
          task_key,
          idempotency_key,
          payload_hash,
          created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        messageId,
        session.lounge_id,
        session.agent_id,
        input.kind,
        input.body,
        replyToMessageId,
        taskKey,
        input.idempotencyKey,
        payloadHash,
        nowMs,
      );
      const addDelivery = this.database.prepare(`
        INSERT INTO deliveries (
          message_id,
          recipient_agent_id,
          state,
          delivery_attempts,
          delivered_at_ms,
          seen_at_ms,
          acted_at_ms,
          updated_at_ms
        ) VALUES (?, ?, 'pending', 0, NULL, NULL, NULL, ?)
      `);
      for (const agentId of recipients) {
        addDelivery.run(messageId, agentId, nowMs);
      }

      return {
        messageId,
        sequence: Number(insertion.lastInsertRowid),
        loungeId: session.lounge_id,
        senderAgentId: session.agent_id,
        recipientAgentIds: recipients,
        duplicate: false,
        createdAtMs: nowMs,
      };
    });
  },

  claimInbox(input: LoungeClaimInboxInput): LoungeClaimInboxResult {
    assertIdentifier(input.sessionId, 'sessionId');
    const nowMs = operationTime(input.nowMs);
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INBOX_CLAIM) {
      throw new LoungeStoreError(
        'INVALID_ARGUMENT',
        `limit must be between 1 and ${MAX_INBOX_CLAIM}.`,
      );
    }
    const session = this.requireSession(input.sessionId);

    return this.transaction(() => {
      const rows = this.database.prepare(`
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
          m.created_at_ms,
          d.state AS delivery_state,
          d.delivery_attempts
        FROM deliveries d
        JOIN messages m ON m.id = d.message_id
        JOIN agents sender ON sender.id = m.sender_agent_id
        WHERE
          d.recipient_agent_id = ? AND
          m.lounge_id = ? AND
          d.state IN ('pending', 'delivered')
        ORDER BY m.sequence
        LIMIT ?
      `).all(session.agent_id, session.lounge_id, limit) as unknown as InboxRow[];
      const markDelivered = this.database.prepare(`
        UPDATE deliveries
        SET
          state = 'delivered',
          delivery_attempts = delivery_attempts + 1,
          delivered_at_ms = COALESCE(delivered_at_ms, ?),
          updated_at_ms = ?
        WHERE message_id = ? AND recipient_agent_id = ? AND state IN ('pending', 'delivered')
      `);
      const messages: LoungeInboxMessage[] = [];
      for (const row of rows) {
        const update = markDelivered.run(
          nowMs,
          nowMs,
          row.message_id,
          session.agent_id,
        );
        if (Number(update.changes) !== 1) {
          continue;
        }
        messages.push({
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
          deliveryState: 'delivered',
          deliveryAttempt: row.delivery_attempts + 1,
          authority: 'coordination_only',
        });
      }
      return {
        sessionId: input.sessionId,
        agentId: session.agent_id,
        loungeId: session.lounge_id,
        messages,
      };
    });
  },

  ack(input: LoungeAckInput): LoungeAckResult {
    assertIdentifier(input.sessionId, 'sessionId');
    const messageIds = [...new Set(input.messageIds)];
    if (messageIds.length < 1 || messageIds.length > MAX_INBOX_CLAIM) {
      throw new LoungeStoreError(
        'INVALID_ARGUMENT',
        `messageIds must contain 1-${MAX_INBOX_CLAIM} unique values.`,
      );
    }
    for (const messageId of messageIds) {
      assertIdentifier(messageId, 'messageId');
    }
    const nowMs = operationTime(input.nowMs);
    const session = this.requireSession(input.sessionId);

    return this.transaction(() => {
      const selectDelivery = this.database.prepare(`
        SELECT d.state
        FROM deliveries d
        JOIN messages m ON m.id = d.message_id
        WHERE d.message_id = ? AND d.recipient_agent_id = ? AND m.lounge_id = ?
      `);
      const markSeen = this.database.prepare(`
        UPDATE deliveries
        SET
          state = 'seen',
          delivered_at_ms = COALESCE(delivered_at_ms, ?),
          seen_at_ms = COALESCE(seen_at_ms, ?),
          updated_at_ms = ?
        WHERE message_id = ? AND recipient_agent_id = ?
      `);
      const markActed = this.database.prepare(`
        UPDATE deliveries
        SET
          state = 'acted',
          delivered_at_ms = COALESCE(delivered_at_ms, ?),
          seen_at_ms = COALESCE(seen_at_ms, ?),
          acted_at_ms = COALESCE(acted_at_ms, ?),
          updated_at_ms = ?
        WHERE message_id = ? AND recipient_agent_id = ?
      `);
      const acknowledgements: LoungeAckItemResult[] = [];
      for (const messageId of messageIds) {
        const delivery = selectDelivery.get(
          messageId,
          session.agent_id,
          session.lounge_id,
        ) as { state: LoungeDeliveryState } | undefined;
        if (delivery === undefined) {
          throw new LoungeStoreError(
            'DELIVERY_NOT_FOUND',
            'The message is not available to this Lounge agent.',
            { messageId },
          );
        }
        const previousState = delivery.state;
        const nextState =
          deliveryRank(input.state) > deliveryRank(previousState)
            ? input.state
            : previousState;
        if (nextState !== previousState) {
          if (nextState === 'acted') {
            markActed.run(
              nowMs,
              nowMs,
              nowMs,
              nowMs,
              messageId,
              session.agent_id,
            );
          } else if (nextState === 'seen') {
            markSeen.run(nowMs, nowMs, nowMs, messageId, session.agent_id);
          }
        }
        acknowledgements.push({
          messageId,
          previousState,
          state: nextState,
          changed: nextState !== previousState,
        });
      }
      return {
        sessionId: input.sessionId,
        agentId: session.agent_id,
        loungeId: session.lounge_id,
        acknowledgements,
      };
    });
  },
} satisfies Record<string, unknown> & ThisType<LoungeStoreContext>;

export type MessagesOperations = typeof messagesOperations;
