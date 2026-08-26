import { type LoungeNoticeInput, type LoungeNoticeState, type LoungePinInput, type LoungePinResult, LoungeStoreError } from './dependencies.js';
import { MAX_PINNED_NOTICE_BYTES, MAX_PINNED_NOTICE_CHARACTERS, type NoticeMutationRow, type NoticeRow, assertBoundedText, assertIdentifier, noticePayloadHash, operationTime } from './model.js';
import type { LoungeStoreContext } from './runtime.js';

export const noticesOperations = {
  notice(input: LoungeNoticeInput): LoungeNoticeState {
    assertIdentifier(input.sessionId, 'sessionId');
    const session = this.requireSession(input.sessionId);
    return this.currentNotice(session.lounge_id);
  },

  pin(input: LoungePinInput): LoungePinResult {
    assertIdentifier(input.sessionId, 'sessionId');
    assertBoundedText(input.idempotencyKey, 'idempotencyKey', 120);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new LoungeStoreError(
        'INVALID_ARGUMENT',
        'expectedRevision must be a non-negative safe integer.',
      );
    }
    const body = input.body === null ? null : input.body.trim();
    if (body !== null) {
      assertBoundedText(body, 'body', MAX_PINNED_NOTICE_CHARACTERS);
      if (Buffer.byteLength(body, 'utf8') > MAX_PINNED_NOTICE_BYTES) {
        throw new LoungeStoreError(
          'INVALID_ARGUMENT',
          `body must be no larger than ${MAX_PINNED_NOTICE_BYTES} UTF-8 bytes.`,
        );
      }
    }
    const nowMs = operationTime(input.nowMs);
    const session = this.requireManagerSession(input.sessionId);
    const payloadHash = noticePayloadHash({ body, expectedRevision: input.expectedRevision });

    return this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT payload_hash, revision, body, actor_agent_id, created_at_ms
        FROM lounge_notice_mutations
        WHERE lounge_id = ? AND actor_agent_id = ? AND idempotency_key = ?
      `).get(
        session.lounge_id,
        session.agent_id,
        input.idempotencyKey,
      ) as NoticeMutationRow | undefined;
      if (existing !== undefined) {
        if (existing.payload_hash !== payloadHash) {
          throw new LoungeStoreError(
            'IDEMPOTENCY_CONFLICT',
            'The idempotency key was already used for a different pinned-notice mutation.',
          );
        }
        return {
          loungeId: session.lounge_id,
          requestingAgentId: session.agent_id,
          noticeRevision: existing.revision,
          pinnedNotice: existing.body === null
            ? null
            : {
                revision: existing.revision,
                body: existing.body,
                pinnedByAgentId: existing.actor_agent_id,
                pinnedAtMs: existing.created_at_ms,
              },
          duplicate: true,
        };
      }

      const current = this.currentNotice(session.lounge_id);
      if (current.noticeRevision !== input.expectedRevision) {
        throw new LoungeStoreError(
          'NOTICE_REVISION_CONFLICT',
          'The pinned notice changed since it was last observed.',
          { currentRevision: current.noticeRevision },
        );
      }
      const revision = current.noticeRevision + 1;
      this.database.prepare(`
        INSERT INTO lounge_notices (
          lounge_id,
          revision,
          body,
          pinned_by_agent_id,
          pinned_at_ms
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(lounge_id) DO UPDATE SET
          revision = excluded.revision,
          body = excluded.body,
          pinned_by_agent_id = excluded.pinned_by_agent_id,
          pinned_at_ms = excluded.pinned_at_ms
      `).run(
        session.lounge_id,
        revision,
        body,
        body === null ? null : session.agent_id,
        body === null ? null : nowMs,
      );
      this.database.prepare(`
        INSERT INTO lounge_notice_mutations (
          lounge_id,
          actor_agent_id,
          idempotency_key,
          payload_hash,
          revision,
          body,
          created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.lounge_id,
        session.agent_id,
        input.idempotencyKey,
        payloadHash,
        revision,
        body,
        nowMs,
      );
      return {
        loungeId: session.lounge_id,
        requestingAgentId: session.agent_id,
        noticeRevision: revision,
        pinnedNotice: body === null
          ? null
          : {
              revision,
              body,
              pinnedByAgentId: session.agent_id,
              pinnedAtMs: nowMs,
            },
        duplicate: false,
      };
    });
  },

  currentNotice(loungeId: string): LoungeNoticeState {
    const row = this.database.prepare(`
      SELECT revision, body, pinned_by_agent_id, pinned_at_ms
      FROM lounge_notices
      WHERE lounge_id = ?
    `).get(loungeId) as NoticeRow | undefined;
    if (row === undefined) {
      return { loungeId, noticeRevision: 0, pinnedNotice: null };
    }
    return {
      loungeId,
      noticeRevision: row.revision,
      pinnedNotice:
        row.body === null || row.pinned_by_agent_id === null || row.pinned_at_ms === null
          ? null
          : {
              revision: row.revision,
              body: row.body,
              pinnedByAgentId: row.pinned_by_agent_id,
              pinnedAtMs: row.pinned_at_ms,
            },
    };
  },
} satisfies Record<string, unknown> & ThisType<LoungeStoreContext>;

export type NoticesOperations = typeof noticesOperations;
