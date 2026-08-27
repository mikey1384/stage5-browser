import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';

import { BrowserController } from '../../../src/browser-controller.js';
import { playwrightBrowserType, resolveBrowserLaunchTarget } from '../../../src/browser-provider.js';
import { isStage5HandoffMarkerUrl } from '../../../src/human-auth-bootstrap.js';
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
  readProfileOwnershipLease,
  writeProfileOwnershipLease,
} from '../../../src/profile-ownership-lease.js';
import {
  browserConfig,
  closeServer,
  FakeHumanBrowserLauncher,
  listen,
  waitForDisposableDevToolsPort,
  waitForDisposableProcessExit,
} from '../../browser-controller-fixture.js';

const DISPOSABLE_DRAFT = 'same-process private handoff draft';
const DEAD_WORKER_PROCESS_ID = 2_147_483_000;

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

describe('native Chromium private handoff release', () => {
  it('reuses the exact process and preserves the selected page plus unsaved form state', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><body><label for="draft">Draft</label><textarea id="draft"></textarea></body></html>');
    });
    const port = await listen(server);
    root = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-native-private-handoff-'));
    const config = browserConfig(root);
    config.headless = false;
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
    await writeNativeControlRecord(config.profileDir, {
      version: 1,
      kind: 'chromium_cdp',
      browser: 'chromium',
      state: 'controlled',
      processId,
      port: devtoolsPort,
      createdAt: new Date().toISOString(),
    });
    const [browserProcessStartedAt, browserExecutableFingerprint] = await Promise.all([
      processStartedAtToken(processId),
      executableFingerprint(identity.executablePath),
    ]);
    if (browserProcessStartedAt === null || browserExecutableFingerprint === null) {
      throw new Error('Disposable Chromium ownership identity was not observable.');
    }
    const interruptedAt = new Date().toISOString();
    await writeProfileOwnershipLease(config.profileDir, {
      version: 1,
      leaseId: randomUUID(),
      browser: 'chromium',
      engine: 'chromium',
      profileFingerprint: profilePathFingerprint(config.profileDir),
      ownerWorkerProcessId: DEAD_WORKER_PROCESS_ID,
      ownerWorkerStartedAt: 'exited-pre-fix-worker',
      browserProcessId: processId,
      browserProcessStartedAt,
      browserExecutableFingerprint,
      controlMode: 'native_cdp',
      phase: 'close_requested',
      createdAt: interruptedAt,
      heartbeatAt: interruptedAt,
    });

    const launcher = new FakeHumanBrowserLauncher();
    controller = new BrowserController(config, 'chromium', launcher);
    await controller.start();
    await controller.open({
      url: `http://127.0.0.1:${port}/draft`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    await controller.fillByRole({
      role: 'textbox',
      name: 'Draft',
      exact: true,
      frameId: null,
      value: DISPOSABLE_DRAFT,
      timeoutMs: 5_000,
    });

    const startedAt = Date.now();
    const handoff = await controller.requestLoginHandoff({ url: null, timeoutMs: 5_000 });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(handoff).toMatchObject({
      state: 'awaiting_user',
      browserConnected: false,
      handoffRelease: {
        strategy: 'native_same_process',
        phase: 'human_input',
        closeRequestCompleted: true,
        processReused: true,
        ownershipRetained: true,
      },
      humanBootstrap: { running: true, processId },
    });
    expect(handoff.instructions).toContain('existing');
    expect(launcher.launches).toHaveLength(0);
    expect(processIsRunning(processId)).toBe(true);
    expect(await readNativeControlRecord(config.profileDir, 'chromium')).toMatchObject({
      state: 'awaiting_user',
      processId,
      selectedTargetId: expect.any(String),
      selectedDocumentId: expect.any(String),
    });
    expect(await readProfileOwnershipLease(config.profileDir)).toMatchObject({
      browserProcessId: processId,
      controlMode: 'human_handoff',
      phase: 'human_input',
    });

    const humanBrowser = await playwrightBrowserType('chromium').connectOverCDP(
      nativeControlEndpoint((await readNativeControlRecord(config.profileDir, 'chromium'))!),
    );
    const pages = humanBrowser.contexts()[0]?.pages() ?? [];
    expect(pages.some((page) => isStage5HandoffMarkerUrl(page.url()))).toBe(true);
    const draftPage = await pageWithDraft(pages);
    expect(await draftPage.locator('#draft').inputValue()).toBe(DISPOSABLE_DRAFT);
    await humanBrowser.close();
    expect(processIsRunning(processId)).toBe(true);

    await controller.detachForWorkerShutdown();
    controller = undefined;
    const interruptedLease = await readProfileOwnershipLease(config.profileDir);
    if (interruptedLease === null) throw new Error('Disposable handoff lease disappeared.');
    await writeProfileOwnershipLease(config.profileDir, {
      ...interruptedLease,
      ownerWorkerProcessId: DEAD_WORKER_PROCESS_ID,
      ownerWorkerStartedAt: 'exited-disposable-worker',
      controlMode: 'native_cdp',
      phase: 'close_requested',
    });
    controller = new BrowserController(config, 'chromium', launcher);
    await expect(controller.authStatus()).resolves.toMatchObject({
      state: 'awaiting_user',
      browserConnected: false,
      handoffRelease: { strategy: 'native_same_process', processReused: true },
    });

    const resumed = await controller.resumeAfterLogin({ expected: null, timeoutMs: 5_000 });
    expect(resumed).toMatchObject({
      state: 'ready_for_agent_verification',
      browserConnected: true,
      handoffRelease: { strategy: 'native_same_process', processReused: true },
    });
    expect(await activePage(controller).locator('#draft').inputValue()).toBe(DISPOSABLE_DRAFT);
  }, 20_000);
});

async function pageWithDraft(pages: Page[]): Promise<Page> {
  for (const page of pages) {
    if (await page.locator('#draft').count() === 1) return page;
  }
  throw new Error('Disposable draft page was not preserved.');
}

function activePage(candidate: BrowserController): Page {
  return (candidate as unknown as { activePage: Page }).activePage;
}
