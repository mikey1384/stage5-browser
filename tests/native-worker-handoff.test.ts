import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';

import { BrowserController } from '../src/browser-controller.js';
import { resolveBrowserLaunchTarget } from '../src/browser-provider.js';
import type { Stage5BrowserConfig } from '../src/config.js';
import {
  processIsRunning,
  readNativeControlRecord,
  writeNativeControlRecord,
} from '../src/native-control-channel.js';
import { launchIdentityForTarget } from '../src/profile-binding.js';
import {
  readProfileOwnershipLease,
  writeProfileOwnershipLease,
} from '../src/profile-ownership-lease.js';
import {
  closeServer,
  listen,
  waitForDisposableDevToolsPort,
  waitForDisposableProcessExit,
} from './browser-controller-fixture.js';

const DISPOSABLE_DRAFT = 'disposable worker-handoff draft';
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

describe('native Chromium worker handoff continuity', () => {
  it('preserves the exact selected document and unsaved DOM across a real CDP detach and reattach', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><body>
        <div role="dialog" aria-modal="true">
          <label for="draft">Draft</label>
          <textarea id="draft"></textarea>
          <label for="attachment">Attachment</label>
          <input id="attachment" type="file">
        </div>
      </body></html>`);
    });
    const port = await listen(server);
    root = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-native-handoff-'));
    const config = configFor(root);
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
    const browserProcessId = browserProcess.pid;
    if (browserProcessId === undefined) throw new Error('Disposable Chromium did not expose a PID.');
    const devtoolsPort = await waitForDisposableDevToolsPort(config.profileDir, 5_000);
    await writeNativeControlRecord(config.profileDir, {
      version: 1,
      kind: 'chromium_cdp',
      browser: 'chromium',
      state: 'controlled',
      processId: browserProcessId,
      port: devtoolsPort,
      createdAt: new Date().toISOString(),
    });

    controller = new BrowserController(config);
    await expect(controller.start()).resolves.toMatchObject({
      browserConnected: true,
      profileOwner: { classification: 'owned_active', ownership: 'proven' },
    });
    const draftUrl = `http://127.0.0.1:${port}/draft`;
    await controller.open({
      url: draftUrl,
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
    expect(await activeDraftValue(controller)).toBe(DISPOSABLE_DRAFT);
    const attachmentPath = path.join(root, 'disposable-attachment.txt');
    await writeFile(attachmentPath, 'disposable attachment');
    const attachmentSnapshot = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    const attachmentRef = attachmentSnapshot.fileInputs[0]?.ref;
    if (attachmentRef === undefined) throw new Error('Native handoff fixture omitted its file input.');
    await expect(controller.setInputFiles({
      snapshotId: attachmentSnapshot.snapshotId,
      ref: attachmentRef,
      paths: [attachmentPath],
      frameId: null,
      completion: null,
      observationMs: 0,
      previewDepth: 4,
      timeoutMs: 5_000,
    })).resolves.toMatchObject({
      page: {
        stateRisk: {
          kind: 'possible_unsaved_file_selections',
          fileCount: 1,
          acknowledgementRequired: true,
        },
      },
    });
    const lifecycleCursor = (
      await controller.pageEvents({ afterSequence: 0, limit: 100 })
    ).cursor;

    await controller.detachForWorkerShutdown();
    controller = undefined;
    expect(processIsRunning(browserProcessId)).toBe(true);
    const before = await readNativeControlRecord(config.profileDir, 'chromium');
    expect(before?.selectedTargetId).toEqual(expect.any(String));
    expect(before?.selectedDocumentId).toEqual(expect.any(String));
    expect(before?.retainedPageStateRisk).toMatchObject({
      stateRisk: {
        kind: 'possible_unsaved_file_selections',
        fileCount: 1,
        acknowledgementRequired: true,
      },
    });
    const lease = await readProfileOwnershipLease(config.profileDir);
    if (lease === null) throw new Error('Worker handoff did not retain its ownership lease.');
    await writeProfileOwnershipLease(config.profileDir, {
      ...lease,
      ownerWorkerProcessId: DEAD_WORKER_PROCESS_ID,
      ownerWorkerStartedAt: 'exited-disposable-worker',
    });

    controller = new BrowserController(config);
    await expect(controller.start()).resolves.toMatchObject({
      browserConnected: true,
      profileOwner: { classification: 'owned_active', ownership: 'proven' },
      pages: [expect.objectContaining({
        stateRisk: {
          kind: 'possible_unsaved_file_selections',
          fileCount: 1,
          acknowledgementRequired: true,
        },
      })],
    });
    expect(await activeDraftValue(controller)).toBe(DISPOSABLE_DRAFT);
    const after = await readNativeControlRecord(config.profileDir, 'chromium');
    expect(after?.selectedTargetId).toBe(before?.selectedTargetId);
    expect(after?.selectedDocumentId).toBe(before?.selectedDocumentId);
    const handoffEvents = await controller.pageEvents({
      afterSequence: lifecycleCursor,
      limit: 100,
    });
    expect(
      handoffEvents.events.filter((event) => event.sanitizedUrl === draftUrl),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'document_replaced' }),
      ]),
    );
  }, 20_000);
});

function configFor(temporaryRoot: string): Stage5BrowserConfig {
  const profileDir = path.join(temporaryRoot, 'profile');
  return {
    browser: 'chromium',
    browserExecutablePath: null,
    profilesDir: path.join(temporaryRoot, 'profiles'),
    profileDir,
    artifactsDir: path.join(temporaryRoot, 'artifacts'),
    headless: true,
    operationTimeoutMs: 5_000,
    navigationTimeoutMs: 5_000,
    readinessTimeoutMs: 2_000,
    workerStartupTimeoutMs: 5_000,
    workerShutdownGraceMs: 500,
  };
}

async function activeDraftValue(candidate: BrowserController): Promise<string> {
  const page = (candidate as unknown as { activePage: Page }).activePage;
  return page.locator('#draft').inputValue();
}
