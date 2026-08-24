import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Stage5BrowserConfig } from '../src/config.js';
import type { BrowserStatus } from '../src/protocol.js';
import type { RuntimeProcessInfo } from '../src/runtime-info.js';
import { BrowserSupervisor, SupervisedOperationError } from '../src/supervisor.js';

const supervisors: BrowserSupervisor[] = [];
const temporaryRoots: string[] = [];

function configFor(root: string, overrides: Partial<Stage5BrowserConfig> = {}): Stage5BrowserConfig {
  return {
    browser: 'chromium',
    browserExecutablePath: null,
    profilesDir: path.join(root, 'profiles'),
    profileDir: path.join(root, 'profile'),
    artifactsDir: path.join(root, 'artifacts'),
    headless: true,
    operationTimeoutMs: 500,
    navigationTimeoutMs: 500,
    readinessTimeoutMs: 250,
    workerStartupTimeoutMs: 1_000,
    workerShutdownGraceMs: 100,
    ...overrides,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map(async (supervisor) => supervisor.close()));
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe('BrowserSupervisor', () => {
  it('rolls a compatible runtime forward without restarting the MCP host', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-compatible-reload-'));
    temporaryRoots.push(root);
    const environment = {
      ...process.env,
      STAGE5_BROWSER_TEST_MODE: '1',
      STAGE5_BROWSER_TEST_BUILD_FINGERPRINT: 'build-1',
    };
    let runtime: RuntimeProcessInfo = {
      component: 'mcp',
      version: '0.3.0',
      protocolVersion: 2,
      processId: 123,
      startedAt: '2026-08-24T01:00:00.000Z',
      buildModifiedAt: '2026-08-24T01:00:00.000Z',
      artifactFingerprint: 'build-1',
      currentArtifactFingerprint: 'build-1',
      currentVersion: '0.3.0',
      currentProtocolVersion: 2,
      currentToolCatalogVersion: 2,
      compatibleUpdateAvailable: false,
      restartRequired: false,
      restartReason: null,
      suggestedAction: null,
    };
    const supervisor = new BrowserSupervisor(configFor(root), {
      workerUrl: new URL('./fixtures/fake-worker.mjs', import.meta.url),
      environment,
      expectedBuildFingerprint: 'build-1',
      runtimeInfoProvider: () => runtime,
    });
    supervisors.push(supervisor);

    await supervisor.execute('start', {});
    const before = await supervisor.execute('status', {});

    environment.STAGE5_BROWSER_TEST_BUILD_FINGERPRINT = 'build-2';
    runtime = {
      ...runtime,
      currentArtifactFingerprint: 'build-2',
      currentVersion: '0.3.1',
      compatibleUpdateAvailable: true,
      suggestedAction: 'No host restart is needed.',
    };
    const after = await supervisor.execute('status', {});

    expect(after.result.workerPid).not.toBe(before.result.workerPid);
    expect(supervisor.workerRuntimeInfo).toMatchObject({
      version: '0.3.0',
      artifactFingerprint: 'build-2',
    });
  });

  it('kills and replaces a worker that exceeds the outer hard deadline', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-supervisor-'));
    temporaryRoots.push(root);
    const config = configFor(root);
    const supervisor = new BrowserSupervisor(config, {
      workerUrl: new URL('./fixtures/fake-worker.mjs', import.meta.url),
      environment: { ...process.env, STAGE5_BROWSER_TEST_MODE: '1' },
    });
    supervisors.push(supervisor);

    await supervisor.execute('switchBrowser', { browser: 'firefox' });
    const before = await supervisor.execute('status', {});
    const beforeWithDescendant = before.result as BrowserStatus & { descendantPid: number };
    expect(before.result.browser).toBe('firefox');
    expect(isProcessAlive(beforeWithDescendant.descendantPid)).toBe(true);
    let caught: unknown;
    try {
      await supervisor.execute('testHang', {}, 100);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SupervisedOperationError);
    expect(caught).toMatchObject({ code: 'OPERATION_TIMEOUT', recovery: 'succeeded' });

    const after = await supervisor.execute('status', {});
    expect(after.result.workerPid).not.toBe(before.result.workerPid);
    expect(after.result.browser).toBe('firefox');
    if (process.platform !== 'win32') {
      await waitForProcessExit(beforeWithDescendant.descendantPid);
      expect(isProcessAlive(beforeWithDescendant.descendantPid)).toBe(false);
    }

    const recovered = await supervisor.forceRecover(false);
    expect(recovered).toMatchObject({
      recovery: 'succeeded',
      outcome: 'worker_recovered_browser_stopped',
      workerRecovered: true,
      browserRecovered: false,
      status: { state: 'stopped', browserConnected: false },
    });

    const journal = await readFile(path.join(root, 'artifacts', 'operations.jsonl'), 'utf8');
    const records = journal.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.some((record) => record.outcome === 'timed_out' && record.recovery === 'succeeded')).toBe(true);
    expect(
      records.some(
        (record) =>
          record.command === 'recover' &&
          record.browserState === 'stopped' &&
          record.recovery === 'succeeded',
      ),
    ).toBe(true);
  });

  it('rejects a worker from an incompatible build with MCP_RESTART_REQUIRED', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-mismatch-'));
    temporaryRoots.push(root);
    const supervisor = new BrowserSupervisor(configFor(root), {
      workerUrl: new URL('./fixtures/mismatched-worker.mjs', import.meta.url),
      expectedBuildFingerprint: 'expected-build',
    });
    supervisors.push(supervisor);

    await expect(supervisor.execute('status', {})).rejects.toMatchObject({
      code: 'MCP_RESTART_REQUIRED',
      recovery: 'not_needed',
      details: { reason: 'worker_protocol_mismatch' },
    });
  });

  it('journals a sanitized launch cause and selected backend', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-launch-failure-'));
    temporaryRoots.push(root);
    const supervisor = new BrowserSupervisor(
      configFor(root, { browserExecutablePath: './not-an-absolute-browser-path' }),
      { workerUrl: new URL('../dist/browser-worker.js', import.meta.url) },
    );
    supervisors.push(supervisor);

    await expect(supervisor.execute('start', {})).rejects.toMatchObject({
      code: 'BROWSER_NOT_READY',
      details: {
        browser: 'chromium',
        reason: 'path_not_absolute',
        suggestedAction: expect.any(String),
      },
    });

    const journal = await readFile(path.join(root, 'artifacts', 'operations.jsonl'), 'utf8');
    const record = JSON.parse(journal.trim()) as Record<string, unknown>;
    expect(record).toMatchObject({
      command: 'start',
      outcome: 'failed',
      errorCode: 'BROWSER_NOT_READY',
      diagnosticCause: 'path_not_absolute',
      browser: 'chromium',
    });
    expect(journal).not.toContain('not-an-absolute-browser-path');
  });
});
