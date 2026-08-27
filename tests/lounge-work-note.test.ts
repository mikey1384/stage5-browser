import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { LoungeStoreClient } from '../src/lounge-store-client.js';
import { LoungeStoreError, type LoungeWorkNoteFields } from '../src/lounge-types.js';

const roots: string[] = [];
const clients: LoungeStoreClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => client.close()));
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-lounge-work-note-'));
  roots.push(root);
  return path.join(root, 'lounge.sqlite3');
}

function store(databasePath: string, managerAgentIds: string[] = []): LoungeStoreClient {
  const value = new LoungeStoreClient({ databasePath, managerAgentIds });
  clients.push(value);
  return value;
}

async function join(
  client: LoungeStoreClient,
  agentId: string,
  clientInstanceId: string,
  nowMs: number,
) {
  return client.join({
    loungeId: 'stage5-lounge',
    agentId,
    displayName: agentId,
    provider: 'codex',
    clientInstanceId,
    nowMs,
    leaseMs: 60_000,
  });
}

const initialNote: LoungeWorkNoteFields = {
  role: 'Finance Agent dogfooding business onboarding',
  currentState: 'Account workflow frozen after one possible opener input.',
  lastCompleted: 'Two authorized corrections were reconciled exactly once.',
  blocker: 'Popup ownership is not yet proven.',
  nextSafeAction: 'Adopt the next validated worker and begin with passive state only.',
};

describe('Agent Lounge durable work notes', () => {
  it('rehydrates one exact revision across identity replacement and rejects stale writers', async () => {
    const databasePath = await fixture();
    const firstStore = store(databasePath);
    const replacementStore = store(databasePath);
    const managerStore = store(databasePath, ['browser_developer']);
    const first = await join(firstStore, 'finance-agent', 'finance-first', 1_000);
    const manager = await join(managerStore, 'browser_developer', 'browser-manager', 1_010);

    await expect(firstStore.workNote({ sessionId: first.sessionId })).resolves.toEqual({
      loungeId: 'stage5-lounge',
      agentId: 'finance-agent',
      workNoteRevision: 0,
      workNote: null,
    });
    const input = {
      sessionId: first.sessionId,
      note: initialNote,
      expectedRevision: 0,
      idempotencyKey: 'finance-work-note-1',
      nowMs: 1_020,
    };
    const written = await firstStore.setWorkNote(input);
    expect(written).toEqual({
      loungeId: 'stage5-lounge',
      agentId: 'finance-agent',
      workNoteRevision: 1,
      workNote: { revision: 1, ...initialNote, updatedAtMs: 1_020 },
      duplicate: false,
    });
    await expect(firstStore.setWorkNote({ ...input, nowMs: 1_030 })).resolves.toEqual({
      ...written,
      duplicate: true,
    });
    await expect(firstStore.setWorkNote({
      ...input,
      note: { ...initialNote, currentState: 'A conflicting retry.' },
      nowMs: 1_040,
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' } satisfies Partial<LoungeStoreError>);

    const replacement = await join(
      replacementStore,
      'finance-agent',
      'finance-replacement',
      1_050,
    );
    await expect(replacementStore.workNote({ sessionId: replacement.sessionId })).resolves.toEqual({
      loungeId: 'stage5-lounge',
      agentId: 'finance-agent',
      workNoteRevision: 1,
      workNote: { revision: 1, ...initialNote, updatedAtMs: 1_020 },
    });
    await expect(firstStore.setWorkNote({
      ...input,
      expectedRevision: 1,
      idempotencyKey: 'superseded-writer',
      nowMs: 1_060,
    })).rejects.toMatchObject({ code: 'SESSION_CLOSED' } satisfies Partial<LoungeStoreError>);
    await expect(replacementStore.setWorkNote({
      sessionId: replacement.sessionId,
      note: { ...initialNote, currentState: 'Stale update.' },
      expectedRevision: 0,
      idempotencyKey: 'stale-revision',
      nowMs: 1_070,
    })).rejects.toMatchObject({
      code: 'WORK_NOTE_REVISION_CONFLICT',
      details: { currentRevision: 1 },
    } satisfies Partial<LoungeStoreError>);

    const nextNote: LoungeWorkNoteFields = {
      ...initialNote,
      currentState: 'Waiting safely with no browser operation in flight.',
      blocker: null,
      nextSafeAction: 'Remain wakeable in the Lounge.',
    };
    await expect(replacementStore.setWorkNote({
      sessionId: replacement.sessionId,
      note: nextNote,
      expectedRevision: 1,
      idempotencyKey: 'finance-work-note-2',
      nowMs: 1_080,
    })).resolves.toMatchObject({
      workNoteRevision: 2,
      workNote: { revision: 2, ...nextNote, updatedAtMs: 1_080 },
      duplicate: false,
    });

    await expect(replacementStore.status({
      sessionId: replacement.sessionId,
      nowMs: 1_090,
    })).resolves.toMatchObject({
      workNoteRevision: 2,
      workNote: { revision: 2, ...nextNote },
      memberWorkNotes: null,
    });
    await expect(managerStore.status({ sessionId: manager.sessionId, nowMs: 1_100 }))
      .resolves.toMatchObject({
        workNoteRevision: 0,
        workNote: null,
        memberWorkNotes: expect.arrayContaining([
          expect.objectContaining({
            agentId: 'finance-agent',
            workNoteRevision: 2,
            workNote: { revision: 2, ...nextNote, updatedAtMs: 1_080 },
          }),
          expect.objectContaining({
            agentId: 'browser_developer',
            workNoteRevision: 0,
            workNote: null,
          }),
        ]),
      });
  });

  it('enforces bounded, non-empty sanitized handoff fields', async () => {
    const databasePath = await fixture();
    const agentStore = store(databasePath);
    const agent = await join(agentStore, 'bounded-agent', 'bounded-client', 2_000);

    await expect(agentStore.setWorkNote({
      sessionId: agent.sessionId,
      note: { ...initialNote, blocker: '   ' },
      expectedRevision: 0,
      idempotencyKey: 'empty-field',
      nowMs: 2_010,
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' } satisfies Partial<LoungeStoreError>);
    await expect(agentStore.setWorkNote({
      sessionId: agent.sessionId,
      note: {
        role: '界'.repeat(200),
        currentState: '界'.repeat(1_000),
        lastCompleted: '界'.repeat(1_000),
        blocker: '界'.repeat(1_000),
        nextSafeAction: '界'.repeat(1_000),
      },
      expectedRevision: 0,
      idempotencyKey: 'oversize-utf8',
      nowMs: 2_020,
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' } satisfies Partial<LoungeStoreError>);
  });

  it('bounds idempotency receipts without weakening the current revision', async () => {
    const databasePath = await fixture();
    const agentStore = store(databasePath);
    const agent = await join(agentStore, 'active-agent', 'active-client', 3_000);

    for (let revision = 1; revision <= 260; revision += 1) {
      await agentStore.setWorkNote({
        sessionId: agent.sessionId,
        note: { ...initialNote, currentState: `Sanitized transition ${revision}.` },
        expectedRevision: revision - 1,
        idempotencyKey: `bounded-receipt-${revision}`,
        nowMs: 3_000 + revision,
      });
    }

    await expect(agentStore.workNote({ sessionId: agent.sessionId })).resolves.toMatchObject({
      workNoteRevision: 260,
      workNote: { revision: 260, currentState: 'Sanitized transition 260.' },
    });
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database.prepare(`
        SELECT COUNT(*) AS count, MIN(revision) AS minimum_revision
        FROM lounge_work_note_mutations
        WHERE lounge_id = ? AND agent_id = ?
      `).get('stage5-lounge', 'active-agent') as { count: number; minimum_revision: number };
      expect(row).toEqual({ count: 256, minimum_revision: 5 });
    } finally {
      database.close();
    }
  });
});
