import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Stage5BrowserError } from '../src/errors.js';
import { LoungeService } from '../src/lounge-service.js';

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
});
