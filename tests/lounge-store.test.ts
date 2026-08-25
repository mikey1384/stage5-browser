import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

function client(databasePath: string): LoungeStoreClient {
  const value = new LoungeStoreClient({ databasePath });
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
