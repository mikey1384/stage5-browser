import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Stage5BrowserError } from '../src/errors.js';
import { LoungeService, loungeManagerAgentIds } from '../src/lounge-service.js';

const services: LoungeService[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => service.close()));
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

async function serviceFixture(agentRoot = 'stage5-lounge-service-'): Promise<LoungeService> {
  const root = await mkdtemp(path.join(os.tmpdir(), agentRoot));
  roots.push(root);
  const service = new LoungeService({
    databasePath: path.join(root, 'lounge.sqlite3'),
    pollIntervalMs: 10,
  });
  services.push(service);
  return service;
}

describe('LoungeService', () => {
  it('parses a deduplicated trusted manager allowlist and fails closed on invalid configuration', () => {
    expect(loungeManagerAgentIds({
      STAGE5_LOUNGE_MANAGER_AGENT_IDS: ' ghostty-codex,browser-agent,ghostty-codex ',
    })).toEqual(['browser-agent', 'ghostty-codex']);
    expect(loungeManagerAgentIds({
      STAGE5_LOUNGE_MANAGER_AGENT_IDS: 'ghostty-codex,invalid manager',
    })).toEqual([]);
  });

  it('defines online as a pending wake wait and returns a bounded renewal result on timeout', async () => {
    const service = await serviceFixture();
    await service.join({ agentId: 'browser-agent', provider: 'codex', room: 'stage5-lounge' });

    const result = await service.wait({ timeoutMs: 100, limit: 5 }, new AbortController().signal);
    expect(result).toMatchObject({
      agentId: 'browser-agent',
      timedOut: true,
      online: false,
      wakeable: false,
      messages: [],
      authority: 'coordination_only',
    });
    await expect(service.status()).resolves.toMatchObject({
      members: [expect.objectContaining({
        agentId: 'browser-agent',
        presence: 'connected_non_wakeable',
      })],
    });
  });

  it('cancels one wait cleanly and permits the agent to renew it', async () => {
    const service = await serviceFixture();
    await service.join({ agentId: 'youtube-agent', provider: 'claude', room: 'stage5-lounge' });
    const cancellation = new AbortController();
    const pending = service.wait({ timeoutMs: 5_000 }, cancellation.signal);
    setTimeout(() => cancellation.abort(), 30);

    await expect(pending).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'OPERATION_FAILED',
      details: { reason: 'lounge_wait_cancelled' },
    });
    await expect(service.wait(
      { timeoutMs: 100 },
      new AbortController().signal,
    )).resolves.toMatchObject({ timedOut: true, messages: [] });
  });

  it('rejects concurrent waits and identity switching on one MCP connection', async () => {
    const service = await serviceFixture();
    await service.join({ agentId: 'finance-agent', provider: 'codex', room: 'stage5-lounge' });
    const cancellation = new AbortController();
    const pending = service.wait({ timeoutMs: 5_000 }, cancellation.signal);

    await expect(service.wait(
      { timeoutMs: 100 },
      new AbortController().signal,
    )).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      details: { reason: 'lounge_wait_already_active' },
    });
    await expect(service.join({
      agentId: 'youtube-agent',
      provider: 'claude',
      room: 'stage5-lounge',
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      details: { reason: 'lounge_identity_already_bound' },
    });

    cancellation.abort();
    await pending.catch(() => undefined);
  });

  it('wakes listeners on notice revision and denies unconfigured manager operations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-lounge-notice-service-'));
    roots.push(root);
    const databasePath = path.join(root, 'lounge.sqlite3');
    const manager = new LoungeService({
      databasePath,
      managerAgentIds: ['ghostty-codex'],
      pollIntervalMs: 10,
    });
    const listener = new LoungeService({ databasePath, pollIntervalMs: 10 });
    services.push(manager, listener);

    await expect(manager.join({
      agentId: 'ghostty-codex',
      provider: 'codex',
      room: 'stage5-lounge',
    })).resolves.toMatchObject({ managerAccess: true, noticeRevision: 0, pinnedNotice: null });
    await expect(listener.join({
      agentId: 'youtube-agent',
      provider: 'claude',
      room: 'stage5-lounge',
    })).resolves.toMatchObject({ managerAccess: false, noticeRevision: 0, pinnedNotice: null });

    const pending = listener.wait({ timeoutMs: 2_000 }, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(manager.pin({
      body: 'Route browser defects to ghostty-codex.',
      expectedRevision: 0,
      idempotencyKey: 'service-pin-routing',
    })).resolves.toMatchObject({
      managerAccess: true,
      noticeRevision: 1,
      duplicate: false,
    });
    await expect(pending).resolves.toMatchObject({
      timedOut: false,
      online: true,
      messages: [],
      noticeChanged: true,
      noticeRevision: 1,
      pinnedNotice: {
        body: 'Route browser defects to ghostty-codex.',
        pinnedByAgentId: 'ghostty-codex',
      },
      authority: 'coordination_only',
    });
    await expect(listener.pin({
      body: 'Unauthorized replacement.',
      expectedRevision: 1,
      idempotencyKey: 'service-unauthorized-pin',
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      recoverable: false,
      details: { reason: 'MANAGER_ACCESS_REQUIRED' },
    });
    await expect(listener.history({ limit: 10 })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      recoverable: false,
      details: { reason: 'MANAGER_ACCESS_REQUIRED' },
    });
  });
});
