import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { LoungeStoreClient } from '../src/lounge-store-client.js';
import { LoungeStoreError } from '../src/lounge-types.js';

const roots: string[] = [];
const clients: LoungeStoreClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => client.close()));
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

async function storeFixture(): Promise<{ root: string; databasePath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-lounge-store-'));
  roots.push(root);
  return { root, databasePath: path.join(root, 'lounge.sqlite3') };
}

function client(databasePath: string, managerAgentIds: string[] = []): LoungeStoreClient {
  const value = new LoungeStoreClient({ databasePath, managerAgentIds });
  clients.push(value);
  return value;
}

async function join(
  store: LoungeStoreClient,
  agentId: string,
  nowMs: number,
  loungeId = 'stage5-lounge',
) {
  return store.join({
    loungeId,
    agentId,
    displayName: agentId,
    provider: agentId.includes('youtube') ? 'claude' : 'codex',
    clientInstanceId: `client-${agentId}`,
    nowMs,
    leaseMs: 60_000,
  });
}

describe('LoungeStoreClient', () => {
  it('durably broadcasts to current members with at-least-once delivery and monotonic acknowledgement', async () => {
    const { databasePath } = await storeFixture();
    const browserStore = client(databasePath);
    const youtubeStore = client(databasePath);
    const financeStore = client(databasePath);
    const browser = await join(browserStore, 'browser-agent', 1_000);
    const youtube = await join(youtubeStore, 'youtube-agent', 1_010);
    const finance = await join(financeStore, 'finance-agent', 1_020);

    await youtubeStore.heartbeat({
      sessionId: youtube.sessionId,
      state: 'listening',
      leaseMs: 60_000,
      nowMs: 1_030,
    });
    await financeStore.heartbeat({
      sessionId: finance.sessionId,
      state: 'processing',
      leaseMs: 60_000,
      nowMs: 1_040,
    });
    const sent = await browserStore.send({
      sessionId: browser.sessionId,
      kind: 'dependency_resolved',
      body: 'The browser repair is ready. Take a fresh snapshot and resume.',
      idempotencyKey: 'browser-fix-075',
      taskKey: 'facebook-editor-fill',
      nowMs: 1_050,
    });

    expect(sent).toMatchObject({
      duplicate: false,
      recipientAgentIds: ['finance-agent', 'youtube-agent'],
    });
    const firstYoutubeDelivery = await youtubeStore.claimInbox({
      sessionId: youtube.sessionId,
      nowMs: 1_060,
    });
    expect(firstYoutubeDelivery.messages).toEqual([
      expect.objectContaining({
        messageId: sent.messageId,
        senderAgentId: 'browser-agent',
        kind: 'dependency_resolved',
        deliveryState: 'delivered',
        deliveryAttempt: 1,
        authority: 'coordination_only',
      }),
    ]);
    const redelivery = await youtubeStore.claimInbox({
      sessionId: youtube.sessionId,
      nowMs: 1_070,
    });
    expect(redelivery.messages[0]).toMatchObject({
      messageId: sent.messageId,
      deliveryAttempt: 2,
    });

    await youtubeStore.ack({
      sessionId: youtube.sessionId,
      messageIds: [sent.messageId],
      state: 'seen',
      nowMs: 1_080,
    });
    await youtubeStore.ack({
      sessionId: youtube.sessionId,
      messageIds: [sent.messageId],
      state: 'acted',
      nowMs: 1_090,
    });
    const noDowngrade = await youtubeStore.ack({
      sessionId: youtube.sessionId,
      messageIds: [sent.messageId],
      state: 'seen',
      nowMs: 1_100,
    });
    expect(noDowngrade.acknowledgements).toEqual([
      {
        messageId: sent.messageId,
        previousState: 'acted',
        state: 'acted',
        changed: false,
      },
    ]);
    expect(
      (await youtubeStore.claimInbox({ sessionId: youtube.sessionId, nowMs: 1_110 })).messages,
    ).toEqual([]);

    const status = await browserStore.status({ sessionId: browser.sessionId, nowMs: 1_120 });
    expect(status.members).toEqual([
      expect.objectContaining({ agentId: 'browser-agent', presence: 'connected_non_wakeable' }),
      expect.objectContaining({ agentId: 'finance-agent', presence: 'processing', pendingMessages: 1 }),
      expect.objectContaining({ agentId: 'youtube-agent', presence: 'listening' }),
    ]);
    expect(status.recentSentMessages[0]).toMatchObject({
      messageId: sent.messageId,
      recipients: [
        expect.objectContaining({ agentId: 'finance-agent', state: 'pending' }),
        expect.objectContaining({ agentId: 'youtube-agent', state: 'acted' }),
      ],
    });
  });

  it('makes send retries idempotent and rejects reuse with a different payload', async () => {
    const { databasePath } = await storeFixture();
    const senderStore = client(databasePath);
    const receiverStore = client(databasePath);
    const sender = await join(senderStore, 'sender-agent', 2_000);
    await join(receiverStore, 'receiver-agent', 2_010);
    const request = {
      sessionId: sender.sessionId,
      kind: 'finding' as const,
      body: 'A deterministic finding.',
      toAgentIds: ['receiver-agent'],
      idempotencyKey: 'finding-001',
      nowMs: 2_020,
    };

    const first = await senderStore.send(request);
    const retry = await senderStore.send({ ...request, nowMs: 2_030 });
    expect(retry).toEqual({ ...first, duplicate: true });
    await expect(senderStore.send({
      ...request,
      body: 'A different finding.',
      nowMs: 2_040,
    })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    } satisfies Partial<LoungeStoreError>);
  });

  it('keeps direct messages queued while a member is offline and delivers after rejoin', async () => {
    const { databasePath } = await storeFixture();
    const senderStore = client(databasePath);
    const receiverStore = client(databasePath);
    const sender = await join(senderStore, 'sender-agent', 3_000);
    const firstReceiver = await join(receiverStore, 'receiver-agent', 3_010);
    await receiverStore.closeSession({ sessionId: firstReceiver.sessionId, nowMs: 3_020 });

    const sent = await senderStore.send({
      sessionId: sender.sessionId,
      kind: 'handoff',
      body: 'Resume this task when you reconnect.',
      toAgentIds: ['receiver-agent'],
      idempotencyKey: 'offline-handoff',
      nowMs: 3_030,
    });
    await expect(receiverStore.claimInbox({
      sessionId: firstReceiver.sessionId,
      nowMs: 3_040,
    })).rejects.toMatchObject({ code: 'SESSION_CLOSED' } satisfies Partial<LoungeStoreError>);

    const resumedReceiver = await join(receiverStore, 'receiver-agent', 3_050);
    const inbox = await receiverStore.claimInbox({
      sessionId: resumedReceiver.sessionId,
      nowMs: 3_060,
    });
    expect(inbox.messages).toEqual([
      expect.objectContaining({ messageId: sent.messageId, kind: 'handoff' }),
    ]);
  });

  it('serializes competing writers through the shared WAL database and protects file access', async () => {
    const { root, databasePath } = await storeFixture();
    const firstStore = client(databasePath);
    const secondStore = client(databasePath);
    const first = await join(firstStore, 'first-agent', 4_000);
    const second = await join(secondStore, 'second-agent', 4_010);

    const [fromFirst, fromSecond] = await Promise.all([
      firstStore.send({
        sessionId: first.sessionId,
        kind: 'question',
        body: 'Are you ready?',
        idempotencyKey: 'question-001',
        nowMs: 4_020,
      }),
      secondStore.send({
        sessionId: second.sessionId,
        kind: 'answer',
        body: 'Ready.',
        idempotencyKey: 'answer-001',
        nowMs: 4_020,
      }),
    ]);

    expect(fromFirst.sequence).not.toBe(fromSecond.sequence);
    expect((await firstStore.claimInbox({ sessionId: first.sessionId })).messages).toEqual([
      expect.objectContaining({ messageId: fromSecond.messageId }),
    ]);
    expect((await secondStore.claimInbox({ sessionId: second.sessionId })).messages).toEqual([
      expect.objectContaining({ messageId: fromFirst.messageId }),
    ]);
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it('supersedes an older same-agent session and expires wakeable presence truthfully', async () => {
    const { databasePath } = await storeFixture();
    const observerStore = client(databasePath);
    const originalStore = client(databasePath);
    const replacementStore = client(databasePath);
    const observer = await join(observerStore, 'observer-agent', 5_000);
    const original = await join(originalStore, 'youtube-agent', 5_010);
    await originalStore.heartbeat({
      sessionId: original.sessionId,
      state: 'listening',
      leaseMs: 1_000,
      nowMs: 5_020,
    });
    expect(
      (await observerStore.status({ sessionId: observer.sessionId, nowMs: 5_500 })).members,
    ).toContainEqual(expect.objectContaining({ agentId: 'youtube-agent', presence: 'listening' }));
    expect(
      (await observerStore.status({ sessionId: observer.sessionId, nowMs: 6_021 })).members,
    ).toContainEqual(expect.objectContaining({ agentId: 'youtube-agent', presence: 'offline' }));

    const replacement = await join(replacementStore, 'youtube-agent', 6_030);
    expect(replacement.supersededSessionCount).toBe(1);
    await expect(originalStore.status({ sessionId: original.sessionId })).rejects.toMatchObject({
      code: 'SESSION_CLOSED',
    } satisfies Partial<LoungeStoreError>);
  });

  it('scopes delivery counts to the requested Lounge', async () => {
    const { databasePath } = await storeFixture();
    const sharedAgentStore = client(databasePath);
    const firstSenderStore = client(databasePath);
    const secondSenderStore = client(databasePath);
    const firstSharedSession = await join(sharedAgentStore, 'shared-agent', 6_000, 'first-lounge');
    const firstSender = await join(firstSenderStore, 'first-sender', 6_010, 'first-lounge');
    await firstSenderStore.send({
      sessionId: firstSender.sessionId,
      kind: 'message',
      body: 'First room.',
      idempotencyKey: 'first room / message 1',
      nowMs: 6_020,
    });

    const secondSharedSession = await join(sharedAgentStore, 'shared-agent', 6_030, 'second-lounge');
    const secondSender = await join(secondSenderStore, 'second-sender', 6_040, 'second-lounge');
    await secondSenderStore.send({
      sessionId: secondSender.sessionId,
      kind: 'message',
      body: 'Second room.',
      idempotencyKey: 'second room / message 1',
      nowMs: 6_050,
    });

    const firstStatus = await firstSenderStore.status({
      sessionId: firstSender.sessionId,
      nowMs: 6_060,
    });
    const secondStatus = await secondSenderStore.status({
      sessionId: secondSender.sessionId,
      nowMs: 6_060,
    });
    expect(firstStatus.members).toContainEqual(expect.objectContaining({
      agentId: 'shared-agent',
      pendingMessages: 1,
    }));
    expect(secondStatus.members).toContainEqual(expect.objectContaining({
      agentId: 'shared-agent',
      pendingMessages: 1,
    }));
    expect(firstSharedSession.loungeId).toBe('first-lounge');
    expect(secondSharedSession.loungeId).toBe('second-lounge');
  });

  it('scopes sender idempotency keys to one Lounge', async () => {
    const { databasePath } = await storeFixture();
    const senderStore = client(databasePath);
    const firstReceiverStore = client(databasePath);
    const secondReceiverStore = client(databasePath);
    const firstSender = await join(senderStore, 'shared-sender', 7_000, 'first-lounge');
    await join(firstReceiverStore, 'first-receiver', 7_010, 'first-lounge');
    const secondSender = await join(senderStore, 'shared-sender', 7_020, 'second-lounge');
    await join(secondReceiverStore, 'second-receiver', 7_030, 'second-lounge');

    const first = await senderStore.send({
      sessionId: firstSender.sessionId,
      kind: 'message',
      body: 'First room message.',
      idempotencyKey: 'shared-key',
      nowMs: 7_040,
    });
    const second = await senderStore.send({
      sessionId: secondSender.sessionId,
      kind: 'message',
      body: 'Second room message.',
      idempotencyKey: 'shared-key',
      nowMs: 7_050,
    });

    expect(first.messageId).not.toBe(second.messageId);
    expect(first.loungeId).toBe('first-lounge');
    expect(second.loungeId).toBe('second-lounge');
  });

  it('updates one revisioned pinned notice only for configured managers', async () => {
    const { databasePath } = await storeFixture();
    const managerStore = client(databasePath, ['ghostty-codex']);
    const memberStore = client(databasePath);
    const manager = await join(managerStore, 'ghostty-codex', 8_000);
    const member = await join(memberStore, 'youtube-agent', 8_010);

    await expect(memberStore.notice({ sessionId: member.sessionId })).resolves.toEqual({
      loungeId: 'stage5-lounge',
      noticeRevision: 0,
      pinnedNotice: null,
    });
    const pinned = await managerStore.pin({
      sessionId: manager.sessionId,
      body: 'Route Stage5 Browser defects to ghostty-codex.',
      expectedRevision: 0,
      idempotencyKey: 'pin-coordinator-routing',
      nowMs: 8_020,
    });
    expect(pinned).toEqual({
      loungeId: 'stage5-lounge',
      requestingAgentId: 'ghostty-codex',
      noticeRevision: 1,
      pinnedNotice: {
        revision: 1,
        body: 'Route Stage5 Browser defects to ghostty-codex.',
        pinnedByAgentId: 'ghostty-codex',
        pinnedAtMs: 8_020,
      },
      duplicate: false,
    });
    await expect(managerStore.pin({
      sessionId: manager.sessionId,
      body: 'Route Stage5 Browser defects to ghostty-codex.',
      expectedRevision: 0,
      idempotencyKey: 'pin-coordinator-routing',
      nowMs: 8_030,
    })).resolves.toEqual({ ...pinned, duplicate: true });
    await expect(managerStore.pin({
      sessionId: manager.sessionId,
      body: 'A conflicting notice.',
      expectedRevision: 0,
      idempotencyKey: 'pin-coordinator-routing',
      nowMs: 8_040,
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' } satisfies Partial<LoungeStoreError>);
    await expect(managerStore.pin({
      sessionId: manager.sessionId,
      body: 'A stale compare-and-set update.',
      expectedRevision: 0,
      idempotencyKey: 'stale-pin-update',
      nowMs: 8_050,
    })).rejects.toMatchObject({
      code: 'NOTICE_REVISION_CONFLICT',
      details: { currentRevision: 1 },
    } satisfies Partial<LoungeStoreError>);
    await expect(memberStore.pin({
      sessionId: member.sessionId,
      body: 'An unauthorized notice.',
      expectedRevision: 1,
      idempotencyKey: 'unauthorized-pin',
      nowMs: 8_060,
    })).rejects.toMatchObject({ code: 'MANAGER_ACCESS_REQUIRED' } satisfies Partial<LoungeStoreError>);

    const cleared = await managerStore.pin({
      sessionId: manager.sessionId,
      body: null,
      expectedRevision: 1,
      idempotencyKey: 'clear-coordinator-routing',
      nowMs: 8_070,
    });
    expect(cleared).toMatchObject({ noticeRevision: 2, pinnedNotice: null, duplicate: false });
    await expect(memberStore.notice({ sessionId: member.sessionId })).resolves.toEqual({
      loungeId: 'stage5-lounge',
      noticeRevision: 2,
      pinnedNotice: null,
    });
  });

  it('gives configured managers audited room-wide history without claiming deliveries', async () => {
    const { databasePath } = await storeFixture();
    const managerStore = client(databasePath, ['ghostty-codex']);
    const youtubeStore = client(databasePath);
    const financeStore = client(databasePath);
    const manager = await join(managerStore, 'ghostty-codex', 9_000);
    const youtube = await join(youtubeStore, 'youtube-agent', 9_010);
    const finance = await join(financeStore, 'finance-agent', 9_020);

    const first = await youtubeStore.send({
      sessionId: youtube.sessionId,
      kind: 'blocker',
      body: 'First direct blocker.',
      toAgentIds: ['finance-agent'],
      idempotencyKey: 'history-first',
      nowMs: 9_030,
    });
    const second = await financeStore.send({
      sessionId: finance.sessionId,
      kind: 'answer',
      body: 'Second direct answer.',
      toAgentIds: ['youtube-agent'],
      idempotencyKey: 'history-second',
      nowMs: 9_040,
    });
    const third = await youtubeStore.send({
      sessionId: youtube.sessionId,
      kind: 'completion',
      body: 'Third direct completion.',
      toAgentIds: ['finance-agent'],
      idempotencyKey: 'history-third',
      nowMs: 9_050,
    });

    const latest = await managerStore.history({
      sessionId: manager.sessionId,
      limit: 2,
      nowMs: 9_060,
    });
    expect(latest.messages.map((message) => message.messageId)).toEqual([
      second.messageId,
      third.messageId,
    ]);
    expect(latest).toMatchObject({
      loungeId: 'stage5-lounge',
      requestingAgentId: 'ghostty-codex',
      auditedAtMs: 9_060,
      page: {
        limit: 2,
        oldestSequence: second.sequence,
        newestSequence: third.sequence,
        hasOlder: true,
        hasNewer: false,
      },
      messages: [
        expect.objectContaining({
          body: 'Second direct answer.',
          recipients: [expect.objectContaining({ agentId: 'youtube-agent', state: 'pending' })],
          authority: 'coordination_only',
        }),
        expect.objectContaining({
          body: 'Third direct completion.',
          recipients: [expect.objectContaining({ agentId: 'finance-agent', state: 'pending' })],
          authority: 'coordination_only',
        }),
      ],
    });
    const older = await managerStore.history({
      sessionId: manager.sessionId,
      beforeSequence: second.sequence,
      limit: 2,
      nowMs: 9_070,
    });
    expect(older.messages).toEqual([
      expect.objectContaining({ messageId: first.messageId, body: 'First direct blocker.' }),
    ]);
    expect(older.page).toMatchObject({ hasOlder: false, hasNewer: true });
    const newer = await managerStore.history({
      sessionId: manager.sessionId,
      afterSequence: first.sequence,
      limit: 1,
      nowMs: 9_080,
    });
    expect(newer.messages).toEqual([expect.objectContaining({ messageId: second.messageId })]);
    expect(newer.page).toMatchObject({ hasOlder: true, hasNewer: true });
    expect(new Set([latest.auditId, older.auditId, newer.auditId]).size).toBe(3);

    const financeInbox = await financeStore.claimInbox({
      sessionId: finance.sessionId,
      nowMs: 9_090,
    });
    expect(financeInbox.messages.map((message) => message.messageId)).toEqual([
      first.messageId,
      third.messageId,
    ]);
    await expect(financeStore.history({
      sessionId: finance.sessionId,
      limit: 10,
      nowMs: 9_100,
    })).rejects.toMatchObject({ code: 'MANAGER_ACCESS_REQUIRED' } satisfies Partial<LoungeStoreError>);

    const auditDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const audits = auditDatabase.prepare(`
        SELECT manager_agent_id, result_count
        FROM lounge_history_audits
        ORDER BY created_at_ms
      `).all() as unknown as Array<{ manager_agent_id: string; result_count: number }>;
      expect(audits).toEqual([
        { manager_agent_id: 'ghostty-codex', result_count: 2 },
        { manager_agent_id: 'ghostty-codex', result_count: 1 },
        { manager_agent_id: 'ghostty-codex', result_count: 1 },
      ]);
    } finally {
      auditDatabase.close();
    }
  });

  it('fails a stalled store worker within a bounded client deadline', async () => {
    const { databasePath } = await storeFixture();
    const stalled = new LoungeStoreClient({
      databasePath,
      workerUrl: pathToFileURL(path.resolve('tests/fixtures/hanging-lounge-store-worker.mjs')),
      requestTimeoutMs: 100,
    });
    clients.push(stalled);
    const startedAt = Date.now();

    await expect(stalled.status({ sessionId: 'test-session' })).rejects.toMatchObject({
      code: 'LOUNGE_STORE_TIMEOUT',
      details: { operation: 'status' },
    } satisfies Partial<LoungeStoreError>);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
