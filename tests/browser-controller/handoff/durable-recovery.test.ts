import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserController } from '../../../src/browser-controller.js';
import { playwrightBrowserType, resolveBrowserLaunchTarget } from '../../../src/browser-provider.js';
import { Stage5BrowserError } from '../../../src/errors.js';
import { stage5HandoffMarkerUrl } from '../../../src/human-auth-bootstrap.js';
import type { HumanBrowserLauncher } from '../../../src/human-auth-bootstrap.js';
import {
  nativeControlEndpoint,
  processIsRunning,
  readNativeControlRecord,
  writeNativeControlRecord,
} from '../../../src/native-control-channel.js';
import { launchIdentityForTarget } from '../../../src/profile-binding.js';
import {
  executableFingerprint,
  processStartedAtToken,
  profilePathFingerprint,
  writeProfileOwnershipLease,
} from '../../../src/profile-ownership-lease.js';
import {
  browserConfig,
  closeServer,
  listen,
  waitForDisposableDevToolsPort,
  waitForDisposableProcessExit,
} from '../../browser-controller-fixture.js';

const DEAD_WORKER_PROCESS_ID = 2_147_483_000;
const DISPOSABLE_DRAFT = 'durable handoff draft survives';

let browserProcess: ChildProcess | undefined;
let controller: BrowserController | undefined;
let root: string | undefined;
let server: Server | undefined;

afterEach(async () => {
  await controller?.stop().catch(() => undefined);
  if (browserProcess?.pid !== undefined && processIsRunning(browserProcess.pid)) {
    browserProcess.kill('SIGTERM');
    await waitForDisposableProcessExit(browserProcess.pid, 3_000);
  }
  await closeServer(server);
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  browserProcess = undefined;
  controller = undefined;
  root = undefined;
  server = undefined;
});

describe('durable private handoff recovery', () => {
  it('does not equate a Playwright context close with exact browser-process exit', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-context-close-'));
    controller = new BrowserController(browserConfig(root));
    const listeners = new Map<string, () => void>();
    const context = {
      pages: () => [],
      on: (event: string, listener: () => void) => {
        listeners.set(event, listener);
        return context;
      },
      isClosed: () => false,
    } as unknown as BrowserContext;
    const internals = controller as unknown as {
      bindContext(candidate: BrowserContext): void;
      context: BrowserContext | undefined;
      ownershipLease: { updatePhase(phase: string): Promise<void> };
      state: string;
    };
    internals.context = context;
    internals.state = 'running';
    const updatePhase = vi.spyOn(internals.ownershipLease, 'updatePhase');

    internals.bindContext(context);
    listeners.get('close')?.();
    await Promise.resolve();

    expect(updatePhase).not.toHaveBeenCalledWith('process_exited');
    expect(internals.context).toBeUndefined();
    expect(internals.state).toBe('stopped');
  });

  it('recovers an exact v1 native handoff after worker loss without relaunch or page replay', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><body><label for="draft">Draft</label><textarea id="draft"></textarea></body></html>');
    });
    const fixturePort = await listen(server);
    root = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-durable-auth-'));
    const config = browserConfig(root);
    const target = await resolveBrowserLaunchTarget({ browser: 'chromium', executablePath: null });
    const identity = launchIdentityForTarget(target, config.profileDir);
    browserProcess = spawn(identity.executablePath, [
      `--user-data-dir=${config.profileDir}`,
      '--profile-directory=Default',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--headless=new',
      '--use-mock-keychain',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      'about:blank',
    ], { stdio: 'ignore' });
    const processId = browserProcess.pid;
    if (processId === undefined) throw new Error('Disposable Chromium did not expose a PID.');
    const devtoolsPort = await waitForDisposableDevToolsPort(config.profileDir, 5_000);
    const record = {
      version: 1 as const,
      kind: 'chromium_cdp' as const,
      browser: 'chromium' as const,
      state: 'awaiting_user' as const,
      processId,
      port: devtoolsPort,
      createdAt: new Date().toISOString(),
    };
    await writeNativeControlRecord(config.profileDir, record);

    const nativeBrowser = await playwrightBrowserType('chromium').connectOverCDP(
      nativeControlEndpoint(record),
    );
    const nativeContext = nativeBrowser.contexts()[0];
    if (nativeContext === undefined) throw new Error('Disposable handoff context was not available.');
    const markerPage = nativeContext.pages()[0] ?? await nativeContext.newPage();
    await markerPage.goto(stage5HandoffMarkerUrl('Disposable Stage5 private handoff'));
    const draftPage = await nativeContext.newPage();
    await draftPage.goto(`http://127.0.0.1:${fixturePort}/draft`);
    await draftPage.locator('#draft').fill(DISPOSABLE_DRAFT);
    await nativeBrowser.close();
    expect(processIsRunning(processId)).toBe(true);

    const [browserStartedAt, browserFingerprint] = await Promise.all([
      processStartedAtToken(processId),
      executableFingerprint(identity.executablePath),
    ]);
    if (browserStartedAt === null || browserFingerprint === null) {
      throw new Error('Disposable Chromium identity was not observable.');
    }
    const orphanedLease = {
      version: 1,
      leaseId: randomUUID(),
      browser: 'chromium',
      engine: 'chromium',
      profileFingerprint: profilePathFingerprint(config.profileDir),
      ownerWorkerProcessId: DEAD_WORKER_PROCESS_ID,
      ownerWorkerStartedAt: 'exited-disposable-worker',
      browserProcessId: processId,
      browserProcessStartedAt: browserStartedAt,
      browserExecutableFingerprint: browserFingerprint,
      controlMode: 'human_handoff',
      phase: 'process_exited',
      createdAt: record.createdAt,
      heartbeatAt: record.createdAt,
    } as const;
    await writeProfileOwnershipLease(config.profileDir, orphanedLease);

    const launcher: HumanBrowserLauncher = {
      launch: vi.fn(async () => {
        throw new Error('Durable handoff recovery must not relaunch a browser.');
      }),
    };
    const inspectOwner = vi.fn(async () => ({
      evidence: {
        classification: 'authentication_handoff_pending' as const,
        ownership: 'proven' as const,
        lockOwnerProcess: 'running' as const,
        expectedApplication: identity.applicationName,
        applicationIdentity: 'matched' as const,
        loopbackControl: 'available' as const,
        authenticationHandoff: 'present' as const,
        recovery: 'return_to_authentication_handoff' as const,
        suggestedAction: 'Resume the exact durable handoff.',
      },
      reconnectRecord: null,
      handoffRecord: record,
    }));
    controller = new BrowserController(
      config,
      'chromium',
      launcher,
      undefined,
      undefined,
      undefined,
      undefined,
      inspectOwner,
    );

    await expect(controller.authStatus()).resolves.toMatchObject({
      state: 'awaiting_user',
      browserConnected: false,
      controlMode: 'human_bootstrap',
      humanBootstrap: { running: true },
    });
    expect((await readNativeControlRecord(config.profileDir, 'chromium'))?.state).toBe('awaiting_user');
    expect(launcher.launch).not.toHaveBeenCalled();
    await expect(
      controller.requestLoginHandoff({ url: null, timeoutMs: 1_000 }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'AUTH_HANDOFF_REQUIRED',
      details: { reason: 'handoff_already_active' },
    });

    // Cover the narrower crash window where the native record is durable but
    // the exited worker had not yet persisted its native process identity.
    await writeProfileOwnershipLease(config.profileDir, {
      ...orphanedLease,
      leaseId: randomUUID(),
      browserProcessId: null,
      browserProcessStartedAt: null,
      browserExecutableFingerprint: null,
      phase: 'launching',
    });
    const available = await controller.availableBrowsers();
    expect(available.browsers.find((candidate) => candidate.browser === 'chromium')).toMatchObject({
      profileState: 'owned_orphaned',
      startable: false,
      recoverable: true,
      suggestedAction: expect.stringContaining('browser_resume_after_login'),
    });

    const resumed = await controller.resumeAfterLogin({ expected: null, timeoutMs: 5_000 });
    expect(resumed).toMatchObject({
      state: 'ready_for_agent_verification',
      browserConnected: true,
      userActionRequired: false,
    });
    expect(launcher.launch).not.toHaveBeenCalled();
    expect((await readNativeControlRecord(config.profileDir, 'chromium'))?.state).toBe('controlled');
    expect(await activePage(controller).locator('#draft').inputValue()).toBe(DISPOSABLE_DRAFT);
  }, 20_000);
});

function activePage(candidate: BrowserController): Page {
  return (candidate as unknown as { activePage: Page }).activePage;
}
