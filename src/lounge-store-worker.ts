import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

import {
  LOUNGE_MESSAGE_KINDS,
  LoungeStoreError,
  type LoungeAckInput,
  type LoungeAckItemResult,
  type LoungeAckResult,
  type LoungeClaimInboxInput,
  type LoungeClaimInboxResult,
  type LoungeCloseSessionInput,
  type LoungeCloseSessionResult,
  type LoungeDeliveryState,
  type LoungeHeartbeatInput,
  type LoungeHeartbeatResult,
  type LoungeInboxMessage,
  type LoungeJoinInput,
  type LoungeJoinResult,
  type LoungeMemberStatus,
  type LoungePresenceState,
  type LoungeSendInput,
  type LoungeSendResult,
  type LoungeSentMessageStatus,
  type LoungeSessionState,
  type LoungeStatusInput,
  type LoungeStatusResult,
  type LoungeStoreErrorShape,
  type LoungeStoreRequest,
  type LoungeStoreResponse,
} from './lounge-types.js';

const DEFAULT_SESSION_LEASE_MS = 120_000;
const MIN_SESSION_LEASE_MS = 1_000;
const MAX_SESSION_LEASE_MS = 300_000;
const MAX_MESSAGE_BODY_BYTES = 16 * 1024;
const MAX_INBOX_CLAIM = 50;
const MAX_RECENT_SENT_MESSAGES = 50;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface SessionRow {
  session_id: string;
  lounge_id: string;
  agent_id: string;
  closed_at_ms: number | null;
}

interface ExistingMessageRow {
  id: string;
  sequence: number;
  lounge_id: string;
  sender_agent_id: string;
  payload_hash: string;
  created_at_ms: number;
}

interface InboxRow {
  message_id: string;
  sequence: number;
  lounge_id: string;
  sender_agent_id: string;
  sender_display_name: string;
  kind: LoungeInboxMessage['kind'];
  body: string;
  reply_to_message_id: string | null;
  task_key: string | null;
  created_at_ms: number;
  delivery_state: LoungeDeliveryState;
  delivery_attempts: number;
}

interface MemberRow {
  agent_id: string;
  display_name: string;
  provider: string;
  session_state: LoungeSessionState | null;
  heartbeat_at_ms: number | null;
  lease_until_ms: number | null;
  pending_messages: number;
  delivered_messages: number;
}

interface SentDeliveryRow {
  message_id: string;
  sequence: number;
  kind: LoungeInboxMessage['kind'];
  task_key: string | null;
  created_at_ms: number;
  recipient_agent_id: string | null;
  delivery_state: LoungeDeliveryState | null;
  delivery_updated_at_ms: number | null;
}

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new LoungeStoreError(
      'INVALID_ARGUMENT',
      `${label} must be 1-64 characters using letters, numbers, dot, underscore, or dash.`,
    );
  }
}

function assertBoundedText(value: string, label: string, maximum: number): void {
  if (value.trim().length === 0 || value.length > maximum) {
    throw new LoungeStoreError(
      'INVALID_ARGUMENT',
      `${label} must contain 1-${maximum} characters.`,
    );
  }
}

function operationTime(value: number | undefined): number {
  const nowMs = value ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new LoungeStoreError('INVALID_ARGUMENT', 'nowMs must be a non-negative safe integer.');
  }
  return nowMs;
}

function sessionLease(value: number | undefined): number {
  const leaseMs = value ?? DEFAULT_SESSION_LEASE_MS;
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < MIN_SESSION_LEASE_MS ||
    leaseMs > MAX_SESSION_LEASE_MS
  ) {
    throw new LoungeStoreError(
      'INVALID_ARGUMENT',
      `leaseMs must be between ${MIN_SESSION_LEASE_MS} and ${MAX_SESSION_LEASE_MS}.`,
    );
  }
  return leaseMs;
}

function deliveryRank(state: LoungeDeliveryState): number {
  switch (state) {
    case 'pending':
      return 0;
    case 'delivered':
      return 1;
    case 'seen':
      return 2;
    case 'acted':
      return 3;
  }
}

function presenceFor(row: MemberRow, nowMs: number): LoungePresenceState {
  if (
    row.session_state === null ||
    row.session_state === 'offline' ||
    row.lease_until_ms === null ||
    row.lease_until_ms <= nowMs
  ) {
    return 'offline';
  }
  return row.session_state;
}

function normalizedRecipients(values: string[] | undefined): string[] | null {
  if (values === undefined) {
    return null;
  }
  const recipients = [...new Set(values)];
  for (const agentId of recipients) {
    assertIdentifier(agentId, 'recipient agentId');
  }
  recipients.sort();
  return recipients;
}

function messagePayloadHash(input: {
  kind: LoungeSendInput['kind'];
  body: string;
  recipients: string[] | null;
  replyToMessageId: string | null;
  taskKey: string | null;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function storeError(error: unknown): LoungeStoreErrorShape {
  if (error instanceof LoungeStoreError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return {
    code: 'LOUNGE_STORE_FAILURE',
    message: 'The Lounge store operation failed.',
  };
}

export class LoungeStoreDatabase {
  private readonly database: DatabaseSync;

  constructor(readonly databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath, {
      open: true,
      readOnly: false,
      allowExtension: false,
      timeout: 1_000,
    });
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA synchronous = NORMAL');
    this.migrate();
    chmodSync(databasePath, 0o600);
  }

  close(): void {
    this.database.close();
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
      loungeId: session.lounge_id,
      requestingAgentId: session.agent_id,
      members,
      recentSentMessages: [...sentById.values()],
    };
  }

  closeSession(input: LoungeCloseSessionInput): LoungeCloseSessionResult {
    assertIdentifier(input.sessionId, 'sessionId');
    const nowMs = operationTime(input.nowMs);
    const result = this.database.prepare(`
      UPDATE sessions
      SET state = 'offline', heartbeat_at_ms = ?, lease_until_ms = ?, closed_at_ms = ?
      WHERE id = ? AND closed_at_ms IS NULL
    `).run(nowMs, nowMs, nowMs, input.sessionId);
    return { sessionId: input.sessionId, closed: Number(result.changes) === 1 };
  }

  private requireSession(sessionId: string): SessionRow {
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
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private migrate(): void {
    this.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS lounges (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          provider TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memberships (
          lounge_id TEXT NOT NULL REFERENCES lounges(id),
          agent_id TEXT NOT NULL REFERENCES agents(id),
          joined_at_ms INTEGER NOT NULL,
          left_at_ms INTEGER,
          PRIMARY KEY (lounge_id, agent_id)
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          lounge_id TEXT NOT NULL REFERENCES lounges(id),
          agent_id TEXT NOT NULL REFERENCES agents(id),
          client_instance_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (
            state IN ('connected_non_wakeable', 'listening', 'processing', 'offline')
          ),
          started_at_ms INTEGER NOT NULL,
          heartbeat_at_ms INTEGER NOT NULL,
          lease_until_ms INTEGER NOT NULL,
          closed_at_ms INTEGER
        );

        CREATE INDEX IF NOT EXISTS lounge_sessions_by_agent
          ON sessions (lounge_id, agent_id, started_at_ms DESC);

        CREATE TABLE IF NOT EXISTS messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          lounge_id TEXT NOT NULL REFERENCES lounges(id),
          sender_agent_id TEXT NOT NULL REFERENCES agents(id),
          kind TEXT NOT NULL CHECK (kind IN (
            'message',
            'task',
            'blocker',
            'completion',
            'finding',
            'dependency_resolved',
            'question',
            'answer',
            'handoff'
          )),
          body TEXT NOT NULL,
          reply_to_message_id TEXT REFERENCES messages(id),
          task_key TEXT,
          idempotency_key TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          UNIQUE (lounge_id, sender_agent_id, idempotency_key)
        );

        CREATE INDEX IF NOT EXISTS lounge_messages_by_room
          ON messages (lounge_id, sequence);

        CREATE TABLE IF NOT EXISTS deliveries (
          message_id TEXT NOT NULL REFERENCES messages(id),
          recipient_agent_id TEXT NOT NULL REFERENCES agents(id),
          state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'seen', 'acted')),
          delivery_attempts INTEGER NOT NULL,
          delivered_at_ms INTEGER,
          seen_at_ms INTEGER,
          acted_at_ms INTEGER,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (message_id, recipient_agent_id)
        );

        CREATE INDEX IF NOT EXISTS lounge_deliveries_by_recipient
          ON deliveries (recipient_agent_id, state, updated_at_ms);

        PRAGMA user_version = 1;
      `);
    });
  }
}

interface LoungeStoreWorkerData {
  stage5LoungeStoreWorker: true;
  databasePath: string;
}

function isWorkerConfiguration(value: unknown): value is LoungeStoreWorkerData {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<LoungeStoreWorkerData>;
  return (
    candidate.stage5LoungeStoreWorker === true &&
    typeof candidate.databasePath === 'string' &&
    path.isAbsolute(candidate.databasePath)
  );
}

function handleRequest(store: LoungeStoreDatabase, request: LoungeStoreRequest): unknown {
  switch (request.operation) {
    case 'join':
      return store.join(request.input);
    case 'heartbeat':
      return store.heartbeat(request.input);
    case 'send':
      return store.send(request.input);
    case 'claimInbox':
      return store.claimInbox(request.input);
    case 'ack':
      return store.ack(request.input);
    case 'status':
      return store.status(request.input);
    case 'closeSession':
      return store.closeSession(request.input);
    case 'close':
      store.close();
      return { closed: true };
  }
}

if (!isMainThread) {
  if (parentPort === null || !isWorkerConfiguration(workerData)) {
    throw new Error('Invalid Stage5 Lounge store worker configuration.');
  }
  const port = parentPort;
  const store = new LoungeStoreDatabase(workerData.databasePath);
  port.on('message', (request: LoungeStoreRequest) => {
    let response: LoungeStoreResponse;
    try {
      response = { id: request.id, ok: true, result: handleRequest(store, request) };
    } catch (error) {
      response = { id: request.id, ok: false, error: storeError(error) };
    }
    port.postMessage(response);
    if (request.operation === 'close') {
      port.close();
    }
  });
}
