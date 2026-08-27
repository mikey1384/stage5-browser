export const LOUNGE_MESSAGE_KINDS = [
  'message',
  'task',
  'blocker',
  'completion',
  'finding',
  'dependency_resolved',
  'question',
  'answer',
  'handoff',
] as const;

export type LoungeMessageKind = (typeof LOUNGE_MESSAGE_KINDS)[number];

export const LOUNGE_SESSION_STATES = [
  'connected_non_wakeable',
  'listening',
  'processing',
  'offline',
] as const;

export type LoungeSessionState = (typeof LOUNGE_SESSION_STATES)[number];
export type LoungePresenceState = LoungeSessionState;
export type LoungeAcknowledgementState = 'seen' | 'acted';
export type LoungeDeliveryState = 'pending' | 'delivered' | LoungeAcknowledgementState;

export const LOUNGE_WORK_NOTE_LIMITS = {
  role: 200,
  currentState: 1_000,
  lastCompleted: 1_000,
  blocker: 1_000,
  nextSafeAction: 1_000,
  totalBytes: 8 * 1024,
} as const;

export interface LoungeJoinInput {
  loungeId: string;
  agentId: string;
  displayName: string;
  provider: string;
  clientInstanceId: string;
  nowMs?: number;
  leaseMs?: number;
}

export interface LoungeJoinResult {
  loungeId: string;
  agentId: string;
  sessionId: string;
  state: 'connected_non_wakeable';
  joinedAtMs: number;
  leaseUntilMs: number;
  supersededSessionCount: number;
}

export interface LoungePinnedNotice {
  revision: number;
  body: string;
  pinnedByAgentId: string;
  pinnedAtMs: number;
}

export interface LoungeNoticeState {
  loungeId: string;
  noticeRevision: number;
  pinnedNotice: LoungePinnedNotice | null;
}

export interface LoungeWorkNoteFields {
  role: string;
  currentState: string;
  lastCompleted: string | null;
  blocker: string | null;
  nextSafeAction: string;
}

export interface LoungeWorkNote extends LoungeWorkNoteFields {
  revision: number;
  updatedAtMs: number;
}

export interface LoungeWorkNoteState {
  loungeId: string;
  agentId: string;
  workNoteRevision: number;
  workNote: LoungeWorkNote | null;
}

export type LoungeMemberWorkNoteState = LoungeWorkNoteState;

export interface LoungeWorkNoteInput {
  sessionId: string;
}

export interface LoungeSetWorkNoteInput {
  sessionId: string;
  note: LoungeWorkNoteFields;
  expectedRevision: number;
  idempotencyKey: string;
  nowMs?: number;
}

export interface LoungeSetWorkNoteResult extends LoungeWorkNoteState {
  duplicate: boolean;
}

export interface LoungeHeartbeatInput {
  sessionId: string;
  state: Exclude<LoungeSessionState, 'offline'>;
  leaseMs: number;
  nowMs?: number;
}

export interface LoungeHeartbeatResult {
  sessionId: string;
  state: Exclude<LoungeSessionState, 'offline'>;
  heartbeatAtMs: number;
  leaseUntilMs: number;
}

export interface LoungeSendInput {
  sessionId: string;
  kind: LoungeMessageKind;
  body: string;
  toAgentIds?: string[];
  replyToMessageId?: string | null;
  taskKey?: string | null;
  idempotencyKey: string;
  nowMs?: number;
}

export interface LoungeSendResult {
  messageId: string;
  sequence: number;
  loungeId: string;
  senderAgentId: string;
  recipientAgentIds: string[];
  duplicate: boolean;
  createdAtMs: number;
}

export interface LoungeClaimInboxInput {
  sessionId: string;
  limit?: number;
  nowMs?: number;
}

export interface LoungeInboxMessage {
  messageId: string;
  sequence: number;
  loungeId: string;
  senderAgentId: string;
  senderDisplayName: string;
  kind: LoungeMessageKind;
  body: string;
  replyToMessageId: string | null;
  taskKey: string | null;
  createdAtMs: number;
  deliveryState: 'delivered';
  deliveryAttempt: number;
  authority: 'coordination_only';
}

export interface LoungeClaimInboxResult {
  sessionId: string;
  agentId: string;
  loungeId: string;
  messages: LoungeInboxMessage[];
}

export interface LoungeAckInput {
  sessionId: string;
  messageIds: string[];
  state: LoungeAcknowledgementState;
  nowMs?: number;
}

export interface LoungeAckItemResult {
  messageId: string;
  previousState: LoungeDeliveryState;
  state: LoungeDeliveryState;
  changed: boolean;
}

export interface LoungeAckResult {
  sessionId: string;
  agentId: string;
  loungeId: string;
  acknowledgements: LoungeAckItemResult[];
}

export interface LoungeStatusInput {
  sessionId: string;
  nowMs?: number;
}

export interface LoungeMemberStatus {
  agentId: string;
  displayName: string;
  provider: string;
  presence: LoungePresenceState;
  lastHeartbeatAtMs: number | null;
  leaseUntilMs: number | null;
  pendingMessages: number;
  deliveredMessages: number;
}

export interface LoungeSentMessageStatus {
  messageId: string;
  sequence: number;
  kind: LoungeMessageKind;
  taskKey: string | null;
  createdAtMs: number;
  recipients: Array<{
    agentId: string;
    state: LoungeDeliveryState;
    updatedAtMs: number;
  }>;
}

export interface LoungeStatusResult {
  loungeId: string;
  requestingAgentId: string;
  members: LoungeMemberStatus[];
  recentSentMessages: LoungeSentMessageStatus[];
  workNoteRevision: number;
  workNote: LoungeWorkNote | null;
  memberWorkNotes: LoungeMemberWorkNoteState[] | null;
  noticeRevision: number;
  pinnedNotice: LoungePinnedNotice | null;
}

export interface LoungePinInput {
  sessionId: string;
  body: string | null;
  expectedRevision: number;
  idempotencyKey: string;
  nowMs?: number;
}

export interface LoungePinResult extends LoungeNoticeState {
  requestingAgentId: string;
  duplicate: boolean;
}

export interface LoungeNoticeInput {
  sessionId: string;
}

export interface LoungeHistoryInput {
  sessionId: string;
  limit?: number;
  beforeSequence?: number | null;
  afterSequence?: number | null;
  nowMs?: number;
}

export interface LoungeHistoryRecipient {
  agentId: string;
  state: LoungeDeliveryState;
  deliveredAtMs: number | null;
  seenAtMs: number | null;
  actedAtMs: number | null;
  updatedAtMs: number;
}

export interface LoungeHistoryMessage {
  messageId: string;
  sequence: number;
  loungeId: string;
  senderAgentId: string;
  senderDisplayName: string;
  kind: LoungeMessageKind;
  body: string;
  replyToMessageId: string | null;
  taskKey: string | null;
  createdAtMs: number;
  recipients: LoungeHistoryRecipient[];
  authority: 'coordination_only';
}

export interface LoungeHistoryResult {
  loungeId: string;
  requestingAgentId: string;
  auditId: string;
  auditedAtMs: number;
  messages: LoungeHistoryMessage[];
  page: {
    limit: number;
    beforeSequence: number | null;
    afterSequence: number | null;
    oldestSequence: number | null;
    newestSequence: number | null;
    hasOlder: boolean;
    hasNewer: boolean;
  };
}

export interface LoungeCloseSessionInput {
  sessionId: string;
  nowMs?: number;
}

export interface LoungeCloseSessionResult {
  sessionId: string;
  closed: boolean;
}

export interface LoungeStoreErrorShape {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type LoungeStoreOperation =
  | 'join'
  | 'heartbeat'
  | 'send'
  | 'claimInbox'
  | 'ack'
  | 'status'
  | 'notice'
  | 'pin'
  | 'workNote'
  | 'setWorkNote'
  | 'history'
  | 'closeSession'
  | 'close';

export type LoungeStoreRequest =
  | { id: string; operation: 'join'; input: LoungeJoinInput }
  | { id: string; operation: 'heartbeat'; input: LoungeHeartbeatInput }
  | { id: string; operation: 'send'; input: LoungeSendInput }
  | { id: string; operation: 'claimInbox'; input: LoungeClaimInboxInput }
  | { id: string; operation: 'ack'; input: LoungeAckInput }
  | { id: string; operation: 'status'; input: LoungeStatusInput }
  | { id: string; operation: 'notice'; input: LoungeNoticeInput }
  | { id: string; operation: 'pin'; input: LoungePinInput }
  | { id: string; operation: 'workNote'; input: LoungeWorkNoteInput }
  | { id: string; operation: 'setWorkNote'; input: LoungeSetWorkNoteInput }
  | { id: string; operation: 'history'; input: LoungeHistoryInput }
  | { id: string; operation: 'closeSession'; input: LoungeCloseSessionInput }
  | { id: string; operation: 'close'; input: Record<string, never> };

export type LoungeStoreResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: LoungeStoreErrorShape };

export class LoungeStoreError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'LoungeStoreError';
    this.code = code;
    this.details = details;
  }
}
