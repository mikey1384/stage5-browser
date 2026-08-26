import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Stage5BrowserConfig } from '../src/config.js';
import { BrowserSupervisor } from '../src/supervisor.js';

const roots: string[] = [];
const supervisors: BrowserSupervisor[] = [];

afterEach(async () => {
  await Promise.allSettled(supervisors.splice(0).map((supervisor) => supervisor.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function configFor(root: string): Stage5BrowserConfig {
  const profilesDir = path.join(root, 'profiles');
  return {
    browser: 'chromium',
    browserExecutablePath: null,
    profilesDir,
    profileDir: path.join(profilesDir, 'default'),
    artifactsDir: path.join(root, 'artifacts'),
    headless: true,
    operationTimeoutMs: 1_000,
    navigationTimeoutMs: 1_000,
    readinessTimeoutMs: 500,
    workerStartupTimeoutMs: 2_000,
    workerShutdownGraceMs: 200,
  };
}

function supervisorFor(config: Stage5BrowserConfig): BrowserSupervisor {
  const supervisor = new BrowserSupervisor(config, {
    workerUrl: new URL('./fixtures/fake-worker.mjs', import.meta.url),
    expectedBuildFingerprint: 'fake-worker',
  });
  supervisors.push(supervisor);
  return supervisor;
}

describe('BrowserSupervisor durable agent context', () => {
  it('binds agent context without waiting behind a hung browser operation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-agent-context-lane-'));
    roots.push(root);
    const supervisor = supervisorFor(configFor(root));
    const hanging = supervisor.execute('testHang', {}, 500);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const binding = await Promise.race([
      supervisor.bindAgentContext('youtube-agent'),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('Agent context waited behind the browser queue.')), 250);
      }),
    ]);
    expect(binding).toMatchObject({ state: 'bound', browser: 'chromium' });
    await expect(hanging).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
  });

  it('restores each Lounge agent browser and review policy without a global last-browser race', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-agent-context-'));
    roots.push(root);
    const config = configFor(root);

    const youtubeBeforeReconnect = supervisorFor(config);
    await expect(youtubeBeforeReconnect.bindAgentContext('youtube-agent')).resolves.toMatchObject({
      state: 'bound',
      browser: 'chromium',
      browserSource: 'configured_default',
      privacy: 'browser_and_policy_only',
    });
    await youtubeBeforeReconnect.execute('start', { browser: 'chrome' });
    await youtubeBeforeReconnect.execute('setPolicy', { mode: 'review_only' });
    await youtubeBeforeReconnect.close();

    const finance = supervisorFor(config);
    await expect(finance.bindAgentContext('finance-agent')).resolves.toMatchObject({
      state: 'bound',
      browser: 'chromium',
    });
    await finance.execute('start', { browser: 'brave' });
    await finance.close();

    const youtubeAfterReconnect = supervisorFor(config);
    await expect(youtubeAfterReconnect.execute('status', {})).resolves.toMatchObject({
      result: { browser: 'chromium', browserConnected: false },
    });
    await expect(youtubeAfterReconnect.bindAgentContext('youtube-agent')).resolves.toMatchObject({
      state: 'pending_reconcile',
      browser: 'chrome',
      browserSource: 'durable_agent_context',
      actionPolicyMode: 'review_only',
      policySource: 'durable_agent_context',
    });
    await expect(youtubeAfterReconnect.execute('status', {})).resolves.toMatchObject({
      result: {
        browser: 'chrome',
        state: 'stopped',
        browserConnected: false,
      },
    });
    await expect(youtubeAfterReconnect.execute('policyStatus', {})).resolves.toMatchObject({
      result: { mode: 'review_only' },
    });

    const financeAfterReconnect = supervisorFor(config);
    await expect(financeAfterReconnect.bindAgentContext('finance-agent')).resolves.toMatchObject({
      state: 'restored',
      browser: 'brave',
      actionPolicyMode: 'normal',
    });
  });
});
