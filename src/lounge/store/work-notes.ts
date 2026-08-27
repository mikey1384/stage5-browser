import {
  type LoungeMemberWorkNoteState,
  type LoungeSetWorkNoteInput,
  type LoungeSetWorkNoteResult,
  type LoungeWorkNote,
  type LoungeWorkNoteInput,
  type LoungeWorkNoteState,
  LoungeStoreError,
} from './dependencies.js';
import {
  MAX_WORK_NOTE_MUTATIONS_PER_IDENTITY,
  type WorkNoteMutationRow,
  type WorkNoteRow,
  assertBoundedText,
  assertIdentifier,
  normalizedWorkNote,
  operationTime,
  workNotePayloadHash,
} from './model.js';
import type { LoungeStoreContext } from './runtime.js';

function noteFromRow(row: WorkNoteRow): LoungeWorkNote {
  return {
    revision: row.revision,
    role: row.role,
    currentState: row.current_state,
    lastCompleted: row.last_completed,
    blocker: row.blocker,
    nextSafeAction: row.next_safe_action,
    updatedAtMs: row.updated_at_ms,
  };
}

interface MemberWorkNoteRow {
  lounge_id: string;
  agent_id: string;
  revision: number | null;
  role: string | null;
  current_state: string | null;
  last_completed: string | null;
  blocker: string | null;
  next_safe_action: string | null;
  updated_at_ms: number | null;
}

function noteFromMemberRow(row: MemberWorkNoteRow): LoungeWorkNote | null {
  if (row.revision === null) return null;
  if (
    row.role === null ||
    row.current_state === null ||
    row.next_safe_action === null ||
    row.updated_at_ms === null
  ) {
    throw new LoungeStoreError(
      'LOUNGE_STORE_FAILURE',
      'The durable Lounge work note is incomplete.',
    );
  }
  return {
    revision: row.revision,
    role: row.role,
    currentState: row.current_state,
    lastCompleted: row.last_completed,
    blocker: row.blocker,
    nextSafeAction: row.next_safe_action,
    updatedAtMs: row.updated_at_ms,
  };
}

export const workNoteOperations = {
  workNote(input: LoungeWorkNoteInput): LoungeWorkNoteState {
    assertIdentifier(input.sessionId, 'sessionId');
    const session = this.requireSession(input.sessionId);
    return this.currentWorkNote(session.lounge_id, session.agent_id);
  },

  setWorkNote(input: LoungeSetWorkNoteInput): LoungeSetWorkNoteResult {
    assertIdentifier(input.sessionId, 'sessionId');
    assertBoundedText(input.idempotencyKey, 'idempotencyKey', 120);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new LoungeStoreError(
        'INVALID_ARGUMENT',
        'expectedRevision must be a non-negative safe integer.',
      );
    }
    const note = normalizedWorkNote(input.note);
    const nowMs = operationTime(input.nowMs);
    const session = this.requireSession(input.sessionId);
    const payloadHash = workNotePayloadHash({ note, expectedRevision: input.expectedRevision });

    return this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT
          lounge_id,
          agent_id,
          payload_hash,
          revision,
          role,
          current_state,
          last_completed,
          blocker,
          next_safe_action,
          created_at_ms AS updated_at_ms
        FROM lounge_work_note_mutations
        WHERE lounge_id = ? AND agent_id = ? AND idempotency_key = ?
      `).get(
        session.lounge_id,
        session.agent_id,
        input.idempotencyKey,
      ) as WorkNoteMutationRow | undefined;
      if (existing !== undefined) {
        if (existing.payload_hash !== payloadHash) {
          throw new LoungeStoreError(
            'IDEMPOTENCY_CONFLICT',
            'The idempotency key was already used for a different work-note mutation.',
          );
        }
        return {
          loungeId: session.lounge_id,
          agentId: session.agent_id,
          workNoteRevision: existing.revision,
          workNote: noteFromRow(existing),
          duplicate: true,
        };
      }

      const current = this.currentWorkNote(session.lounge_id, session.agent_id);
      if (current.workNoteRevision !== input.expectedRevision) {
        throw new LoungeStoreError(
          'WORK_NOTE_REVISION_CONFLICT',
          'The durable work note changed since it was last observed.',
          { currentRevision: current.workNoteRevision },
        );
      }
      const revision = current.workNoteRevision + 1;
      const values = [
        session.lounge_id,
        session.agent_id,
        revision,
        note.role,
        note.currentState,
        note.lastCompleted,
        note.blocker,
        note.nextSafeAction,
        nowMs,
      ] as const;
      this.database.prepare(`
        INSERT INTO lounge_work_notes (
          lounge_id,
          agent_id,
          revision,
          role,
          current_state,
          last_completed,
          blocker,
          next_safe_action,
          updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(lounge_id, agent_id) DO UPDATE SET
          revision = excluded.revision,
          role = excluded.role,
          current_state = excluded.current_state,
          last_completed = excluded.last_completed,
          blocker = excluded.blocker,
          next_safe_action = excluded.next_safe_action,
          updated_at_ms = excluded.updated_at_ms
      `).run(...values);
      this.database.prepare(`
        INSERT INTO lounge_work_note_mutations (
          lounge_id,
          agent_id,
          idempotency_key,
          payload_hash,
          revision,
          role,
          current_state,
          last_completed,
          blocker,
          next_safe_action,
          created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.lounge_id,
        session.agent_id,
        input.idempotencyKey,
        payloadHash,
        revision,
        note.role,
        note.currentState,
        note.lastCompleted,
        note.blocker,
        note.nextSafeAction,
        nowMs,
      );
      if (revision > MAX_WORK_NOTE_MUTATIONS_PER_IDENTITY) {
        this.database.prepare(`
          DELETE FROM lounge_work_note_mutations
          WHERE lounge_id = ? AND agent_id = ? AND revision <= ?
        `).run(
          session.lounge_id,
          session.agent_id,
          revision - MAX_WORK_NOTE_MUTATIONS_PER_IDENTITY,
        );
      }
      return {
        loungeId: session.lounge_id,
        agentId: session.agent_id,
        workNoteRevision: revision,
        workNote: { revision, ...note, updatedAtMs: nowMs },
        duplicate: false,
      };
    });
  },

  currentWorkNote(loungeId: string, agentId: string): LoungeWorkNoteState {
    const row = this.database.prepare(`
      SELECT
        lounge_id,
        agent_id,
        revision,
        role,
        current_state,
        last_completed,
        blocker,
        next_safe_action,
        updated_at_ms
      FROM lounge_work_notes
      WHERE lounge_id = ? AND agent_id = ?
    `).get(loungeId, agentId) as WorkNoteRow | undefined;
    return {
      loungeId,
      agentId,
      workNoteRevision: row?.revision ?? 0,
      workNote: row === undefined ? null : noteFromRow(row),
    };
  },

  memberWorkNotes(loungeId: string): LoungeMemberWorkNoteState[] {
    const rows = this.database.prepare(`
      SELECT
        membership.lounge_id,
        membership.agent_id,
        note.revision,
        note.role,
        note.current_state,
        note.last_completed,
        note.blocker,
        note.next_safe_action,
        note.updated_at_ms
      FROM memberships membership
      LEFT JOIN lounge_work_notes note ON
        note.lounge_id = membership.lounge_id AND note.agent_id = membership.agent_id
      WHERE membership.lounge_id = ? AND membership.left_at_ms IS NULL
      ORDER BY membership.agent_id
    `).all(loungeId) as unknown as MemberWorkNoteRow[];
    return rows.map((row) => ({
      loungeId: row.lounge_id,
      agentId: row.agent_id,
      workNoteRevision: row.revision ?? 0,
      workNote: noteFromMemberRow(row),
    }));
  },
} satisfies Record<string, unknown> & ThisType<LoungeStoreContext>;

export type WorkNoteOperations = typeof workNoteOperations;
