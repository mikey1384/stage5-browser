import { LOUNGE_WORK_NOTE_LIMITS, type LoungeDeliveryState, type LoungeInboxMessage, type LoungePresenceState, type LoungeSendInput, type LoungeSessionState, type LoungeWorkNoteFields, LoungeStoreError, type LoungeStoreErrorShape, createHash } from './dependencies.js';

export const DEFAULT_SESSION_LEASE_MS = 120_000;
export const MIN_SESSION_LEASE_MS = 1_000;
export const MAX_SESSION_LEASE_MS = 300_000;
export const MAX_MESSAGE_BODY_BYTES = 16 * 1024;
export const MAX_INBOX_CLAIM = 50;
export const MAX_RECENT_SENT_MESSAGES = 50;
export const MAX_WORK_NOTE_MUTATIONS_PER_IDENTITY = 256;
export const MAX_HISTORY_MESSAGES = 100;
export const MAX_PINNED_NOTICE_CHARACTERS = 4_000;
export const MAX_PINNED_NOTICE_BYTES = 8 * 1024;
export const STORE_INITIALIZATION_TIMEOUT_MS = 5_000;
export const STORE_INITIALIZATION_RETRY_MS = 25;
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const STORE_INITIALIZATION_WAIT = new Int32Array(
  new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);

export interface SessionRow {
  session_id: string;
  lounge_id: string;
  agent_id: string;
  closed_at_ms: number | null;
}

export interface ExistingMessageRow {
  id: string;
  sequence: number;
  lounge_id: string;
  sender_agent_id: string;
  payload_hash: string;
  created_at_ms: number;
}

export interface InboxRow {
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

export interface MemberRow {
  agent_id: string;
  display_name: string;
  provider: string;
  session_state: LoungeSessionState | null;
  heartbeat_at_ms: number | null;
  lease_until_ms: number | null;
  pending_messages: number;
  delivered_messages: number;
}

export interface SentDeliveryRow {
  message_id: string;
  sequence: number;
  kind: LoungeInboxMessage['kind'];
  task_key: string | null;
  created_at_ms: number;
  recipient_agent_id: string | null;
  delivery_state: LoungeDeliveryState | null;
  delivery_updated_at_ms: number | null;
}

export interface NoticeRow {
  revision: number;
  body: string | null;
  pinned_by_agent_id: string | null;
  pinned_at_ms: number | null;
}

export interface NoticeMutationRow {
  payload_hash: string;
  revision: number;
  body: string | null;
  actor_agent_id: string;
  created_at_ms: number;
}

export interface WorkNoteRow {
  lounge_id: string;
  agent_id: string;
  revision: number;
  role: string;
  current_state: string;
  last_completed: string | null;
  blocker: string | null;
  next_safe_action: string;
  updated_at_ms: number;
}

export interface WorkNoteMutationRow extends WorkNoteRow {
  payload_hash: string;
}

export interface HistoryMessageRow {
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
}

export interface HistoryDeliveryRow {
  message_id: string;
  recipient_agent_id: string;
  state: LoungeDeliveryState;
  delivered_at_ms: number | null;
  seen_at_ms: number | null;
  acted_at_ms: number | null;
  updated_at_ms: number;
}

export function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new LoungeStoreError(
      'INVALID_ARGUMENT',
      `${label} must be 1-64 characters using letters, numbers, dot, underscore, or dash.`,
    );
  }
}

export function assertBoundedText(value: string, label: string, maximum: number): void {
  if (value.trim().length === 0 || value.length > maximum) {
    throw new LoungeStoreError(
      'INVALID_ARGUMENT',
      `${label} must contain 1-${maximum} characters.`,
    );
  }
}

export function operationTime(value: number | undefined): number {
  const nowMs = value ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new LoungeStoreError('INVALID_ARGUMENT', 'nowMs must be a non-negative safe integer.');
  }
  return nowMs;
}

export function sessionLease(value: number | undefined): number {
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

export function deliveryRank(state: LoungeDeliveryState): number {
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

export function presenceFor(row: MemberRow, nowMs: number): LoungePresenceState {
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

export function normalizedRecipients(values: string[] | undefined): string[] | null {
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

export function messagePayloadHash(input: {
  kind: LoungeSendInput['kind'];
  body: string;
  recipients: string[] | null;
  replyToMessageId: string | null;
  taskKey: string | null;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function noticePayloadHash(input: { body: string | null; expectedRevision: number }): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function normalizedWorkNote(note: LoungeWorkNoteFields): LoungeWorkNoteFields {
  const normalized = {
    role: note.role.trim(),
    currentState: note.currentState.trim(),
    lastCompleted: note.lastCompleted?.trim() ?? null,
    blocker: note.blocker?.trim() ?? null,
    nextSafeAction: note.nextSafeAction.trim(),
  };
  assertBoundedText(normalized.role, 'note.role', LOUNGE_WORK_NOTE_LIMITS.role);
  assertBoundedText(
    normalized.currentState,
    'note.currentState',
    LOUNGE_WORK_NOTE_LIMITS.currentState,
  );
  if (normalized.lastCompleted !== null) {
    assertBoundedText(
      normalized.lastCompleted,
      'note.lastCompleted',
      LOUNGE_WORK_NOTE_LIMITS.lastCompleted,
    );
  }
  if (normalized.blocker !== null) {
    assertBoundedText(normalized.blocker, 'note.blocker', LOUNGE_WORK_NOTE_LIMITS.blocker);
  }
  assertBoundedText(
    normalized.nextSafeAction,
    'note.nextSafeAction',
    LOUNGE_WORK_NOTE_LIMITS.nextSafeAction,
  );
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > LOUNGE_WORK_NOTE_LIMITS.totalBytes) {
    throw new LoungeStoreError(
      'INVALID_ARGUMENT',
      `note must be no larger than ${LOUNGE_WORK_NOTE_LIMITS.totalBytes} UTF-8 bytes.`,
    );
  }
  return normalized;
}

export function workNotePayloadHash(input: {
  note: LoungeWorkNoteFields;
  expectedRevision: number;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function optionalSequence(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new LoungeStoreError('INVALID_ARGUMENT', `${label} must be a positive safe integer.`);
  }
  return value;
}

export function retryableSqliteContention(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    /\b(database|schema|table) (?:is )?locked\b/iu.test(error.message);
}

export function storeError(error: unknown): LoungeStoreErrorShape {
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
