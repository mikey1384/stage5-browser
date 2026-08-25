import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { ElementHandle, Frame, Locator, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserController } from '../src/browser-controller.js';
import { playwrightBrowserType, resolveBrowserLaunchTarget } from '../src/browser-provider.js';
import type { Stage5BrowserConfig } from '../src/config.js';
import { Stage5BrowserError } from '../src/errors.js';
import { inspectTargetState, type SanitizedPageActivationEvidence } from '../src/page-diagnostics.js';
import type {
  HumanBrowserLaunchInput,
  HumanBrowserLauncher,
  HumanBrowserProcessState,
  HumanBrowserSession,
} from '../src/human-auth-bootstrap.js';
import { waitForProfileUnlock } from '../src/human-auth-bootstrap.js';
import type { OwnedBrowserWindowActivator } from '../src/native-window-activation.js';
import type { NativeControlRecord } from '../src/native-control-channel.js';
import { processIsRunning } from '../src/native-control-channel.js';
import {
  launchIdentityForTarget,
  controlledProfileArguments,
  type BrowserLaunchIdentity,
  type ProfileStorageInspection,
} from '../src/profile-binding.js';
import {
  processExecutablePath,
  processStartedAtToken,
  profilePathFingerprint,
  observeLaunchedBrowserProcess,
  snapshotOwnedDescendants,
  writeProfileOwnershipLease,
} from '../src/profile-ownership-lease.js';
import type { BrowserStatus } from '../src/protocol.js';

let server: Server | undefined;
let frameServer: Server | undefined;
let controller: BrowserController | undefined;
let temporaryRoot: string | undefined;
let humanLauncher: FakeHumanBrowserLauncher | undefined;

class FakeHumanBrowserSession implements HumanBrowserSession {
  private running = true;
  private exitCode: number | null = null;
  private readonly launchedAt = new Date().toISOString();

  constructor(private readonly launchInput: HumanBrowserLaunchInput) {}

  state(): HumanBrowserProcessState {
    return {
      running: this.running,
      processId: process.pid,
      exitCode: this.exitCode,
      exitSignal: null,
      launchedAt: this.launchedAt,
    };
  }

  identity() {
    return launchIdentityForTarget(this.launchInput.target, this.launchInput.profileDir);
  }

  async waitForExit(_timeoutMs: number): Promise<boolean> {
    return !this.running;
  }

  async finish(clean = true, exitCode = clean ? 0 : 1): Promise<void> {
    await mkdir(path.join(this.launchInput.profileDir, 'Default'), { recursive: true });
    await writeFile(
      path.join(this.launchInput.profileDir, 'Local State'),
      JSON.stringify({ profile: { last_used: 'Default' } }),
    );
    await writeFile(
      path.join(this.launchInput.profileDir, 'Default', 'Preferences'),
      JSON.stringify({
        profile: clean
          ? { exit_type: 'Normal', exited_cleanly: true }
          : { exit_type: 'Crashed', exited_cleanly: false },
      }),
    );
    this.running = false;
    this.exitCode = exitCode;
  }
}

class FakeHumanBrowserLauncher implements HumanBrowserLauncher {
  launches: HumanBrowserLaunchInput[] = [];
  session: FakeHumanBrowserSession | null = null;

  async launch(input: HumanBrowserLaunchInput): Promise<HumanBrowserSession> {
    this.launches.push(input);
    this.session = new FakeHumanBrowserSession(input);
    return this.session;
  }

  async finish(clean = true, exitCode = clean ? 0 : 1): Promise<void> {
    await this.session?.finish(clean, exitCode);
  }
}

async function listen(candidate: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    candidate.once('error', onError);
    candidate.listen(0, '127.0.0.1', () => {
      candidate.off('error', onError);
      resolve();
    });
  });
  const address = candidate.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Fixture server did not bind to TCP.');
  }
  return address.port;
}

async function closeServer(candidate: Server | undefined): Promise<void> {
  if (candidate === undefined || !candidate.listening) {
    return;
  }
  candidate.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    candidate.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function browserConfig(root: string): Stage5BrowserConfig {
  return {
    browser: 'chromium',
    browserExecutablePath: null,
    profilesDir: path.join(root, 'profiles'),
    profileDir: path.join(root, 'profile'),
    artifactsDir: path.join(root, 'artifacts'),
    headless: true,
    operationTimeoutMs: 5_000,
    navigationTimeoutMs: 5_000,
    readinessTimeoutMs: 2_000,
    workerStartupTimeoutMs: 5_000,
    workerShutdownGraceMs: 500,
  };
}

function storageInspection(
  targetOrigin: string,
  keys: string[],
): ProfileStorageInspection {
  return {
    observedAt: new Date().toISOString(),
    targetOrigin,
    cookieDatabase: {
      supported: true,
      databaseKind: 'chromium_legacy',
      relativePath: 'Cookies',
      exists: true,
      modifiedAt: new Date().toISOString(),
      journalModifiedAt: null,
      locations: [],
      targetOriginCookiePresent: keys.length > 0,
      sessionCookiePresent: false,
      persistentCookiePresent: keys.length > 0,
      inspection: 'aggregate_metadata',
    },
    keyTokens: new Set(keys),
  };
}

afterEach(async () => {
  await humanLauncher?.finish();
  await controller?.stop();
  controller = undefined;
  humanLauncher = undefined;
  await Promise.all([closeServer(server), closeServer(frameServer)]);
  server = undefined;
  frameServer = undefined;
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

describe('BrowserController', () => {
  it('navigates, snapshots, fills unique targets, and rejects ambiguous targets', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html><head><title>Stage5 Browser fixture</title></head>
        <body>
          <h1>Translator tools fixture</h1>
          <label for="query">Search videos</label><input id="query" />
          <button type="button">Duplicate</button><button type="button">Duplicate</button>
        </body></html>`);
    });
    const port = await listen(server);

    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-controller-'));
    controller = new BrowserController(browserConfig(temporaryRoot));

    const opened = await controller.open({
      url: `http://127.0.0.1:${port}/watch/example`,
      newTab: false,
      timeoutMs: 5_000,
    });
    expect(opened.responseStatus).toBe(200);
    expect(opened.page.title).toBe('Stage5 Browser fixture');
    expect((await controller.status()).launchIdentity).toMatchObject({
      browser: 'chromium',
      engine: 'chromium',
      profile: {
        userDataDir: path.join(temporaryRoot, 'profile'),
        profileDirectory: 'Default',
      },
    });

    const snapshot = await controller.snapshot({ depth: 8, boxes: false, frameId: null, timeoutMs: 5_000 });
    expect(snapshot.snapshot).toContain('Translator tools fixture');
    await controller.fillByRole({
      role: 'textbox',
      name: 'Search videos',
      exact: true,
      frameId: null,
      value: 'hello',
      timeoutMs: 5_000,
    });

    await expect(
      controller.clickByRole({
        role: 'button',
        name: 'Duplicate',
        exact: true,
        frameId: null,
        postcondition: null,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({ code: 'AMBIGUOUS_TARGET' });

    const screenshot = await controller.screenshot({ fullPage: false, timeoutMs: 5_000 });
    expect((await stat(screenshot.path)).mode & 0o777).toBe(0o600);
    expect(screenshot.dataBase64.length).toBeGreaterThan(100);
    expect(screenshot.captureEvidence).toMatchObject({
      artifactClassification: 'contentful',
      semanticContentPresent: true,
      retryUsed: false,
      pageActivation: {
        controllerSelected: true,
        bringToFrontAttempted: false,
        bringToFrontSucceeded: false,
        visibilityAfter: 'visible',
      },
    });
    expect(screenshot.captureEvidence.pngBytes).toBeGreaterThan(100);

    const available = await controller.availableBrowsers();
    for (const browser of ['chromium', 'firefox', 'webkit'] as const) {
      expect(available.browsers.find((entry) => entry.browser === browser)?.available).toBe(true);
    }
    expect(available.browsers.find((entry) => entry.browser === 'chromium')).toMatchObject({
      installed: true,
      profileState: 'owned_active',
      startable: true,
      recoverable: false,
    });
    expect(available.browsers.find((entry) => entry.browser === 'firefox')).toMatchObject({
      installed: true,
      profileState: 'startable',
      startable: true,
    });
    const competingController = new BrowserController(browserConfig(temporaryRoot));
    expect((await competingController.availableBrowsers()).browsers.find(
      (entry) => entry.browser === 'chromium',
    )).toMatchObject({
      available: false,
      installed: true,
      profileState: 'busy_other_stage5_session',
      startable: false,
      recoverable: false,
    });

    await expect(controller.start({ browser: 'firefox' })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'OPERATION_FAILED',
      details: { currentBrowser: 'chromium', requestedBrowser: 'firefox', reason: 'browser_already_running' },
    });
    expect((await controller.status()).browser).toBe('chromium');

    for (const browser of ['firefox', 'webkit'] as const) {
      const switched = await controller.switchBrowser({ browser });
      expect(switched).toMatchObject({ browser, state: 'running', browserConnected: true });
      const reopened = await controller.open({
        url: `http://127.0.0.1:${port}/watch/${browser}`,
        newTab: false,
        timeoutMs: 5_000,
      });
      expect(reopened.responseStatus).toBe(200);
      expect(reopened.page.title).toBe('Stage5 Browser fixture');
    }
  });

  it('fills an unnamed snapshot-bound contenteditable with privacy-safe evidence', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Unnamed composer</title></head><body>
        <div role="dialog" aria-modal="true" aria-label="Create post">
          <span>What's on your mind?</span>
          <div id="editor" role="textbox" contenteditable="true" tabindex="0" autofocus><p><br></p></div>
          <button type="button">Post</button>
        </div>
        <script>
          document.querySelector('#editor').addEventListener('focus', () => {
            document.querySelector('span').setAttribute('data-editor-focused', 'true');
          });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-fill-ref-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/compose`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({ depth: 6, boxes: false, frameId: null, timeoutMs: 2_000 });
    expect(observed.scope).toBe('modal');
    const editorRef = observed.snapshot.match(/textbox[^\n]*\[ref=([^\]]+)\]/)?.[1];
    expect(editorRef).toBeDefined();
    if (editorRef === undefined) throw new Error('Unnamed composer fixture did not expose a textbox ref.');

    const page = (controller as unknown as { activePage: Page }).activePage;
    const retainedEditor = (controller as unknown as {
      observedSnapshots: Map<Frame, {
        textEditors: Map<string, { handle: ElementHandle<HTMLElement> }>;
      }>;
    }).observedSnapshots.get(page.mainFrame())?.textEditors.get(editorRef)?.handle;
    expect(retainedEditor).toBeDefined();
    if (retainedEditor === undefined) throw new Error('Snapshot did not retain the exact editor handle.');
    const stabilityGatedScroll = vi.spyOn(retainedEditor, 'scrollIntoViewIfNeeded')
      .mockRejectedValue(new Error('A visible editor must not enter Playwright stability-gated scrolling.'));
    const snapshotRoot = vi.spyOn(
      controller as unknown as { snapshotRoot: (...args: unknown[]) => Promise<unknown> },
      'snapshotRoot',
    ).mockRejectedValue(new Error('fill_ref must not rediscover the live snapshot root'));
    const frameLocator = vi.spyOn(page.mainFrame(), 'locator');

    const draft = '새로운 영상의 핵심 내용을 정리했습니다.\n\nhttps://example.com/watch?v=stage5';
    const filled = await controller.fillRef({
      snapshotId: observed.snapshotId,
      ref: editorRef,
      frameId: null,
      value: draft,
      timeoutMs: 3_000,
    });
    expect(filled.input).toMatchObject({
      actionDispatched: true,
      inputEventObserved: true,
      valueMatchedBefore: false,
      valueMatches: true,
      targetConnectedAfter: true,
      targetKind: 'contenteditable',
    });
    expect(JSON.stringify(filled)).not.toContain(draft);
    expect(snapshotRoot).not.toHaveBeenCalled();
    expect(stabilityGatedScroll).not.toHaveBeenCalled();
    expect(frameLocator.mock.calls.some(([selector]) =>
      typeof selector === 'string' && selector.startsWith('aria-ref='))).toBe(false);
    await expect(page.locator('#editor p').allTextContents()).resolves.toEqual([
      '새로운 영상의 핵심 내용을 정리했습니다.',
      '',
      'https://example.com/watch?v=stage5',
    ]);
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: 'fill_ref',
      outcome: 'succeeded',
      reason: null,
      actionDispatched: true,
      clickDispatched: null,
      fillPhase: 'completed',
      fillPreparationStep: 'completed',
      inputEvidence: {
        inputEventObserved: true,
        valueMatches: true,
        targetKind: 'contenteditable',
      },
    });
    await expect(controller.fillRef({
      snapshotId: observed.snapshotId,
      ref: editorRef,
      frameId: null,
      value: 'must not replay',
      timeoutMs: 1_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'TARGET_NOT_FOUND',
      details: { reason: 'stale_or_unknown_snapshot', actionDispatched: false },
    });
  });

  it('scrolls an offscreen retained editor without Playwright stability-gated preparation', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Offscreen composer</title><style>
        [role="dialog"] { height: 180px; overflow: auto; }
        .spacer { height: 900px; }
        #editor { min-height: 48px; }
      </style></head><body>
        <div role="dialog" aria-modal="true" aria-label="Create post">
          <div class="spacer"></div>
          <div id="editor" role="textbox" contenteditable="true" tabindex="0"><p><br></p></div>
          <button type="button" disabled>Next</button>
        </div>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-fill-ref-offscreen-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/compose`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({ depth: 6, boxes: false, frameId: null, timeoutMs: 2_000 });
    const editorRef = observed.snapshot.match(/textbox[^\n]*\[ref=([^\]]+)\]/)?.[1];
    expect(editorRef).toBeDefined();
    if (editorRef === undefined) throw new Error('Offscreen composer fixture did not expose a textbox ref.');

    const page = (controller as unknown as { activePage: Page }).activePage;
    const retainedEditor = (controller as unknown as {
      observedSnapshots: Map<Frame, {
        textEditors: Map<string, { handle: ElementHandle<HTMLElement> }>;
      }>;
    }).observedSnapshots.get(page.mainFrame())?.textEditors.get(editorRef)?.handle;
    expect(retainedEditor).toBeDefined();
    if (retainedEditor === undefined) throw new Error('Snapshot did not retain the offscreen editor handle.');
    const stabilityGatedScroll = vi.spyOn(retainedEditor, 'scrollIntoViewIfNeeded')
      .mockRejectedValue(new Error('The exact DOM viewport path must not use Playwright stability waits.'));

    const draft = '보이는 영역 밖의 편집기 테스트입니다.\n\nhttps://example.com/stage5';
    await expect(controller.fillRef({
      snapshotId: observed.snapshotId,
      ref: editorRef,
      frameId: null,
      value: draft,
      timeoutMs: 3_000,
    })).resolves.toMatchObject({
      input: {
        actionDispatched: true,
        inputEventObserved: true,
        valueMatches: true,
        targetKind: 'contenteditable',
      },
    });
    expect(stabilityGatedScroll).not.toHaveBeenCalled();
    await expect(page.locator('#editor').evaluate((editor) => {
      const rect = editor.getBoundingClientRect();
      const dialogRect = editor.parentElement?.getBoundingClientRect();
      return dialogRect !== undefined && rect.bottom > dialogRect.top && rect.top < dialogRect.bottom;
    })).resolves.toBe(true);
  });

  it('returns structured no-input evidence before a Facebook-style contenteditable fill deadline', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Bounded unnamed composer</title></head><body>
        <div role="dialog" aria-modal="true" aria-label="Create post">
          <span>What's on your mind?</span>
          <div id="editor" role="textbox" contenteditable="true" tabindex="0"><p><br></p></div>
          <button type="button" disabled>Next</button>
        </div>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-fill-ref-timeout-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/compose`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({ depth: 6, boxes: false, frameId: null, timeoutMs: 2_000 });
    const editorRef = observed.snapshot.match(/textbox[^\n]*\[ref=([^\]]+)\]/)?.[1];
    expect(editorRef).toBeDefined();
    if (editorRef === undefined) throw new Error('Bounded composer fixture did not expose a textbox ref.');
    const dispatch = vi.spyOn(
      controller as unknown as {
        dispatchExactHandleFill: (
          handle: unknown,
          value: string,
          timeoutMs: number,
        ) => Promise<void>;
      },
      'dispatchExactHandleFill',
    ).mockImplementation(async (_handle, _value, timeoutMs) => {
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      const error = new Error('Simulated exact-handle fill timeout.');
      error.name = 'TimeoutError';
      throw error;
    });
    const draft = '멀티라인 테스트입니다.\n\nhttps://example.com/video';
    const startedAt = Date.now();
    let failure: Stage5BrowserError | null = null;
    try {
      await controller.fillRef({
        snapshotId: observed.snapshotId,
        ref: editorRef,
        frameId: null,
        value: draft,
        timeoutMs: 1_000,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Stage5BrowserError);
      failure = error as Stage5BrowserError;
    }
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(failure).toMatchObject({
      code: 'OPERATION_FAILED',
      details: {
        reason: 'fill_dispatch_failed',
        fillPhase: 'fill_dispatch',
        actionDispatched: false,
        inputEvidence: {
          inputEventObserved: false,
          changeEventObserved: false,
          valueMatchedBefore: false,
          valueMatches: false,
          targetConnectedAfter: true,
          targetKind: 'contenteditable',
        },
      },
    });
    expect(JSON.stringify(failure?.serialize())).not.toContain(draft);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const page = (controller as unknown as { activePage: Page }).activePage;
    await expect(page.locator('#editor').textContent()).resolves.toBe('');
    await expect(page.getByRole('button', { name: 'Next' }).isDisabled()).resolves.toBe(true);
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: 'fill_ref',
      outcome: 'blocked',
      reason: 'timeout',
      actionDispatched: false,
      clickDispatched: null,
      fillPhase: 'fill_dispatch',
      inputEvidence: { valueMatches: false },
    });
  });

  it('fails a detached snapshot scope promptly at the exact preparation step without resolving ARIA refs again', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Replacing composer</title></head><body>
        <div id="composer" role="dialog" aria-modal="true" aria-label="Create post">
          <div id="editor" role="textbox" contenteditable="true" tabindex="0"><p><br></p></div>
          <button type="button" disabled>Next</button>
        </div>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-fill-ref-scope-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/compose`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({ depth: 6, boxes: false, frameId: null, timeoutMs: 2_000 });
    const editorRef = observed.snapshot.match(/textbox[^\n]*\[ref=([^\]]+)\]/)?.[1];
    expect(editorRef).toBeDefined();
    if (editorRef === undefined) throw new Error('Replacing composer fixture did not expose a textbox ref.');
    const page = (controller as unknown as { activePage: Page }).activePage;
    await page.locator('#composer').evaluate((composer) => composer.replaceWith(composer.cloneNode(true)));

    const startedAt = Date.now();
    await expect(controller.fillRef({
      snapshotId: observed.snapshotId,
      ref: editorRef,
      frameId: null,
      value: '이 값은 입력되면 안 됩니다.\n\nhttps://example.com/private-draft',
      timeoutMs: 2_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'TARGET_NOT_FOUND',
      details: {
        reason: 'snapshot_scope_changed',
        fillPhase: 'target_preparation',
        fillPreparationStep: 'scope_validation',
        actionDispatched: false,
        targetState: null,
        inputEvidence: null,
      },
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await expect(page.locator('#editor').textContent()).resolves.toBe('');
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: 'fill_ref',
      outcome: 'blocked',
      actionDispatched: false,
      fillPhase: 'target_preparation',
      fillPreparationStep: 'scope_validation',
      targetState: null,
    });
  });

  it('reports an externally locked stopped profile and waits for a bounded owned release', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Released profile</title></head><body>Ready</body></html>');
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-transient-lock-'));
    const config = browserConfig(temporaryRoot);
    await mkdir(config.profileDir, { recursive: true });
    const lockPath = path.join(config.profileDir, 'SingletonLock');
    await writeFile(lockPath, 'owned-by-prior-worker');
    controller = new BrowserController(config);

    await expect(controller.status()).resolves.toMatchObject({
      state: 'stopped',
      browserConnected: false,
      profileLockState: 'possible_external_owner',
      profileLockFiles: ['SingletonLock'],
    });
    expect((await controller.availableBrowsers()).browsers.find(
      (entry) => entry.browser === 'chromium',
    )).toMatchObject({
      available: false,
      installed: true,
      profileState: 'external_owner',
      startable: false,
      recoverable: false,
    });
    const release = setTimeout(() => {
      void rm(lockPath, { force: true });
    }, 150);
    try {
      await expect(controller.open({
        url: `http://127.0.0.1:${port}/`,
        newTab: false,
        stabilizationMs: 0,
        timeoutMs: 5_000,
      })).resolves.toMatchObject({ responseStatus: 200 });
    } finally {
      clearTimeout(release);
    }
    const running = await controller.status();
    expect(running).toMatchObject({
      state: 'running',
      browserConnected: true,
    });
    expect(running.profileLockState).not.toBe('possible_external_owner');
  });

  it('recovers a conclusively proven direct-Playwright orphan without stranding its profile', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-owned-orphan-'));
    const config = browserConfig(temporaryRoot);
    await mkdir(config.profileDir, { recursive: true });
    const target = await resolveBrowserLaunchTarget({ browser: 'chromium', executablePath: null });
    const identity = launchIdentityForTarget(target, config.profileDir);
    const baselineDescendants = await snapshotOwnedDescendants(process.pid);
    const orphanContext = await playwrightBrowserType('chromium').launchPersistentContext(
      config.profileDir,
      {
        headless: true,
        args: controlledProfileArguments(identity.profile),
      },
    );
    try {
      const orphanProcess = await observeLaunchedBrowserProcess(
        identity,
        baselineDescendants,
        2_000,
      );
      expect(orphanProcess).not.toBeNull();
      if (orphanProcess === null) throw new Error('Fixture browser process identity was not observable.');
      const orphanProcessId = orphanProcess.processId;
      const [browserStartedAt, browserExecutable] = await Promise.all([
        processStartedAtToken(orphanProcessId),
        processExecutablePath(orphanProcessId),
      ]);
      expect(browserStartedAt).not.toBeNull();
      expect(browserExecutable).not.toBeNull();
      if (browserStartedAt === null || browserExecutable === null) {
        throw new Error('Fixture browser process identity was not observable.');
      }
      const canonicalExecutable = await realpath(browserExecutable);
      const now = new Date().toISOString();
      await writeProfileOwnershipLease(config.profileDir, {
        version: 1,
        leaseId: randomUUID(),
        browser: 'chromium',
        engine: 'chromium',
        profileFingerprint: profilePathFingerprint(config.profileDir),
        ownerWorkerProcessId: 2_147_483_000,
        ownerWorkerStartedAt: 'unreachable-test-worker',
        browserProcessId: orphanProcessId,
        browserProcessStartedAt: browserStartedAt,
        browserExecutableFingerprint: createHash('sha256').update(canonicalExecutable).digest('hex'),
        controlMode: 'playwright',
        phase: 'owned_active',
        createdAt: now,
        heartbeatAt: now,
      });

      controller = new BrowserController(config);
      expect((await controller.availableBrowsers()).browsers.find(
        (entry) => entry.browser === 'chromium',
      )).toMatchObject({
        available: true,
        profileState: 'owned_orphaned',
        startable: true,
        recoverable: true,
      });
      await expect(controller.start()).resolves.toMatchObject({
        state: 'running',
        browserConnected: true,
        profileOwner: {
          classification: 'owned_active',
          ownership: 'proven',
        },
      });
      expect(processIsRunning(orphanProcessId)).toBe(false);
    } finally {
      await orphanContext.close().catch(() => undefined);
    }
  });

  it('reconciles a transient DOM-readiness warning when the document completes during stabilization', async () => {
    server = createServer((request, response) => {
      if (request.url === '/slow.js') {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
          response.end('document.body.dataset.ready = "true";');
        }, 100);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Readiness reconciliation</title><script src="/slow.js"></script></head><body>Ready later</body></html>');
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-readiness-'));
    const config = { ...browserConfig(temporaryRoot), readinessTimeoutMs: 10 };
    controller = new BrowserController(config);

    const opened = await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 250,
      timeoutMs: 2_000,
    });
    expect(opened).toMatchObject({
      readiness: 'domcontentloaded',
      page: { readyState: 'complete' },
      warnings: [],
    });
  });

  it('bounds role resolution long enough for a transitioning control to appear', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Transitioning role</title></head><body>
        <div id="controls"></div>
        <a id="ready" href="#ready" hidden>Next step ready</a>
        <script>
          setTimeout(() => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = 'Continue';
            button.onclick = () => { document.querySelector('#ready').hidden = false; };
            document.querySelector('#controls').append(button);
          }, 250);
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-role-transition-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    await expect(controller.clickByRole({
      role: 'button',
      name: 'Continue',
      exact: true,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: null,
        expectedVisible: {
          role: 'link',
          name: 'Next step ready',
          exact: true,
          frameId: null,
        },
        timeoutMs: 1_000,
      },
      timeoutMs: 5_000,
    })).resolves.toMatchObject({ postcondition: { passed: true } });
  });

  it('dispatches OneTrust-style consent buttons exactly once through the shared role/ref engine', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Consent fixture</title></head><body>
        <div id="onetrust-consent-sdk" role="dialog" aria-label="Privacy choices">
          <button id="reject" type="button" aria-selected="false">Reject all</button>
          <output id="result">click-count:0</output>
        </div>
        <script>
          let clicks = 0;
          document.querySelector('#reject').addEventListener('click', (event) => {
            clicks += 1;
            event.currentTarget.setAttribute('aria-selected', 'true');
            document.querySelector('#result').textContent = 'click-count:' + clicks;
          });
        </script>
      </body></html>`);
    });
    const port = await listen(server);

    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-consent-'));
    for (const browser of ['chromium', 'firefox'] as const) {
      const config = {
        ...browserConfig(temporaryRoot),
        browser,
        profileDir: path.join(temporaryRoot, 'profiles', browser),
      };
      controller = new BrowserController(config, browser);
      const url = `http://127.0.0.1:${port}/${browser}`;
      await controller.open({ url, newTab: false, stabilizationMs: 0, timeoutMs: 5_000 });
      await controller.clickByRole({
        role: 'button',
        name: 'Reject all',
        exact: true,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: true,
          expectedVisible: null,
          timeoutMs: 1_000,
        },
        timeoutMs: 3_000,
      });
      expect((await controller.snapshot({ depth: 5, boxes: false, frameId: null, timeoutMs: 2_000 })).snapshot)
        .toContain('click-count:1');

      await controller.open({ url, newTab: false, stabilizationMs: 0, timeoutMs: 5_000 });
      const observed = await controller.snapshot({ depth: 5, boxes: false, frameId: null, timeoutMs: 2_000 });
      const rejectRef = observed.snapshot.match(/button "Reject all"[^\n]*\[ref=([^\]]+)\]/)?.[1];
      expect(rejectRef).toBeDefined();
      if (rejectRef === undefined) throw new Error('Consent fixture did not expose the Reject all ref.');
      await controller.clickRef({
        snapshotId: observed.snapshotId,
        ref: rejectRef,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: true,
          expectedVisible: null,
          timeoutMs: 1_000,
        },
        timeoutMs: 3_000,
      });
      expect((await controller.snapshot({ depth: 5, boxes: false, frameId: null, timeoutMs: 2_000 })).snapshot)
        .toContain('click-count:1');
      await controller.stop();
      controller = undefined;
    }
  });

  it('activates accessible native popup buttons without entering a replace-on-pointerdown sequence', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Popup opener replacement</title></head><body>
        <button id="opener" type="button" aria-haspopup="listbox" aria-expanded="false">
          Funding source
        </button>
        <div id="choices" role="listbox" aria-label="Funding choices" hidden>
          <div role="option">Business revenue</div>
        </div>
        <output id="counters">pointerdowns:0 clicks:0 replacement-clicks:0</output>
        <script>
          let pointerdowns = 0;
          let clicks = 0;
          let replacementClicks = 0;
          const renderCounters = () => {
            document.querySelector('#counters').textContent =
              'pointerdowns:' + pointerdowns +
              ' clicks:' + clicks +
              ' replacement-clicks:' + replacementClicks;
          };
          const wire = (button, replacement) => {
            button.addEventListener('pointerdown', () => {
              pointerdowns += 1;
              const next = button.cloneNode(true);
              wire(next, true);
              button.replaceWith(next);
              renderCounters();
            });
            button.addEventListener('click', (event) => {
              clicks += 1;
              if (replacement) replacementClicks += 1;
              event.currentTarget.setAttribute('aria-expanded', 'true');
              document.querySelector('#choices').hidden = false;
              renderCounters();
            });
          };
          wire(document.querySelector('#opener'), false);
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-popup-keyboard-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    const url = `http://127.0.0.1:${port}/popup`;

    for (const target of ['role', 'ref'] as const) {
      await controller.open({ url, newTab: false, stabilizationMs: 0, timeoutMs: 5_000 });
      const postcondition = {
        expectedUrl: null,
        expectedSelected: true,
        expectedVisible: null,
        timeoutMs: 1_000,
      } as const;
      if (target === 'role') {
        await controller.clickByRole({
          role: 'button',
          name: 'Funding source',
          exact: true,
          frameId: null,
          postcondition,
          timeoutMs: 3_000,
        });
      } else {
        const observed = await controller.snapshot({
          depth: 6,
          boxes: false,
          frameId: null,
          timeoutMs: 2_000,
        });
        const openerRef = observed.snapshot.match(/button "Funding source"[^\n]*\[ref=([^\]]+)\]/)?.[1];
        expect(openerRef).toBeDefined();
        if (openerRef === undefined) throw new Error('Popup fixture did not expose its opener ref.');
        await controller.clickRef({
          snapshotId: observed.snapshotId,
          ref: openerRef,
          frameId: null,
          postcondition,
          timeoutMs: 3_000,
        });
      }

      expect((await controller.snapshot({ depth: 6, boxes: false, frameId: null, timeoutMs: 2_000 })).snapshot)
        .toContain('pointerdowns:0 clicks:1 replacement-clicks:0');
      expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
        action: target === 'role' ? 'click_by_role' : 'click_by_ref',
        outcome: 'succeeded',
        actionDispatched: true,
        clickDispatched: true,
        dispatchEvidence: {
          forcedFallbackUsed: false,
          pageMouseFallbackUsed: false,
          pointerDownOnTarget: false,
          mouseDownOnTarget: false,
          pointerUpOnTarget: false,
          mouseUpOnTarget: false,
          clickOnTarget: true,
        },
      });
    }
  });

  it('activates a native React-style custom dropdown without splitting its pointer sequence', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Plain custom dropdown</title></head><body>
        <button id="opener" type="button">Customer location</button>
        <div id="choices" role="dialog" aria-label="Customer locations" hidden>
          <div role="option">United States</div>
        </div>
        <output id="counters">pointerdowns:0 mousedowns:0 clicks:0 replacements:0</output>
        <script>
          const counters = { pointerdowns: 0, mousedowns: 0, clicks: 0, replacements: 0 };
          const renderCounters = () => {
            document.querySelector('#counters').textContent =
              'pointerdowns:' + counters.pointerdowns +
              ' mousedowns:' + counters.mousedowns +
              ' clicks:' + counters.clicks +
              ' replacements:' + counters.replacements;
          };
          const wire = (button) => {
            button.addEventListener('pointerdown', () => { counters.pointerdowns += 1; renderCounters(); });
            button.addEventListener('mousedown', () => {
              counters.mousedowns += 1;
              const next = button.cloneNode(true);
              counters.replacements += 1;
              wire(next);
              button.replaceWith(next);
              renderCounters();
            });
            button.addEventListener('click', () => {
              counters.clicks += 1;
              document.querySelector('#choices').hidden = false;
              renderCounters();
            });
          };
          wire(document.querySelector('#opener'));
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-plain-popup-keyboard-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/popup`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({ depth: 6, boxes: false, frameId: null, timeoutMs: 2_000 });
    const openerRef = observed.snapshot.match(/button "Customer location"[^\n]*\[ref=([^\]]+)\]/)?.[1];
    expect(openerRef).toBeDefined();
    if (openerRef === undefined) throw new Error('Plain custom dropdown fixture did not expose its opener ref.');

    await expect(controller.clickRef({
      snapshotId: observed.snapshotId,
      ref: openerRef,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: null,
        expectedVisible: {
          role: 'option',
          name: 'United States',
          exact: true,
          frameId: null,
        },
        timeoutMs: 1_000,
      },
      timeoutMs: 3_000,
    })).resolves.toMatchObject({ postcondition: { passed: true } });
    const page = (controller as unknown as { activePage: Page }).activePage;
    await expect(page.locator('#counters').textContent()).resolves
      .toBe('pointerdowns:0 mousedowns:0 clicks:1 replacements:0');
  });

  it('never falls back or replays when a popup opener detaches during keyboard activation', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Popup keyboard replacement</title></head><body>
        <button id="opener" type="button" aria-haspopup="listbox" aria-expanded="false">
          Funding source
        </button>
        <output id="counters">keydowns:0 pointerdowns:0 clicks:0 replacements:0 replacement-clicks:0</output>
        <script>
          const counters = { keydowns: 0, pointerdowns: 0, clicks: 0, replacements: 0, replacementClicks: 0 };
          const renderCounters = () => {
            document.querySelector('#counters').textContent =
              'keydowns:' + counters.keydowns +
              ' pointerdowns:' + counters.pointerdowns +
              ' clicks:' + counters.clicks +
              ' replacements:' + counters.replacements +
              ' replacement-clicks:' + counters.replacementClicks;
          };
          const wire = (button, replacement) => {
            button.addEventListener('pointerdown', () => { counters.pointerdowns += 1; renderCounters(); });
            button.addEventListener('keydown', (event) => {
              if (event.key !== 'Enter') return;
              counters.keydowns += 1;
              if (!replacement) {
                const next = button.cloneNode(true);
                counters.replacements += 1;
                wire(next, true);
                button.replaceWith(next);
              }
              renderCounters();
            });
            button.addEventListener('click', () => {
              counters.clicks += 1;
              if (replacement) counters.replacementClicks += 1;
              renderCounters();
            });
          };
          wire(document.querySelector('#opener'), false);
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-popup-keyboard-detach-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/popup`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    let failure: Stage5BrowserError | null = null;
    try {
      await controller.clickByRole({
        role: 'button',
        name: 'Funding source',
        exact: true,
        frameId: null,
        postcondition: null,
        timeoutMs: 3_000,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Stage5BrowserError);
      failure = error as Stage5BrowserError;
    }
    expect(failure).not.toBeNull();
    expect(failure).toMatchObject({
      code: 'OPERATION_FAILED',
      details: {
        reason: 'detached',
        actionDispatched: true,
        clickDispatched: false,
        suggestedAction: expect.stringMatching(/do not retry/i),
        dispatchEvidence: {
          forcedFallbackUsed: false,
          pageMouseFallbackUsed: false,
          keyDownOnTarget: true,
          pointerDownOnTarget: false,
          mouseDownOnTarget: false,
          clickOnTarget: false,
          targetConnectedAfter: false,
        },
      },
    });
    expect((await controller.snapshot({ depth: 6, boxes: false, frameId: null, timeoutMs: 2_000 })).snapshot)
      .toContain('keydowns:1 pointerdowns:0 clicks:0 replacements:1 replacement-clicks:0');
  });

  it('reports definite no-dispatch when a native dropdown opener detaches while press is focusing it', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Pre-keyboard replacement</title></head><body>
        <button id="opener" type="button" aria-haspopup="listbox" aria-expanded="false">Funding source</button>
        <output id="counters">focuses:0 keydowns:0 clicks:0 replacements:0</output>
        <script>
          const counters = { focuses: 0, keydowns: 0, clicks: 0, replacements: 0 };
          const renderCounters = () => {
            document.querySelector('#counters').textContent =
              'focuses:' + counters.focuses +
              ' keydowns:' + counters.keydowns +
              ' clicks:' + counters.clicks +
              ' replacements:' + counters.replacements;
          };
          const opener = document.querySelector('#opener');
          opener.addEventListener('focus', () => {
            counters.focuses += 1;
            counters.replacements += 1;
            opener.replaceWith(opener.cloneNode(true));
            renderCounters();
          }, { once: true });
          opener.addEventListener('keydown', () => { counters.keydowns += 1; renderCounters(); });
          opener.addEventListener('click', () => { counters.clicks += 1; renderCounters(); });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-popup-pre-keyboard-detach-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/popup`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    await expect(controller.clickByRole({
      role: 'button',
      name: 'Funding source',
      exact: true,
      frameId: null,
      postcondition: null,
      timeoutMs: 3_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'OPERATION_FAILED',
      details: {
        reason: 'detached',
        actionDispatched: false,
        clickDispatched: false,
        dispatchEvidence: {
          trustedEventObserved: true,
          keyDownOnTarget: false,
          keyUpOnTarget: false,
          pointerDownOnTarget: false,
          mouseDownOnTarget: false,
          clickOnTarget: false,
          targetConnectedAfter: false,
          misdirectedEventBlocked: true,
        },
      },
    });
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: 'click_by_role',
      outcome: 'blocked',
      reason: 'detached',
      actionDispatched: false,
      clickDispatched: false,
    });
    expect((await controller.snapshot({ depth: 6, boxes: false, frameId: null, timeoutMs: 2_000 })).snapshot)
      .toContain('focuses:1 keydowns:0 clicks:0 replacements:1');
  });

  it('re-resolves one unique role target when scrolling replaces it before any input', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Pre-input role replacement</title><style>
        body { margin: 0; min-height: 4200px; }
        #opener { position: absolute; top: 3200px; left: 40px; }
        #counters { position: fixed; top: 10px; left: 10px; }
      </style></head><body>
        <button id="opener" type="button" aria-haspopup="listbox" aria-expanded="false">
          Account purpose
        </button>
        <div id="choices" role="listbox" aria-label="Account purposes" hidden>
          <div role="option">Business operations</div>
        </div>
        <output id="counters">replacements:0 clicks:0</output>
        <script>
          let replacements = 0;
          let clicks = 0;
          const renderCounters = () => {
            document.querySelector('#counters').textContent =
              'replacements:' + replacements + ' clicks:' + clicks;
          };
          const wire = (button) => {
            button.addEventListener('click', (event) => {
              clicks += 1;
              event.currentTarget.setAttribute('aria-expanded', 'true');
              document.querySelector('#choices').hidden = false;
              renderCounters();
            });
          };
          wire(document.querySelector('#opener'));
          addEventListener('scroll', () => {
            if (replacements !== 0) return;
            const current = document.querySelector('#opener');
            const next = current.cloneNode(true);
            replacements += 1;
            wire(next);
            current.replaceWith(next);
            renderCounters();
          }, { passive: true });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-role-reresolve-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/popup`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    await expect(controller.clickByRole({
      role: 'button',
      name: 'Account purpose',
      exact: true,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: null,
        expectedVisible: {
          role: 'option',
          name: 'Business operations',
          exact: true,
          frameId: null,
        },
        timeoutMs: 1_000,
      },
      timeoutMs: 4_000,
    })).resolves.toMatchObject({ postcondition: { passed: true } });
    expect((await controller.snapshot({ depth: 6, boxes: false, frameId: null, timeoutMs: 2_000 })).snapshot)
      .toContain('replacements:1 clicks:1');
  });

  it('reports pointer-sequence replacement as non-retriable partial input without fallback', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Partial pointer replacement</title></head><body>
        <div id="opener" role="button" tabindex="0">Account purpose</div>
        <output id="counters">pointerdowns:0 mousedowns:0 pointerups:0 mouseups:0 clicks:0 replacements:0 replacement-clicks:0</output>
        <script>
          const counters = {
            pointerdowns: 0,
            mousedowns: 0,
            pointerups: 0,
            mouseups: 0,
            clicks: 0,
            replacements: 0,
            replacementClicks: 0,
          };
          const renderCounters = () => {
            document.querySelector('#counters').textContent =
              'pointerdowns:' + counters.pointerdowns +
              ' mousedowns:' + counters.mousedowns +
              ' pointerups:' + counters.pointerups +
              ' mouseups:' + counters.mouseups +
              ' clicks:' + counters.clicks +
              ' replacements:' + counters.replacements +
              ' replacement-clicks:' + counters.replacementClicks;
          };
          const wire = (button, replacement) => {
            button.addEventListener('pointerdown', () => { counters.pointerdowns += 1; renderCounters(); });
            button.addEventListener('mousedown', () => {
              counters.mousedowns += 1;
              if (!replacement) {
                const next = button.cloneNode(true);
                counters.replacements += 1;
                wire(next, true);
                button.replaceWith(next);
              }
              renderCounters();
            });
            button.addEventListener('pointerup', () => { counters.pointerups += 1; renderCounters(); });
            button.addEventListener('mouseup', () => { counters.mouseups += 1; renderCounters(); });
            button.addEventListener('click', () => {
              counters.clicks += 1;
              if (replacement) counters.replacementClicks += 1;
              renderCounters();
            });
          };
          wire(document.querySelector('#opener'), false);
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-partial-pointer-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/popup`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({ depth: 6, boxes: false, frameId: null, timeoutMs: 2_000 });
    const openerRef = observed.snapshot.match(/button "Account purpose"[^\n]*\[ref=([^\]]+)\]/)?.[1];
    expect(openerRef).toBeDefined();
    if (openerRef === undefined) throw new Error('Partial-pointer fixture did not expose its opener ref.');
    const dispatch = vi.spyOn(
      controller as unknown as { dispatchExactHandleClick: (...args: unknown[]) => Promise<void> },
      'dispatchExactHandleClick',
    );

    await expect(controller.clickRef({
      snapshotId: observed.snapshotId,
      ref: openerRef,
      frameId: null,
      postcondition: null,
      timeoutMs: 3_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'OPERATION_FAILED',
      details: {
        reason: 'detached',
        actionDispatched: true,
        clickDispatched: false,
        suggestedAction: expect.stringMatching(/do not retry/i),
        dispatchEvidence: {
          forcedFallbackUsed: false,
          pageMouseFallbackUsed: false,
          trustedEventObserved: true,
          pointerDownOnTarget: true,
          mouseDownOnTarget: true,
          pointerUpOnTarget: false,
          mouseUpOnTarget: false,
          clickOnTarget: false,
          targetConnectedAfter: false,
        },
      },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: 'click_by_ref',
      outcome: 'failed',
      reason: 'detached',
      actionDispatched: true,
      clickDispatched: false,
    });
    const after = await controller.snapshot({ depth: 6, boxes: false, frameId: null, timeoutMs: 2_000 });
    expect(after.snapshot).toContain(
      'pointerdowns:1 mousedowns:1 pointerups:0 mouseups:0 clicks:0 replacements:1 replacement-clicks:0',
    );
    await expect(controller.clickRef({
      snapshotId: observed.snapshotId,
      ref: openerRef,
      frameId: null,
      postcondition: null,
      timeoutMs: 1_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'TARGET_NOT_FOUND',
      details: { reason: 'stale_or_unknown_snapshot' },
    });
    expect((await controller.snapshot({ depth: 6, boxes: false, frameId: null, timeoutMs: 2_000 })).snapshot)
      .toContain('replacements:1 replacement-clicks:0');
  });

  it('accepts an observed postcondition as the terminal result after partial exact-target input', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Partial effect reconciliation</title></head><body>
        <div id="validate" role="button" tabindex="0">Check description</div>
        <a href="#validated" id="result" hidden>Looks good</a>
        <output id="counters">downs:0 clicks:0 replacement-clicks:0</output>
        <script>
          let downs = 0;
          let clicks = 0;
          let replacementClicks = 0;
          const wire = (button, replacement) => {
            button.addEventListener('mousedown', () => {
              downs += 1;
              document.querySelector('#result').hidden = false;
              if (!replacement) {
                const next = button.cloneNode(true);
                wire(next, true);
                button.replaceWith(next);
              }
              document.querySelector('#counters').textContent =
                'downs:' + downs + ' clicks:' + clicks + ' replacement-clicks:' + replacementClicks;
            });
            button.addEventListener('click', () => {
              clicks += 1;
              if (replacement) replacementClicks += 1;
            });
          };
          wire(document.querySelector('#validate'), false);
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-partial-effect-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/validate`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    await expect(controller.clickByRole({
      role: 'button',
      name: 'Check description',
      exact: true,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: null,
        expectedVisible: { role: 'link', name: 'Looks good', exact: true, frameId: null },
        timeoutMs: 1_000,
      },
      timeoutMs: 3_000,
    })).resolves.toMatchObject({ postcondition: { passed: true } });
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: 'click_by_role',
      outcome: 'succeeded',
      actionDispatched: true,
      clickDispatched: false,
      dispatchEvidence: {
        pointerDownOnTarget: true,
        mouseDownOnTarget: true,
        clickOnTarget: false,
      },
    });
    expect((await controller.snapshot({ depth: 6, boxes: false, frameId: null, timeoutMs: 2_000 })).snapshot)
      .toContain('downs:1 clicks:0 replacement-clicks:0');
  });

  it('does not foreground a controller-selected page whose renderer is already visible', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Background-safe input</title></head><body>
        <button type="button" aria-selected="false" onclick="this.setAttribute('aria-selected', 'true')">
          Inspect locally
        </button>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-background-safe-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const page = (controller as unknown as { activePage: Page }).activePage;
    const bringToFront = vi.spyOn(page, 'bringToFront');

    await controller.clickByRole({
      role: 'button',
      name: 'Inspect locally',
      exact: true,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: true,
        expectedVisible: null,
        timeoutMs: 500,
      },
      timeoutMs: 3_000,
    });

    expect(bringToFront).not.toHaveBeenCalled();
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      dispatchEvidence: {
        pageActivation: {
          bringToFrontAttempted: false,
          visibilityBefore: 'visible',
          visibilityAfter: 'visible',
        },
      },
    });
  });

  it('re-resolves a unique role target after page activation replaces it before input', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Activation replacement</title></head><body>
        <button id="opener" type="button" aria-selected="false"
          onclick="this.setAttribute('aria-selected', 'true'); document.querySelector('#counter').textContent = 'clicks:1'">
          Funding source
        </button>
        <output id="counter">clicks:0</output>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-activation-rebind-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const page = (controller as unknown as { activePage: Page }).activePage;
    let activationCount = 0;
    const activation = vi.spyOn(
      controller as unknown as {
        activateSelectedPageForInput: (...args: unknown[]) => Promise<SanitizedPageActivationEvidence>;
      },
      'activateSelectedPageForInput',
    ).mockImplementation(async () => {
      activationCount += 1;
      if (activationCount === 1) {
        await page.locator('#opener').evaluate((opener) => opener.replaceWith(opener.cloneNode(true)));
      }
      return {
        attemptCount: activationCount,
        controllerSelected: true,
        bringToFrontAttempted: activationCount === 1,
        bringToFrontSucceeded: true,
        visibilityBefore: activationCount === 1 ? 'hidden' : 'visible',
        visibilityAfter: 'visible',
        documentFocusedBefore: false,
        documentFocusedAfter: true,
        nativeWindow: {
          required: activationCount === 1,
          attempted: activationCount === 1,
          supported: true,
          ownedProcessAvailable: true,
          ownedProcessRunning: true,
          targetWindowResolved: true,
          windowStateBefore: 'normal',
          normalizationAttempted: false,
          normalizationSucceeded: null,
          applicationActivationAttempted: activationCount === 1,
          applicationActivationSucceeded: true,
          applicationHiddenBefore: false,
          unhideAttempted: false,
          unhideSucceeded: null,
          activationRequestAccepted: true,
          frontProcessFallbackAttempted: false,
          frontProcessFallbackProcessResolved: null,
          frontProcessFallbackRequestSucceeded: null,
          applicationFrontmostAfter: true,
          applicationHiddenAfter: false,
          result: activationCount === 1 ? 'activated' : 'not_required',
        },
      };
    });

    await expect(controller.clickByRole({
      role: 'button',
      name: 'Funding source',
      exact: true,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: true,
        expectedVisible: null,
        timeoutMs: 1_000,
      },
      timeoutMs: 3_000,
    })).resolves.toMatchObject({ postcondition: { passed: true } });
    expect(activation).toHaveBeenCalledTimes(2);
    await expect(page.locator('#counter').textContent()).resolves.toBe('clicks:1');
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: 'click_by_role',
      outcome: 'succeeded',
      actionDispatched: true,
      clickDispatched: true,
    });
  });

  it('rebinds a fresh ref to one semantically identical in-scope replacement after page activation', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Reference activation replacement</title></head><body>
        <button id="outside" type="button">Funding source</button>
        <div role="dialog" aria-modal="true" aria-label="Business details">
          <button id="opener" type="button" aria-selected="false"
            onclick="this.setAttribute('aria-selected', 'true'); document.querySelector('#counter').textContent = 'clicks:1'">
            Funding source
          </button>
          <output id="counter">clicks:0</output>
        </div>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-ref-activation-rebind-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({ depth: 6, boxes: false, frameId: null, timeoutMs: 2_000 });
    expect(observed.scope).toBe('modal');
    const openerRef = observed.snapshot.match(/button "Funding source"[^\n]*\[ref=([^\]]+)\]/)?.[1];
    expect(openerRef).toBeDefined();
    if (openerRef === undefined) throw new Error('Activation replacement fixture did not expose its opener ref.');

    const page = (controller as unknown as { activePage: Page }).activePage;
    let activationCount = 0;
    const activation = vi.spyOn(
      controller as unknown as {
        activateSelectedPageForInput: (...args: unknown[]) => Promise<SanitizedPageActivationEvidence>;
      },
      'activateSelectedPageForInput',
    ).mockImplementation(async () => {
      activationCount += 1;
      if (activationCount === 1) {
        await page.locator('#opener').evaluate((opener) => opener.replaceWith(opener.cloneNode(true)));
      }
      return {
        attemptCount: activationCount,
        controllerSelected: true,
        bringToFrontAttempted: activationCount === 1,
        bringToFrontSucceeded: true,
        visibilityBefore: activationCount === 1 ? 'hidden' : 'visible',
        visibilityAfter: 'visible',
        documentFocusedBefore: false,
        documentFocusedAfter: true,
        nativeWindow: {
          required: activationCount === 1,
          attempted: activationCount === 1,
          supported: true,
          ownedProcessAvailable: true,
          ownedProcessRunning: true,
          targetWindowResolved: true,
          windowStateBefore: 'normal',
          normalizationAttempted: false,
          normalizationSucceeded: null,
          applicationActivationAttempted: activationCount === 1,
          applicationActivationSucceeded: true,
          applicationHiddenBefore: false,
          unhideAttempted: false,
          unhideSucceeded: null,
          activationRequestAccepted: true,
          frontProcessFallbackAttempted: false,
          frontProcessFallbackProcessResolved: null,
          frontProcessFallbackRequestSucceeded: null,
          applicationFrontmostAfter: true,
          applicationHiddenAfter: false,
          result: activationCount === 1 ? 'activated' : 'not_required',
        },
      };
    });

    await expect(controller.clickRef({
      snapshotId: observed.snapshotId,
      ref: openerRef,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: true,
        expectedVisible: null,
        timeoutMs: 1_000,
      },
      timeoutMs: 3_000,
    })).resolves.toMatchObject({ postcondition: { passed: true } });
    expect(activation).toHaveBeenCalledTimes(2);
    await expect(page.locator('#counter').textContent()).resolves.toBe('clicks:1');
    await expect(page.locator('#outside').getAttribute('aria-selected')).resolves.toBeNull();
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: 'click_by_ref',
      outcome: 'succeeded',
      actionDispatched: true,
      clickDispatched: true,
    });
  });

  it('fails closed when activation creates multiple in-scope semantic replacements for a fresh ref', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Ambiguous reference replacement</title></head><body>
        <div role="dialog" aria-modal="true" aria-label="Business details">
          <button id="opener" type="button" onclick="document.querySelector('#counter').textContent = 'clicks:1'">
            Funding source
          </button>
          <output id="counter">clicks:0</output>
        </div>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-ref-activation-ambiguous-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({ depth: 6, boxes: false, frameId: null, timeoutMs: 2_000 });
    const openerRef = observed.snapshot.match(/button "Funding source"[^\n]*\[ref=([^\]]+)\]/)?.[1];
    expect(openerRef).toBeDefined();
    if (openerRef === undefined) throw new Error('Ambiguous replacement fixture did not expose its opener ref.');

    const page = (controller as unknown as { activePage: Page }).activePage;
    vi.spyOn(
      controller as unknown as {
        activateSelectedPageForInput: (...args: unknown[]) => Promise<SanitizedPageActivationEvidence>;
      },
      'activateSelectedPageForInput',
    ).mockImplementation(async (...args) => {
      const attemptCount = typeof args[1] === 'number' ? args[1] : 1;
      if (attemptCount === 1) {
        await page.locator('#opener').evaluate((opener) => {
          const first = opener.cloneNode(true);
          const second = opener.cloneNode(true);
          opener.replaceWith(first, second);
        });
      }
      return {
        attemptCount,
        controllerSelected: true,
        bringToFrontAttempted: attemptCount === 1,
        bringToFrontSucceeded: true,
        visibilityBefore: attemptCount === 1 ? 'hidden' : 'visible',
        visibilityAfter: 'visible',
        documentFocusedBefore: false,
        documentFocusedAfter: true,
        nativeWindow: {
          required: attemptCount === 1,
          attempted: attemptCount === 1,
          supported: true,
          ownedProcessAvailable: true,
          ownedProcessRunning: true,
          targetWindowResolved: true,
          windowStateBefore: 'normal',
          normalizationAttempted: false,
          normalizationSucceeded: null,
          applicationActivationAttempted: attemptCount === 1,
          applicationActivationSucceeded: true,
          applicationHiddenBefore: false,
          unhideAttempted: false,
          unhideSucceeded: null,
          activationRequestAccepted: true,
          frontProcessFallbackAttempted: false,
          frontProcessFallbackProcessResolved: null,
          frontProcessFallbackRequestSucceeded: null,
          applicationFrontmostAfter: true,
          applicationHiddenAfter: false,
          result: attemptCount === 1 ? 'activated' : 'not_required',
        },
      };
    });

    await expect(controller.clickRef({
      snapshotId: observed.snapshotId,
      ref: openerRef,
      frameId: null,
      postcondition: null,
      timeoutMs: 3_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'AMBIGUOUS_TARGET',
      details: {
        reason: 'reference_semantic_rebind_ambiguous',
        actionDispatched: false,
        clickDispatched: false,
      },
    });
    await expect(page.locator('#counter').textContent()).resolves.toBe('clicks:0');
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: 'click_by_ref',
      outcome: 'blocked',
      reason: 'ambiguous_target',
      actionDispatched: false,
      clickDispatched: false,
    });
  });

  it('hit-tests the visible clipped portion of a target inside an overflow container', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Clipped actionability</title><style>
        #dialog { position: relative; width: 320px; height: 80px; overflow: hidden; }
        #target { position: absolute; top: 60px; left: 10px; width: 180px; height: 100px; }
      </style></head><body>
        <div id="dialog" role="dialog" aria-label="Business details">
          <button id="target" type="button">Visible clipped control</button>
        </div>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-clipped-target-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const page = (controller as unknown as { activePage: Page }).activePage;
    const state = await inspectTargetState(page.locator('#target') as Locator);
    expect(state).toMatchObject({
      visible: true,
      enabled: true,
      inViewport: true,
      receivesPointerEvents: true,
      coveredBy: null,
    });
  });

  it('recaptures a suspiciously uniform screenshot when semantic content exists', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Uniform canvas</title><style>
        html, body { margin: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
        canvas { display: block; width: 1px; height: 1px; }
      </style></head><body><canvas aria-label="Managed render surface"></canvas></body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-uniform-capture-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const screenshot = await controller.screenshot({ fullPage: false, timeoutMs: 5_000 });
    expect(screenshot.captureEvidence).toMatchObject({
      artifactClassification: 'possibly_uniform',
      semanticContentPresent: true,
      retryUsed: true,
      pageActivation: {
        controllerSelected: true,
        visibilityAfter: 'visible',
      },
    });
  });

  it('keeps an auxiliary player from stealing the active tab and recovers the sole remaining tab', async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (request.url === '/player') {
        response.end(`<!doctype html><html><head><title>Embedded player</title></head><body>
          <h1>YouTube player</h1>
          <script>setTimeout(() => window.close(), 150)</script>
        </body></html>`);
        return;
      }
      response.end(`<!doctype html><html><head><title>X post</title></head><body>
        <h1>X post verification</h1>
        <button type="button" onclick="window.open('/player', 'youtube-player')">Open player</button>
      </body></html>`);
    });
    const port = await listen(server);
    const postUrl = `http://127.0.0.1:${port}/post`;

    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-active-tab-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: postUrl,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    await controller.clickByRole({
      role: 'button',
      name: 'Open player',
      exact: true,
      frameId: null,
      postcondition: null,
      timeoutMs: 5_000,
    });

    const whilePlayerIsOpen = await controller.snapshot({
      depth: 6,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(whilePlayerIsOpen.page.url).toBe(postUrl);
    expect(whilePlayerIsOpen.snapshot).toContain('X post verification');
    expect(whilePlayerIsOpen.snapshot).not.toContain('YouTube player');

    await new Promise((resolve) => setTimeout(resolve, 250));
    const tabs = await controller.tabs();
    expect(tabs.pages).toHaveLength(1);
    expect(tabs.pages[0]?.url).toBe(postUrl);
    expect(tabs.activePageIndex).toBe(0);
  });

  it('restores the exact opaque Chromium target instead of choosing among duplicate tabs', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Duplicate application</title></head><body>Application</body></html>');
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-target-continuity-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/application`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const firstPage = (controller as unknown as { activePage: Page }).activePage;
    await controller.open({
      url: `http://127.0.0.1:${port}/application`,
      newTab: true,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const internals = controller as unknown as {
      activePage: Page;
      nativeControlRecord: NativeControlRecord | null;
      chromiumTargetId: (page: Page) => Promise<string | null>;
      restoreNativeSelectedPage: (pages: Page[]) => Promise<Page | null>;
    };
    const secondPage = internals.activePage;
    const selectedTargetId = await internals.chromiumTargetId(firstPage);
    expect(selectedTargetId).not.toBeNull();
    internals.nativeControlRecord = {
      version: 1,
      kind: 'chromium_cdp',
      browser: 'chromium',
      state: 'controlled',
      processId: process.pid,
      port: 29_123,
      createdAt: '2026-08-25T00:00:00.000Z',
      selectedTargetId,
    };

    await expect(internals.restoreNativeSelectedPage([secondPage, firstPage])).resolves.toBe(firstPage);
  });

  it('returns bounded unique rendered-line context around text matches', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Noisy social feed</title></head><body>
        <nav>Management navigation</nav>
        <article>
          <h2>Concise Korean video title</h2>
          <blockquote>Repeated quoted context</blockquote>
          <blockquote>Repeated quoted context</blockquote>
          <blockquote>Repeated quoted context</blockquote>
          <p>The Economist interview excerpt</p>
          <a href="https://example.com/post/123">Corresponding social post link</a>
          <p>Full thumbnail beneath the link</p>
        </article>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-find-context-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const found = await controller.findText({
      query: 'Economist',
      mode: 'contains',
      caseSensitive: false,
      maxResults: 10,
      frameId: null,
      timeoutMs: 5_000,
    });

    expect(found).toMatchObject({ matchCount: 1, returnedCount: 1, truncated: false });
    const snippet = found.matches[0]?.snippet ?? '';
    expect(snippet.split('\n')).toHaveLength(5);
    expect(snippet).toContain('Concise Korean video title');
    expect(snippet).toContain('Repeated quoted context');
    expect(snippet.match(/Repeated quoted context/g)).toHaveLength(1);
    expect(snippet).toMatch(/> \d+: The Economist interview excerpt/);
    expect(snippet).toContain('Corresponding social post link');
    expect(snippet).toContain('Full thumbnail beneath the link');
  });

  it('incrementally scrolls to fresh refs, safely rebinds virtualization, and fails closed', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Offscreen references</title><style>
        body { margin: 0; }
        #spacer { height: 2200px; }
        #impossible { position: fixed; top: 2000px; left: 10px; }
      </style></head><body>
        <button id="impossible" type="button">Impossible action</button>
        <article id="virtualized-post">
          <h2>Known virtualized post</h2>
          <div id="spacer"></div>
          <button type="button" onclick="void 0">See more</button>
          <a id="expanded" href="#expanded" hidden>Expanded caption</a>
        </article>
        <script>
          let replaced = false;
          addEventListener('scroll', () => {
            if (replaced) return;
            replaced = true;
            const current = document.querySelector('#virtualized-post');
            const replacement = current.cloneNode(true);
            replacement.querySelector('button').setAttribute(
              'onclick',
              "document.querySelector('#expanded').hidden = false",
            );
            current.replaceWith(replacement);
          }, { passive: true });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-offscreen-ref-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/post`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const observed = await controller.snapshot({ depth: 8, boxes: false, frameId: null, timeoutMs: 5_000 });
    const seeMoreLine = observed.snapshot.split('\n').find((line) => line.includes('See more'));
    const seeMoreRef = seeMoreLine?.match(/\[ref=([^\]]+)\]/)?.[1];
    expect(seeMoreRef).toBeDefined();
    if (seeMoreRef === undefined) {
      throw new Error('Fixture did not expose the offscreen See more reference.');
    }
    await expect(controller.clickRef({
      snapshotId: observed.snapshotId,
      ref: seeMoreRef,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: null,
        expectedVisible: { role: 'link', name: 'Expanded caption', exact: true, frameId: null },
        timeoutMs: 1_000,
      },
      timeoutMs: 5_000,
    })).resolves.toMatchObject({ postcondition: { passed: true } });
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: 'click_by_ref',
      outcome: 'succeeded',
      actionDispatched: true,
      clickDispatched: true,
      targetState: { inViewport: true },
    });

    const impossibleObservation = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    const impossibleLine = impossibleObservation.snapshot.split('\n')
      .find((line) => line.includes('Impossible action'));
    const impossibleRef = impossibleLine?.match(/\[ref=([^\]]+)\]/)?.[1];
    expect(impossibleRef).toBeDefined();
    if (impossibleRef === undefined) {
      throw new Error('Fixture did not expose the impossible offscreen reference.');
    }
    const failedAt = Date.now();
    await expect(controller.clickRef({
      snapshotId: impossibleObservation.snapshotId,
      ref: impossibleRef,
      frameId: null,
      postcondition: null,
      timeoutMs: 5_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'OPERATION_FAILED',
      details: {
        actionDispatched: false,
        clickDispatched: false,
        targetState: { inViewport: false },
      },
    });
    expect(Date.now() - failedAt).toBeLessThan(3_000);
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: 'click_by_ref',
      outcome: 'blocked',
      actionDispatched: false,
      clickDispatched: false,
      targetState: { inViewport: false },
    });
    await expect(controller.clickRef({
      snapshotId: impossibleObservation.snapshotId,
      ref: impossibleRef,
      frameId: null,
      postcondition: null,
      timeoutMs: 5_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'TARGET_NOT_FOUND',
      details: { reason: 'stale_or_unknown_snapshot' },
    });
  });

  it('rejects ambiguous article-scoped replacements after feed virtualization', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Ambiguous virtualization</title><style>
        body { margin: 0; }
        .spacer { height: 2200px; }
      </style></head><body>
        <article id="virtualized-post">
          <h2>Duplicated virtualized post</h2>
          <div class="spacer"></div>
          <button type="button">See more</button>
        </article>
        <script>
          let replaced = false;
          addEventListener('scroll', () => {
            if (replaced) return;
            replaced = true;
            const current = document.querySelector('#virtualized-post');
            current.replaceWith(current.cloneNode(true), current.cloneNode(true));
          }, { passive: true });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-ambiguous-ref-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/post`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const observed = await controller.snapshot({ depth: 8, boxes: false, frameId: null, timeoutMs: 5_000 });
    const seeMoreLine = observed.snapshot.split('\n').find((line) => line.includes('See more'));
    const seeMoreRef = seeMoreLine?.match(/\[ref=([^\]]+)\]/)?.[1];
    expect(seeMoreRef).toBeDefined();
    if (seeMoreRef === undefined) {
      throw new Error('Fixture did not expose the ambiguous offscreen reference.');
    }

    await expect(controller.clickRef({
      snapshotId: observed.snapshotId,
      ref: seeMoreRef,
      frameId: null,
      postcondition: null,
      timeoutMs: 5_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'AMBIGUOUS_TARGET',
      details: {
        reason: 'virtualized_target_rebind_ambiguous',
        actionDispatched: false,
        clickDispatched: false,
      },
    });
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: 'click_by_ref',
      outcome: 'blocked',
      reason: 'ambiguous_target',
      actionDispatched: false,
      clickDispatched: false,
    });
  });

  it('uses a guarded forced dispatch only after proving the stable-click attempt emitted no event', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Animated exact target</title><style>
        @keyframes continuous-motion {
          from { transform: translateX(0); }
          to { transform: translateX(40px); }
        }
        #moving-target {
          animation: continuous-motion 100ms linear infinite alternate;
          margin: 100px;
          width: 240px;
          height: 48px;
        }
      </style></head><body>
        <div id="moving-target" role="button" tabindex="0"
          onclick="document.querySelector('#expanded').hidden = false">See more</div>
        <a id="expanded" href="#expanded" hidden>Expanded moving caption</a>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-guarded-dispatch-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/post`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const observed = await controller.snapshot({ depth: 8, boxes: false, frameId: null, timeoutMs: 5_000 });
    const seeMoreLine = observed.snapshot.split('\n').find((line) => line.includes('See more'));
    const seeMoreRef = seeMoreLine?.match(/\[ref=([^\]]+)\]/)?.[1];
    expect(seeMoreRef).toBeDefined();
    if (seeMoreRef === undefined) {
      throw new Error('Fixture did not expose the moving exact-target reference.');
    }

    await expect(controller.clickRef({
      snapshotId: observed.snapshotId,
      ref: seeMoreRef,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: null,
        expectedVisible: {
          role: 'link',
          name: 'Expanded moving caption',
          exact: true,
          frameId: null,
        },
        timeoutMs: 1_000,
      },
      timeoutMs: 5_000,
    })).resolves.toMatchObject({ postcondition: { passed: true } });
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: 'click_by_ref',
      outcome: 'succeeded',
      actionDispatched: true,
      clickDispatched: true,
      dispatchEvidence: {
        strategy: 'guarded_exact_handle',
        forcedFallbackUsed: true,
        guardExpired: false,
        targetConnectedBefore: true,
        targetConnectedAtFirstEvent: true,
        targetConnectedAfter: true,
        trustedEventObserved: true,
        pointerDownOnTarget: true,
        mouseDownOnTarget: true,
        pointerUpOnTarget: true,
        mouseUpOnTarget: true,
        clickOnTarget: true,
        misdirectedEventBlocked: false,
        targetStateChangeBlocked: false,
      },
    });
  });

  it('activates the selected page and uses page mouse only after both handle paths emit zero events', async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (request.url === '/auxiliary') {
        response.end('<!doctype html><html><head><title>Auxiliary tab</title></head><body>Auxiliary</body></html>');
        return;
      }
      response.end(`<!doctype html><html><head><title>Foreground dispatch target</title></head><body>
        <button type="button" onclick="window.open('/auxiliary', 'auxiliary')">Open auxiliary</button>
        <div id="target" role="button" tabindex="0"
          onclick="document.querySelector('#expanded').hidden = false">See more</div>
        <a id="expanded" href="#expanded" hidden>Expanded foreground caption</a>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-page-mouse-dispatch-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/post`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    await controller.clickByRole({
      role: 'button',
      name: 'Open auxiliary',
      exact: true,
      frameId: null,
      postcondition: null,
      timeoutMs: 5_000,
    });

    const observed = await controller.snapshot({ depth: 8, boxes: false, frameId: null, timeoutMs: 5_000 });
    const seeMoreLine = observed.snapshot.split('\n').find((line) => line.includes('See more'));
    const seeMoreRef = seeMoreLine?.match(/\[ref=([^\]]+)\]/)?.[1];
    expect(seeMoreRef).toBeDefined();
    if (seeMoreRef === undefined) {
      throw new Error('Fixture did not expose the foreground exact-target reference.');
    }

    const exactHandleDispatch = vi.spyOn(
      controller as unknown as { dispatchExactHandleClick: () => Promise<void> },
      'dispatchExactHandleClick',
    );
    exactHandleDispatch
      .mockRejectedValueOnce(new Error('Timeout 750ms exceeded while waiting for element stability.'))
      .mockRejectedValueOnce(new Error('The forced exact-handle transport returned without an event.'));

    await expect(controller.clickRef({
      snapshotId: observed.snapshotId,
      ref: seeMoreRef,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: null,
        expectedVisible: {
          role: 'link',
          name: 'Expanded foreground caption',
          exact: true,
          frameId: null,
        },
        timeoutMs: 1_000,
      },
      timeoutMs: 5_000,
    })).resolves.toMatchObject({ postcondition: { passed: true } });
    expect(exactHandleDispatch).toHaveBeenCalledTimes(2);
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: 'click_by_ref',
      outcome: 'succeeded',
      actionDispatched: true,
      clickDispatched: true,
      dispatchEvidence: {
        strategy: 'guarded_exact_handle',
        forcedFallbackUsed: true,
        pageMouseFallbackUsed: true,
        pageActivation: {
          attemptCount: 4,
          controllerSelected: true,
          bringToFrontAttempted: false,
          bringToFrontSucceeded: false,
          visibilityAfter: 'visible',
          documentFocusedAfter: true,
        },
        guardExpired: false,
        trustedEventObserved: true,
        pointerDownOnTarget: true,
        mouseDownOnTarget: true,
        pointerUpOnTarget: true,
        mouseUpOnTarget: true,
        clickOnTarget: true,
        misdirectedEventBlocked: false,
        targetStateChangeBlocked: false,
      },
    });
  });

  it('restores the exact owned Chromium window before dispatch when the selected page stays hidden', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Native activation target</title></head><body>
        <button id="target" type="button"
          onclick="document.querySelector('#expanded').hidden = false">See more</button>
        <a id="expanded" href="#expanded" hidden>Expanded after native activation</a>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-native-activation-'));
    const config = browserConfig(temporaryRoot);
    let nativeApplicationActivated = false;
    const activateOwnedProcess = vi.fn(async () => {
      nativeApplicationActivated = true;
      return {
        attempted: true,
        supported: true,
        ownedProcessRunning: true,
        applicationActivated: false,
        applicationHiddenBefore: true,
        unhideAttempted: true,
        unhideSucceeded: true,
        activationRequestAccepted: true,
        frontProcessFallbackAttempted: true,
        frontProcessFallbackProcessResolved: true,
        frontProcessFallbackRequestSucceeded: true,
        applicationFrontmostAfter: false,
        applicationHiddenAfter: false,
        reason: 'activation_state_unverified' as const,
      };
    });
    const activator: OwnedBrowserWindowActivator = {
      supported: true,
      activateOwnedProcess,
    };
    controller = new BrowserController(
      config,
      config.browser,
      undefined,
      undefined,
      undefined,
      undefined,
      activator,
    );
    await controller.open({
      url: `http://127.0.0.1:${port}/post`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({ depth: 8, boxes: false, frameId: null, timeoutMs: 5_000 });
    const seeMoreRef = observed.snapshot
      .split('\n')
      .find((line) => line.includes('See more'))
      ?.match(/\[ref=([^\]]+)\]/)?.[1];
    expect(seeMoreRef).toBeDefined();
    if (seeMoreRef === undefined) {
      throw new Error('Fixture did not expose the native-activation target reference.');
    }

    config.headless = false;
    const internals = controller as unknown as {
      controlledBrowserProcessId: number | null;
      observePageActivation: () => Promise<{
        documentFocused: boolean | null;
        visibility: 'hidden' | 'prerender' | 'unknown' | 'visible';
      }>;
      prepareChromiumTargetWindow: () => Promise<{
        targetWindowResolved: boolean;
        windowStateBefore: 'fullscreen' | 'maximized' | 'minimized' | 'normal' | 'unknown';
        normalizationAttempted: boolean;
        normalizationSucceeded: boolean | null;
      }>;
    };
    internals.controlledBrowserProcessId = 42_424;
    vi.spyOn(internals, 'observePageActivation').mockImplementation(async () => ({
      documentFocused: true,
      visibility: nativeApplicationActivated ? 'visible' : 'hidden',
    }));
    const prepareWindow = vi.spyOn(internals, 'prepareChromiumTargetWindow').mockResolvedValue({
      targetWindowResolved: true,
      windowStateBefore: 'minimized',
      normalizationAttempted: true,
      normalizationSucceeded: true,
    });

    await expect(controller.clickRef({
      snapshotId: observed.snapshotId,
      ref: seeMoreRef,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: null,
        expectedVisible: {
          role: 'link',
          name: 'Expanded after native activation',
          exact: true,
          frameId: null,
        },
        timeoutMs: 1_000,
      },
      timeoutMs: 5_000,
    })).resolves.toMatchObject({ postcondition: { passed: true } });
    expect(prepareWindow).toHaveBeenCalledTimes(1);
    expect(activateOwnedProcess).toHaveBeenCalledWith(42_424, 1_000);
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: 'click_by_ref',
      outcome: 'succeeded',
      actionDispatched: true,
      dispatchEvidence: {
        pageActivation: {
          visibilityBefore: 'hidden',
          visibilityAfter: 'visible',
          nativeWindow: {
            required: true,
            attempted: true,
            ownedProcessAvailable: true,
            ownedProcessRunning: true,
            targetWindowResolved: true,
            windowStateBefore: 'minimized',
            normalizationAttempted: true,
            normalizationSucceeded: true,
            applicationActivationAttempted: true,
            applicationActivationSucceeded: false,
            activationRequestAccepted: true,
            frontProcessFallbackAttempted: true,
            frontProcessFallbackProcessResolved: true,
            frontProcessFallbackRequestSucceeded: true,
            applicationFrontmostAfter: false,
            result: 'activated',
          },
        },
      },
    });
  });

  it('dispatches no input when native activation cannot make the selected page visible', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Hidden native target</title></head><body>
        <button id="target" type="button"
          onclick="document.querySelector('#danger').hidden = false">See more</button>
        <p id="danger" hidden>Input was dispatched</p>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-native-hidden-'));
    const config = browserConfig(temporaryRoot);
    const activateOwnedProcess = vi.fn(async () => ({
      attempted: true,
      supported: true,
      ownedProcessRunning: true,
      applicationActivated: true,
      applicationHiddenBefore: false,
      unhideAttempted: false,
      unhideSucceeded: null,
      activationRequestAccepted: true,
      frontProcessFallbackAttempted: false,
      frontProcessFallbackProcessResolved: null,
      frontProcessFallbackRequestSucceeded: null,
      applicationFrontmostAfter: true,
      applicationHiddenAfter: false,
      reason: 'activated' as const,
    }));
    controller = new BrowserController(
      config,
      config.browser,
      undefined,
      undefined,
      undefined,
      undefined,
      { supported: true, activateOwnedProcess },
    );
    await controller.open({
      url: `http://127.0.0.1:${port}/post`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({ depth: 8, boxes: false, frameId: null, timeoutMs: 5_000 });
    const seeMoreRef = observed.snapshot
      .split('\n')
      .find((line) => line.includes('See more'))
      ?.match(/\[ref=([^\]]+)\]/)?.[1];
    expect(seeMoreRef).toBeDefined();
    if (seeMoreRef === undefined) {
      throw new Error('Fixture did not expose the hidden native target reference.');
    }

    config.headless = false;
    const internals = controller as unknown as {
      controlledBrowserProcessId: number | null;
      observePageActivation: () => Promise<{
        documentFocused: boolean | null;
        visibility: 'hidden' | 'prerender' | 'unknown' | 'visible';
      }>;
      prepareChromiumTargetWindow: () => Promise<{
        targetWindowResolved: boolean;
        windowStateBefore: 'fullscreen' | 'maximized' | 'minimized' | 'normal' | 'unknown';
        normalizationAttempted: boolean;
        normalizationSucceeded: boolean | null;
      }>;
    };
    internals.controlledBrowserProcessId = 42_424;
    vi.spyOn(internals, 'observePageActivation').mockResolvedValue({
      documentFocused: true,
      visibility: 'hidden',
    });
    vi.spyOn(internals, 'prepareChromiumTargetWindow').mockResolvedValue({
      targetWindowResolved: true,
      windowStateBefore: 'normal',
      normalizationAttempted: false,
      normalizationSucceeded: null,
    });

    await expect(controller.clickRef({
      snapshotId: observed.snapshotId,
      ref: seeMoreRef,
      frameId: null,
      postcondition: null,
      timeoutMs: 5_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'OPERATION_FAILED',
      details: {
        reason: 'page_not_active',
        actionDispatched: false,
        clickDispatched: false,
        pageActivation: {
          visibilityAfter: 'hidden',
          nativeWindow: {
            applicationActivationSucceeded: true,
            frontProcessFallbackAttempted: false,
            result: 'visibility_unchanged',
          },
        },
      },
    });
    expect(activateOwnedProcess).toHaveBeenCalledTimes(1);
    const rendered = await controller.findText({
      query: 'Input was dispatched',
      mode: 'contains',
      caseSensitive: false,
      maxResults: 10,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(rendered.matchCount).toBe(0);
  });

  it('does not force a click when the exact target detaches before pointer dispatch', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Detached dispatch target</title><style>
        @keyframes continuous-motion {
          from { transform: translateX(0); }
          to { transform: translateX(40px); }
        }
        #unstable-target {
          animation: continuous-motion 100ms linear infinite alternate;
          margin: 100px;
          width: 240px;
          height: 48px;
        }
      </style></head><body>
        <div id="unstable-target" role="button" tabindex="0">See more</div>
        <p id="danger" hidden>Replacement was clicked</p>
        <script>
          const nativeAddEventListener = window.addEventListener.bind(window);
          let dispatchProbeObserved = false;
          window.addEventListener = function(type, listener, options) {
            nativeAddEventListener(type, listener, options);
            if (!dispatchProbeObserved && type === 'pointerdown') {
              dispatchProbeObserved = true;
              setTimeout(() => {
                const current = document.querySelector('#unstable-target');
                const replacement = current.cloneNode(true);
                replacement.removeAttribute('style');
                replacement.setAttribute(
                  'onclick',
                  "document.querySelector('#danger').hidden = false",
                );
                current.replaceWith(replacement);
              }, 50);
            }
          };
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-detached-dispatch-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/post`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const observed = await controller.snapshot({ depth: 8, boxes: false, frameId: null, timeoutMs: 5_000 });
    const seeMoreLine = observed.snapshot.split('\n').find((line) => line.includes('See more'));
    const seeMoreRef = seeMoreLine?.match(/\[ref=([^\]]+)\]/)?.[1];
    expect(seeMoreRef).toBeDefined();
    if (seeMoreRef === undefined) {
      throw new Error('Fixture did not expose the detachable exact-target reference.');
    }

    await expect(controller.clickRef({
      snapshotId: observed.snapshotId,
      ref: seeMoreRef,
      frameId: null,
      postcondition: null,
      timeoutMs: 5_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'OPERATION_FAILED',
      details: {
        reason: 'detached',
        actionDispatched: false,
        clickDispatched: false,
        dispatchEvidence: {
          strategy: 'guarded_exact_handle',
          forcedFallbackUsed: false,
          targetConnectedBefore: true,
          targetConnectedAfter: false,
          trustedEventObserved: false,
          clickOnTarget: false,
        },
      },
    });
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: 'click_by_ref',
      outcome: 'blocked',
      reason: 'detached',
      actionDispatched: false,
      clickDispatched: false,
      dispatchEvidence: {
        forcedFallbackUsed: false,
        targetConnectedAfter: false,
        trustedEventObserved: false,
      },
    });
    const rendered = await controller.findText({
      query: 'Replacement was clicked',
      mode: 'contains',
      caseSensitive: false,
      maxResults: 10,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(rendered.matchCount).toBe(0);
  });

  it('handles timeline scrolling, text search, observed refs, click postconditions, redirects, and rate limits', async () => {
    server = createServer((request, response) => {
      const requestUrl = request.url ?? '/';
      if (requestUrl === '/redirect') {
        response.writeHead(302, { location: '/client-redirect' });
        response.end();
        return;
      }
      if (requestUrl === '/client-redirect') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html><html><head><title>Client redirect</title></head><body>
          <p>Redirecting</p><script>setTimeout(() => location.href = '/final', 50)</script>
        </body></html>`);
        return;
      }
      if (requestUrl === '/final') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><html><head><title>Final page</title></head><body>Final destination</body></html>');
        return;
      }
      if (requestUrl === '/rate-limited') {
        response.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '60' });
        response.end('<!doctype html><html><body>Slow down</body></html>');
        return;
      }
      if (requestUrl === '/destination') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><html><head><title>Observed destination</title></head><body>Reference worked</body></html>');
        return;
      }
      if (requestUrl === '/dynamic') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html><html><head><title>Dynamic timeline</title>
          <style>body { margin: 0; } #dynamic-spacer { height: 1000px; }</style></head><body>
          <article>Recent video</article><div id="dynamic-spacer"></div>
          <script>
            let grew = false;
            addEventListener('scroll', () => {
              if (!grew) {
                grew = true;
                document.querySelector('#dynamic-spacer').style.height = '2500px';
              }
            });
          </script>
        </body></html>`);
        return;
      }

      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Timeline fixture</title>
        <style>body { margin: 0; } #spacer { height: 2200px; }</style></head><body>
        <button role="tab" aria-selected="false" onclick="setTimeout(() => this.setAttribute('aria-selected', 'true'), 50)">Delayed Media</button>
        <button role="tab" aria-selected="false" onclick="document.querySelector('#login').hidden = false">Media</button>
        <div id="login" role="dialog" hidden>Log in to continue</div>
        <a href="/destination"><span aria-hidden="true">decorative</span></a>
        <div id="spacer"></div><p id="older"></p>
        <script>
          addEventListener('scroll', () => {
            if (scrollY > 100) document.querySelector('#older').textContent = 'Rick Rubin archived post';
          });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-timeline-'));
    controller = new BrowserController(browserConfig(temporaryRoot));

    const redirected = await controller.open({
      url: `${baseUrl}/redirect`,
      newTab: false,
      stabilizationMs: 250,
      timeoutMs: 5_000,
    });
    expect(redirected).toMatchObject({
      finalUrl: `${baseUrl}/final`,
      redirected: true,
      redirectChain: [{ kind: 'server', from: `${baseUrl}/redirect`, to: `${baseUrl}/client-redirect`, status: 302 }],
    });
    expect(redirected.observedUrls).toContain(`${baseUrl}/final`);

    const rateLimited = await controller.open({
      url: `${baseUrl}/rate-limited`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    expect(rateLimited.responseStatus).toBe(429);
    expect(rateLimited.warnings).toContainEqual(expect.objectContaining({
      code: 'http_rate_limited',
      status: 429,
      suggestedAction: expect.stringContaining('do not immediately repeat'),
    }));

    await controller.open({
      url: `${baseUrl}/timeline`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const delayedSelection = await controller.clickByRole({
      role: 'tab',
      name: 'Delayed Media',
      exact: true,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: true,
        expectedVisible: null,
        timeoutMs: 100,
      },
      timeoutMs: 5_000,
    });
    expect(delayedSelection.postcondition).toMatchObject({ passed: true });
    await expect(controller.clickByRole({
      role: 'tab',
      name: 'Media',
      exact: true,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: true,
        expectedVisible: null,
        timeoutMs: 250,
      },
      timeoutMs: 5_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'POSTCONDITION_FAILED',
      details: {
        clickDispatched: true,
        actionOutcome: 'click_dispatched_postcondition_failed',
      },
    });

    const scrolled = await controller.scroll({
      direction: 'down',
      amount: 'viewport',
      count: 1,
      settleMs: 100,
      frameId: null,
      endMarker: null,
      target: null,
      waitFor: null,
      timeoutMs: 5_000,
    });
    expect(scrolled.moved).toBe(true);
    const found = await controller.findText({
      query: 'Rick Rubin',
      mode: 'contains',
      caseSensitive: false,
      maxResults: 10,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(found).toMatchObject({ matchCount: 1, returnedCount: 1, textTruncated: false });
    expect(found.matches[0]?.snippet).toContain('Rick Rubin archived post');

    await controller.open({
      url: `${baseUrl}/timeline`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({ depth: 8, boxes: false, frameId: null, timeoutMs: 5_000 });
    const unnamedLink = observed.snapshot.match(/link \[ref=([^\]]+)\]/)?.[1];
    expect(unnamedLink).toBeDefined();
    if (unnamedLink === undefined) {
      throw new Error('Fixture did not expose an unnamed link reference.');
    }
    const clicked = await controller.clickRef({
      snapshotId: observed.snapshotId,
      ref: unnamedLink,
      frameId: null,
      postcondition: {
        expectedUrl: { url: `${baseUrl}/destination`, match: 'exact' },
        expectedSelected: null,
        expectedVisible: null,
        timeoutMs: 2_000,
      },
      timeoutMs: 5_000,
    });
    expect(clicked.postcondition).toMatchObject({ passed: true });
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      outcome: 'succeeded',
      actionDispatched: true,
      clickDispatched: true,
      dispatchEvidence: {
        trustedEventObserved: true,
        clickOnTarget: true,
      },
    });
    await expect(controller.clickRef({
      snapshotId: observed.snapshotId,
      ref: unnamedLink,
      frameId: null,
      postcondition: null,
      timeoutMs: 5_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({ code: 'TARGET_NOT_FOUND' });
    await controller.waitForUrl({
      expected: { url: '/destination', match: 'contains' },
      timeoutMs: 1_000,
    });

    await controller.open({
      url: `${baseUrl}/dynamic`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const dynamicBoundary = await controller.scroll({
      direction: 'down',
      amount: 'viewport',
      count: 8,
      settleMs: 50,
      frameId: null,
      endMarker: null,
      target: null,
      waitFor: null,
      timeoutMs: 5_000,
    });
    expect(dynamicBoundary).toMatchObject({
      documentBoundaryReached: true,
      endReached: false,
      endState: 'dynamic_content_stalled',
    });
    expect(dynamicBoundary.warnings).toContainEqual(expect.objectContaining({
      code: 'dynamic_content_stalled',
    }));

    expect(await controller.authStatus()).toMatchObject({
      state: 'profile_ready',
      authenticated: 'unknown',
      persistentProfile: true,
    });
    await expect(controller.requestLoginHandoff({
      url: null,
      timeoutMs: 5_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({ code: 'AUTH_HANDOFF_UNAVAILABLE' });
    await expect(controller.resumeAfterLogin({
      expected: null,
      timeoutMs: 1_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({ code: 'AUTH_HANDOFF_REQUIRED' });
  });

  it('targets observed nested scrollers, waits for feed growth, correlates diagnostics, and tolerates fractional boundaries', async () => {
    server = createServer((request, response) => {
      if (request.url === '/feed') {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{"ok":true}');
        }, 25);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (request.url === '/modal-scroll') {
        response.end(`<!doctype html><html><head><title>Scrollable modal</title><style>
          body { margin: 0; overflow: hidden; }
          #composer { height: 160px; overflow-y: auto; }
          #modal-spacer { height: 600px; }
        </style></head><body>
          <section id="composer" role="dialog" aria-modal="true" aria-label="Scrollable composer">
            <article>Draft post</article><div id="modal-spacer"></div>
          </section>
        </body></html>`);
        return;
      }
      if (request.url === '/stalled') {
        response.end(`<!doctype html><html><head><title>Stalled feed</title>
          <style>body { margin: 0; height: 1800px; } #loader { position: fixed; inset: auto 10px 10px; width: 120px; height: 20px; }</style>
          </head><body>
          <article>Visible post</article><div id="loader" role="progressbar" aria-label="Loading more posts"></div>
          <script>
            addEventListener('load', () => {
              const root = document.scrollingElement;
              root.scrollTop = Math.max(0, root.scrollHeight - innerHeight - 0.5);
              root.scrollBy = () => undefined;
            });
          </script>
        </body></html>`);
        return;
      }
      response.end(`<!doctype html><html><head><title>Nested feed</title>
        <style>
          body { margin: 0; overflow: hidden; }
          #other-posts { height: 180px; overflow-y: auto; border: 1px solid black; }
          #spacer { height: 700px; }
        </style></head><body>
        <section id="other-posts" role="feed" aria-label="Other posts">
          <article>Echo iPhone app</article><div id="spacer"></div>
        </section>
        <script>
          let requested = false;
          const feed = document.querySelector('#other-posts');
          feed.addEventListener('scroll', () => {
            if (requested) return;
            requested = true;
            const loader = document.createElement('div');
            loader.id = 'loader';
            loader.setAttribute('role', 'progressbar');
            loader.setAttribute('aria-label', 'Loading more posts');
            feed.append(loader);
            fetch('/feed').then(() => setTimeout(() => {
              const article = document.createElement('article');
              article.textContent = 'Newly loaded Stage5 post';
              feed.append(article);
              loader.remove();
            }, 50));
          });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-nested-scroll-'));
    controller = new BrowserController(browserConfig(temporaryRoot));

    await controller.open({
      url: `${baseUrl}/nested`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({ depth: 8, boxes: false, frameId: null, timeoutMs: 5_000 });
    expect(observed).toMatchObject({
      scrollContainerCount: 1,
      scrollContainers: [{ label: 'Other posts', role: 'feed', inViewport: true }],
    });
    const documentAttempt = await controller.scroll({
      direction: 'down',
      amount: 'viewport',
      count: 1,
      settleMs: 0,
      frameId: null,
      endMarker: null,
      target: null,
      waitFor: null,
      timeoutMs: 5_000,
    });
    expect(documentAttempt).toMatchObject({
      moved: false,
      nestedScrollContainerCandidateCount: 1,
    });
    expect(documentAttempt.warnings).toContainEqual(expect.objectContaining({
      code: 'nested_scroll_containers_available',
    }));

    const targetedObservation = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    const containerRef = targetedObservation.scrollContainers[0]?.ref;
    expect(containerRef).toBeDefined();
    if (containerRef === undefined) {
      throw new Error('Fixture did not expose the nested feed scroll container.');
    }

    const nested = await controller.scroll({
      direction: 'down',
      amount: 'viewport',
      count: 1,
      settleMs: 0,
      frameId: null,
      endMarker: null,
      target: { snapshotId: targetedObservation.snapshotId, ref: containerRef },
      waitFor: { condition: 'either', timeoutMs: 1_000 },
      timeoutMs: 5_000,
    });
    expect(nested).toMatchObject({
      target: { kind: 'container', ref: containerRef },
      moved: true,
      documentBoundaryReached: false,
      wait: {
        requested: true,
        satisfied: true,
        evidence: 'article_count_growth',
        before: { articleCount: 1 },
        after: { articleCount: 2, loadingIndicatorCount: 0 },
      },
    });
    const diagnostics = await controller.diagnostics();
    expect(diagnostics.page?.lastAction).toMatchObject({
      action: 'scroll',
      outcome: 'succeeded',
      actionDispatched: true,
      clickDispatched: null,
    });
    expect(diagnostics.page?.lastActionNetworkEvents).toContainEqual(expect.objectContaining({
      kind: 'http_response',
      status: 200,
      url: `${baseUrl}/feed`,
    }));
    await expect(controller.scroll({
      direction: 'down',
      amount: 'viewport',
      count: 1,
      settleMs: 0,
      frameId: null,
      endMarker: null,
      target: { snapshotId: targetedObservation.snapshotId, ref: containerRef },
      waitFor: null,
      timeoutMs: 5_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'TARGET_NOT_FOUND',
      details: { reason: 'stale_or_unknown_snapshot' },
    });

    await controller.open({
      url: `${baseUrl}/modal-scroll`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const modalObservation = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(modalObservation).toMatchObject({
      scope: 'modal',
      scrollContainerCount: 1,
      scrollContainers: [{ label: 'Scrollable composer', role: 'dialog', inViewport: true }],
    });

    await controller.open({
      url: `${baseUrl}/stalled`,
      newTab: false,
      stabilizationMs: 100,
      timeoutMs: 5_000,
    });
    const stalled = await controller.scroll({
      direction: 'down',
      amount: 'viewport',
      count: 1,
      settleMs: 50,
      frameId: null,
      endMarker: null,
      target: null,
      waitFor: { condition: 'either', timeoutMs: 250 },
      timeoutMs: 5_000,
    });
    expect(stalled.before.maxY - stalled.before.y).toBeLessThanOrEqual(1);
    expect(stalled).toMatchObject({
      target: { kind: 'document', ref: null },
      moved: false,
      targetBoundaryReached: true,
      documentBoundaryReached: true,
      endReached: false,
      endState: 'dynamic_content_stalled',
      wait: { requested: true, satisfied: false, evidence: 'timeout' },
    });
    expect(stalled.warnings).toContainEqual(expect.objectContaining({ code: 'content_wait_timed_out' }));
    expect(stalled.warnings).toContainEqual(expect.objectContaining({ code: 'dynamic_content_stalled' }));
  });

  it('scopes document loader waits to the visible semantic feed', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Scoped feed wait</title><style>
        body { margin: 0; }
        #unrelated { position: fixed; top: 5px; right: 5px; width: 80px; height: 20px; }
        #feed-spacer { height: 800px; }
        #feed-loader { width: 120px; height: 20px; }
        #tail { height: 900px; }
      </style></head><body>
        <nav><div id="unrelated" role="progressbar" aria-label="Unrelated management loading"></div></nav>
        <section role="feed" aria-label="Posts">
          <article>Already rendered post</article>
          <div id="feed-spacer"></div>
          <div id="feed-loader" role="progressbar" aria-label="Loading more posts"></div>
          <div id="tail"></div>
        </section>
        <script>
          let scheduled = false;
          addEventListener('scroll', () => {
            if (scheduled) return;
            scheduled = true;
            setTimeout(() => document.querySelector('#feed-loader')?.remove(), 150);
          });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-scoped-feed-wait-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const scrolled = await controller.scroll({
      direction: 'down',
      amount: 'viewport',
      count: 1,
      settleMs: 0,
      frameId: null,
      endMarker: null,
      target: null,
      waitFor: { condition: 'loading_indicators_disappear', timeoutMs: 1_000 },
      timeoutMs: 5_000,
    });
    expect(scrolled.wait).toMatchObject({
      requested: true,
      satisfied: true,
      evidence: 'loading_indicators_disappeared',
      before: { articleCount: 1, loadingIndicatorCount: 1 },
      after: { articleCount: 1, loadingIndicatorCount: 0 },
    });
    expect(scrolled.warnings).not.toContainEqual(expect.objectContaining({ code: 'content_wait_timed_out' }));
  });

  it('pins feed observation scope and treats loading-only status articles as unresolved placeholders', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Stable loading observation</title><style>
        body { margin: 0; min-height: 1800px; }
        #placeholders { position: fixed; top: 20px; left: 20px; width: 320px; }
        #late-feed { position: fixed; top: 180px; left: 20px; width: 320px; height: 120px; }
      </style></head><body>
        <section id="placeholders" aria-label="Other posts">
          <article>
            <span hidden>Cached post text</span>
            <button aria-hidden="true" style="display:none">Hidden template action</button>
            <div role="status">Loading...</div>
          </article>
          <article>
            <span aria-hidden="true">Assistive placeholder text</span>
            <div role="status">Loading...</div>
          </article>
        </section>
        <section id="late-feed" aria-label="Unrelated feed"></section>
        <script>
          addEventListener('scroll', () => {
            document.querySelector('#late-feed')?.setAttribute('role', 'feed');
          }, { once: true });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-stable-loading-observation-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const scrolled = await controller.scroll({
      direction: 'down',
      amount: 'half_viewport',
      count: 1,
      settleMs: 0,
      frameId: null,
      endMarker: null,
      target: null,
      waitFor: { condition: 'article_count_growth', timeoutMs: 1_000 },
      timeoutMs: 1_000,
    });

    expect(scrolled.wait).toMatchObject({
      requested: true,
      satisfied: false,
      evidence: 'timeout',
      before: { articleCount: 0, loadingIndicatorCount: 2 },
      after: { articleCount: 0, loadingIndicatorCount: 2 },
    });
    expect(scrolled).toMatchObject({ stepsCompleted: 1, moved: true });
    expect(scrolled.wait.waitedMs).toBeLessThan(900);
    expect(scrolled.warnings).toContainEqual(expect.objectContaining({ code: 'content_wait_timed_out' }));
  });

  it('does not treat an in-post status as a feed loader when the article has substantive content', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Substantive post status</title><style>
        body { margin: 0; min-height: 1800px; }
      </style></head><body>
        <section role="feed" aria-label="Posts">
          <article><p>Rendered Stage5 post</p><div role="status">Loading comments...</div></article>
        </section>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-substantive-post-status-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const scrolled = await controller.scroll({
      direction: 'down',
      amount: 'half_viewport',
      count: 1,
      settleMs: 0,
      frameId: null,
      endMarker: null,
      target: null,
      waitFor: { condition: 'loading_indicators_disappear', timeoutMs: 150 },
      timeoutMs: 5_000,
    });
    expect(scrolled.wait).toMatchObject({
      satisfied: false,
      evidence: 'timeout',
      before: { articleCount: 1, loadingIndicatorCount: 0 },
      after: { articleCount: 1, loadingIndicatorCount: 0 },
    });
  });

  it('fails closed before dispatch when a scroll observation would truncate semantic candidates', async () => {
    const articles = Array.from(
      { length: 501 },
      (_, index) => `<article>Rendered post ${index + 1}</article>`,
    ).join('');
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Bounded feed observation</title><style>
        body { margin: 0; min-height: 1800px; }
        [role="feed"] { position: fixed; inset: 0; overflow: hidden; }
      </style></head><body><section role="feed" aria-label="Posts">${articles}</section></body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-bounded-feed-observation-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const internals = controller as unknown as {
      performScrollStep: (...args: unknown[]) => Promise<void>;
    };
    const performScrollStep = vi.spyOn(internals, 'performScrollStep');
    await expect(controller.scroll({
      direction: 'down',
      amount: 'half_viewport',
      count: 1,
      settleMs: 0,
      frameId: null,
      endMarker: null,
      target: null,
      waitFor: { condition: 'article_count_growth', timeoutMs: 1_000 },
      timeoutMs: 5_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'OPERATION_FAILED',
      details: {
        reason: 'scroll_observation_incomplete',
        actionDispatched: false,
        stepsCompleted: 0,
      },
    });
    expect(performScrollStep).not.toHaveBeenCalled();
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: 'scroll',
      outcome: 'blocked',
      reason: 'unknown',
      actionDispatched: false,
      clickDispatched: null,
    });
  });

  it('does not let an optional animation-scan cap block explicit loader disappearance', async () => {
    const complexMarkup = Array.from({ length: 5_001 }, () => '<span></span>').join('');
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Complex feed observation</title><style>
        body { margin: 0; min-height: 1800px; }
        [role="feed"] { position: fixed; inset: 0; overflow: hidden; }
      </style></head><body>
        <section role="feed" aria-label="Posts">
          <article id="post"><div role="status">Loading...</div></article>
          <div aria-hidden="true">${complexMarkup}</div>
        </section>
        <script>
          addEventListener('scroll', () => {
            document.querySelector('#post').innerHTML = '<p>Rendered post</p>';
          }, { once: true });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-complex-feed-observation-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const scrolled = await controller.scroll({
      direction: 'down',
      amount: 'half_viewport',
      count: 1,
      settleMs: 0,
      frameId: null,
      endMarker: null,
      target: null,
      waitFor: { condition: 'loading_indicators_disappear', timeoutMs: 1_000 },
      timeoutMs: 5_000,
    });
    expect(scrolled.wait).toMatchObject({
      requested: true,
      satisfied: true,
      evidence: 'loading_indicators_disappeared',
      before: { articleCount: 0, loadingIndicatorCount: 1 },
      after: { articleCount: 1, loadingIndicatorCount: 0 },
    });
    expect(scrolled.stepsCompleted).toBe(1);
  });

  it('allows substantive article growth when only the optional animation scan is capped', async () => {
    const complexMarkup = Array.from({ length: 5_001 }, () => '<span></span>').join('');
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Animated complex feed</title><style>
        body { margin: 0; min-height: 1800px; }
        [role="feed"] { position: fixed; inset: 0; overflow: hidden; }
        #animated-loader { width: 20px; height: 20px; animation: pulse 1s linear infinite; }
        @keyframes pulse { from { opacity: .5; } to { opacity: 1; } }
      </style></head><body>
        <section role="feed" aria-label="Posts">
          <article id="post"><div id="animated-loader"></div></article>
          <div aria-hidden="true">${complexMarkup}</div>
        </section>
        <script>
          addEventListener('scroll', () => {
            document.querySelector('#post').innerHTML = '<p>Rendered post</p>';
          }, { once: true });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-animated-complex-feed-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const scrolled = await controller.scroll({
      direction: 'down',
      amount: 'half_viewport',
      count: 1,
      settleMs: 0,
      frameId: null,
      endMarker: null,
      target: null,
      waitFor: { condition: 'article_count_growth', timeoutMs: 1_000 },
      timeoutMs: 5_000,
    });
    expect(scrolled.wait).toMatchObject({
      requested: true,
      satisfied: true,
      evidence: 'article_count_growth',
      before: { articleCount: 0, loadingIndicatorCount: 1 },
      after: { articleCount: 1, loadingIndicatorCount: 0 },
    });
  });

  it('fails closed when animation-only disappearance depends on a capped scan', async () => {
    const complexMarkup = Array.from({ length: 5_001 }, () => '<span></span>').join('');
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Incomplete animated disappearance</title><style>
        body { margin: 0; min-height: 1800px; }
        [role="feed"] { position: fixed; inset: 0; overflow: hidden; }
        #animated-loader { width: 20px; height: 20px; animation: pulse 1s linear infinite; }
        @keyframes pulse { from { opacity: .5; } to { opacity: 1; } }
      </style></head><body>
        <section role="feed" aria-label="Posts">
          <article id="post"><div id="animated-loader"></div></article>
          <div aria-hidden="true">${complexMarkup}</div>
        </section>
        <script>
          addEventListener('scroll', () => {
            document.querySelector('#post').innerHTML = '<p>Rendered post</p>';
          }, { once: true });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-incomplete-animation-disappearance-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    await expect(controller.scroll({
      direction: 'down',
      amount: 'half_viewport',
      count: 1,
      settleMs: 0,
      frameId: null,
      endMarker: null,
      target: null,
      waitFor: { condition: 'loading_indicators_disappear', timeoutMs: 150 },
      timeoutMs: 5_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'OPERATION_FAILED',
      details: {
        reason: 'scroll_observation_incomplete',
        actionDispatched: true,
        stepsCompleted: 1,
      },
    });
  });

  it('does not mistake a detached pinned feed for loading-indicator disappearance', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Detached feed observation</title><style>
        body { margin: 0; min-height: 1800px; }
        #feed { position: fixed; top: 20px; left: 20px; width: 320px; height: 120px; }
        [role="progressbar"] { width: 120px; height: 20px; }
      </style></head><body>
        <section id="feed" role="feed" aria-label="Posts">
          <article>Rendered post</article>
          <div role="progressbar" aria-label="Loading more posts"></div>
        </section>
        <script>
          addEventListener('scroll', () => {
            const feed = document.querySelector('#feed');
            feed?.replaceWith(feed.cloneNode(true));
          }, { once: true });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-detached-feed-observation-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const startedAt = Date.now();
    await expect(controller.scroll({
      direction: 'down',
      amount: 'half_viewport',
      count: 1,
      settleMs: 0,
      frameId: null,
      endMarker: null,
      target: null,
      waitFor: { condition: 'loading_indicators_disappear', timeoutMs: 10_000 },
      timeoutMs: 15_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'OPERATION_FAILED',
      details: {
        reason: 'scroll_observation_surface_unavailable',
        actionDispatched: true,
        stepsCompleted: 1,
      },
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: 'scroll',
      outcome: 'failed',
      reason: 'detached',
      actionDispatched: true,
      clickDispatched: null,
    });
  });

  it('does not dispatch after page activation consumes the remaining scroll action budget', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Activation budget</title><style>
        body { margin: 0; min-height: 1800px; }
      </style></head><body><article>Budgeted scroll</article></body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-scroll-activation-budget-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const nativeWindow = {
      required: false,
      attempted: false,
      supported: false,
      ownedProcessAvailable: false,
      ownedProcessRunning: null,
      targetWindowResolved: null,
      windowStateBefore: 'unknown',
      normalizationAttempted: false,
      normalizationSucceeded: null,
      applicationActivationAttempted: false,
      applicationActivationSucceeded: null,
      applicationHiddenBefore: null,
      unhideAttempted: false,
      unhideSucceeded: null,
      activationRequestAccepted: null,
      frontProcessFallbackAttempted: false,
      frontProcessFallbackProcessResolved: null,
      frontProcessFallbackRequestSucceeded: null,
      applicationFrontmostAfter: null,
      applicationHiddenAfter: null,
      result: 'not_required',
    };
    const internals = controller as unknown as {
      activateSelectedPageForInput: () => Promise<{
        attemptCount: number;
        controllerSelected: boolean;
        bringToFrontAttempted: boolean;
        bringToFrontSucceeded: boolean;
        visibilityBefore: 'visible';
        visibilityAfter: 'visible';
        documentFocusedBefore: boolean;
        documentFocusedAfter: boolean;
        nativeWindow: typeof nativeWindow;
      }>;
      performScrollStep: (...args: unknown[]) => Promise<void>;
    };
    const actualNow = Date.now.bind(Date);
    let clockOffsetMs = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => actualNow() + clockOffsetMs);
    let activationCalls = 0;
    vi.spyOn(internals, 'activateSelectedPageForInput').mockImplementation(async () => {
      activationCalls += 1;
      if (activationCalls === 2) {
        clockOffsetMs = 4_400;
      }
      return {
        attemptCount: activationCalls,
        controllerSelected: true,
        bringToFrontAttempted: true,
        bringToFrontSucceeded: true,
        visibilityBefore: 'visible',
        visibilityAfter: 'visible',
        documentFocusedBefore: true,
        documentFocusedAfter: true,
        nativeWindow,
      };
    });
    const performScrollStep = vi.spyOn(internals, 'performScrollStep');

    try {
      const result = await controller.scroll({
        direction: 'down',
        amount: 'half_viewport',
        count: 1,
        settleMs: 0,
        frameId: null,
        endMarker: null,
        target: null,
        waitFor: null,
        timeoutMs: 5_000,
      });
      expect(result.stepsCompleted).toBe(0);
      expect(performScrollStep).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it('does not accept content evidence observed after the bounded wait deadline', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Late content observation</title><style>
        body { margin: 0; min-height: 1800px; }
        [role="feed"] { position: fixed; inset: 0; }
      </style></head><body>
        <section role="feed" aria-label="Posts"></section>
        <script>
          addEventListener('scroll', () => {
            document.querySelector('[role="feed"]').innerHTML = '<article>Late rendered post</article>';
          }, { once: true });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-late-content-observation-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const internals = controller as unknown as {
      scrollContentObservation: (frame: unknown, surface: unknown) => Promise<unknown>;
    };
    const originalObservation = internals.scrollContentObservation.bind(controller);
    const actualNow = Date.now.bind(Date);
    let clockOffsetMs = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => actualNow() + clockOffsetMs);
    let observationCalls = 0;
    vi.spyOn(internals, 'scrollContentObservation').mockImplementation(async (frame, surface) => {
      observationCalls += 1;
      const observation = await originalObservation(frame, surface);
      if (observationCalls === 2) {
        clockOffsetMs = 1_500;
        return {
          ...(observation as Record<string, unknown>),
          articleCount: 1,
        };
      }
      return observation;
    });

    try {
      const result = await controller.scroll({
        direction: 'down',
        amount: 'half_viewport',
        count: 1,
        settleMs: 0,
        frameId: null,
        endMarker: null,
        target: null,
        waitFor: { condition: 'article_count_growth', timeoutMs: 1_000 },
        timeoutMs: 5_000,
      });
      expect(result.wait).toMatchObject({
        requested: true,
        satisfied: false,
        evidence: 'timeout',
        before: { articleCount: 0 },
        after: { articleCount: 1 },
      });
      expect(result.wait.waitedMs).toBeGreaterThan(1_000);
    } finally {
      now.mockRestore();
    }
  });

  it('fails scroll closed before dispatch when the controller-selected renderer cannot become visible', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Hidden scroll target</title><style>
        body { margin: 0; min-height: 1800px; }
      </style></head><body><article>Never scrolled</article></body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-hidden-scroll-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const internals = controller as unknown as {
      activateSelectedPageForInput: () => Promise<{
        attemptCount: number;
        controllerSelected: boolean;
        bringToFrontAttempted: boolean;
        bringToFrontSucceeded: boolean;
        visibilityBefore: 'hidden';
        visibilityAfter: 'hidden';
        documentFocusedBefore: boolean;
        documentFocusedAfter: boolean;
        nativeWindow: Record<string, unknown>;
      }>;
      performScrollStep: (...args: unknown[]) => Promise<void>;
      scrollPosition: (...args: unknown[]) => Promise<unknown>;
    };
    vi.spyOn(internals, 'activateSelectedPageForInput').mockResolvedValue({
      attemptCount: 1,
      controllerSelected: true,
      bringToFrontAttempted: true,
      bringToFrontSucceeded: true,
      visibilityBefore: 'hidden',
      visibilityAfter: 'hidden',
      documentFocusedBefore: true,
      documentFocusedAfter: true,
      nativeWindow: {
        required: true,
        attempted: true,
        supported: true,
        ownedProcessAvailable: true,
        ownedProcessRunning: true,
        targetWindowResolved: true,
        windowStateBefore: 'normal',
        normalizationAttempted: false,
        normalizationSucceeded: null,
        applicationActivationAttempted: true,
        applicationActivationSucceeded: false,
        applicationHiddenBefore: false,
        unhideAttempted: false,
        unhideSucceeded: null,
        activationRequestAccepted: true,
        frontProcessFallbackAttempted: true,
        frontProcessFallbackProcessResolved: true,
        frontProcessFallbackRequestSucceeded: true,
        applicationFrontmostAfter: false,
        applicationHiddenAfter: false,
        result: 'visibility_unchanged',
      },
    });
    const performScrollStep = vi.spyOn(internals, 'performScrollStep');
    const scrollPosition = vi.spyOn(internals, 'scrollPosition');

    await expect(controller.scroll({
      direction: 'down',
      amount: 'half_viewport',
      count: 1,
      settleMs: 0,
      frameId: null,
      endMarker: null,
      target: null,
      waitFor: null,
      timeoutMs: 5_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'OPERATION_FAILED',
      details: {
        reason: 'page_not_active',
        actionDispatched: false,
        stepsCompleted: 0,
        pageActivation: {
          visibilityBefore: 'hidden',
          visibilityAfter: 'hidden',
        },
      },
    });
    expect(performScrollStep).not.toHaveBeenCalled();
    expect(scrollPosition).not.toHaveBeenCalled();
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: 'scroll',
      outcome: 'blocked',
      reason: 'page_not_active',
      actionDispatched: false,
      clickDispatched: null,
    });
  });

  it('does not replay a completed scroll step when renderer visibility is lost before the next step', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Visibility lost between scrolls</title><style>
        body { margin: 0; min-height: 2700px; }
      </style></head><body><article>One bounded step</article></body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-scroll-visibility-loss-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const nativeWindow = {
      required: false,
      attempted: false,
      supported: false,
      ownedProcessAvailable: false,
      ownedProcessRunning: null,
      targetWindowResolved: null,
      windowStateBefore: 'unknown',
      normalizationAttempted: false,
      normalizationSucceeded: null,
      applicationActivationAttempted: false,
      applicationActivationSucceeded: null,
      applicationHiddenBefore: null,
      unhideAttempted: false,
      unhideSucceeded: null,
      activationRequestAccepted: null,
      frontProcessFallbackAttempted: false,
      frontProcessFallbackProcessResolved: null,
      frontProcessFallbackRequestSucceeded: null,
      applicationFrontmostAfter: null,
      applicationHiddenAfter: null,
      result: 'not_required',
    };
    const internals = controller as unknown as {
      activateSelectedPageForInput: () => Promise<{
        attemptCount: number;
        controllerSelected: boolean;
        bringToFrontAttempted: boolean;
        bringToFrontSucceeded: boolean;
        visibilityBefore: 'hidden' | 'visible';
        visibilityAfter: 'hidden' | 'visible';
        documentFocusedBefore: boolean;
        documentFocusedAfter: boolean;
        nativeWindow: typeof nativeWindow;
      }>;
      performScrollStep: (...args: unknown[]) => Promise<void>;
    };
    vi.spyOn(internals, 'activateSelectedPageForInput')
      .mockResolvedValueOnce({
        attemptCount: 1,
        controllerSelected: true,
        bringToFrontAttempted: true,
        bringToFrontSucceeded: true,
        visibilityBefore: 'visible',
        visibilityAfter: 'visible',
        documentFocusedBefore: true,
        documentFocusedAfter: true,
        nativeWindow,
      })
      .mockResolvedValueOnce({
        attemptCount: 2,
        controllerSelected: true,
        bringToFrontAttempted: true,
        bringToFrontSucceeded: true,
        visibilityBefore: 'visible',
        visibilityAfter: 'visible',
        documentFocusedBefore: true,
        documentFocusedAfter: true,
        nativeWindow,
      })
      .mockResolvedValueOnce({
        attemptCount: 3,
        controllerSelected: true,
        bringToFrontAttempted: true,
        bringToFrontSucceeded: true,
        visibilityBefore: 'hidden',
        visibilityAfter: 'hidden',
        documentFocusedBefore: true,
        documentFocusedAfter: true,
        nativeWindow,
      });
    const performScrollStep = vi.spyOn(internals, 'performScrollStep');

    await expect(controller.scroll({
      direction: 'down',
      amount: 'half_viewport',
      count: 2,
      settleMs: 0,
      frameId: null,
      endMarker: null,
      target: null,
      waitFor: null,
      timeoutMs: 5_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'OPERATION_FAILED',
      details: {
        reason: 'page_not_active',
        actionDispatched: true,
        stepsCompleted: 1,
        pageActivation: {
          visibilityAfter: 'hidden',
        },
      },
    });
    expect(performScrollStep).toHaveBeenCalledTimes(1);
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: 'scroll',
      outcome: 'failed',
      reason: 'page_not_active',
      actionDispatched: true,
      clickDispatched: null,
    });
  });

  it('discovers hidden file inputs and sets only fresh snapshot-bound regular files', async () => {
    server = createServer((request, response) => {
      if (request.url === '/upload' && request.method === 'POST') {
        request.resume();
        setTimeout(() => {
          response.writeHead(204);
          response.end();
        }, 25);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Upload fixture</title></head><body>
        <div role="dialog" aria-modal="true" aria-label="Post composer">
          <h1>Create post</h1>
          <input id="media" type="file" accept="video/mp4" hidden>
          <script>
            document.addEventListener('input', (event) => {
              const input = event.target;
              if (!(input instanceof HTMLInputElement) || input.id !== 'media' || input.files.length === 0) return;
              document.querySelector('#preview').textContent = input.files[0].name;
              const progress = document.querySelector('#progress');
              progress.hidden = false;
              progress.value = 25;
              fetch('/upload', { method: 'POST', body: 'fixture' }).then(() => {
                progress.value = 100;
                document.querySelector('#complete').hidden = false;
              });
              input.value = '';
            }, { capture: true });
          </script>
          <p id="preview"></p>
          <progress id="progress" max="100" value="0" hidden></progress>
          <button id="complete" hidden>Processing complete</button>
        </div>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-upload-'));
    const videoPath = path.join(temporaryRoot, 'rick-rubin-test.mp4');
    await writeFile(videoPath, Buffer.alloc(1_024, 7));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/composer`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const observed = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(observed).toMatchObject({
      fileInputCount: 1,
      fileInputs: [{
        accept: 'video/mp4',
        multiple: false,
        disabled: false,
        visible: false,
      }],
    });
    const fileRef = observed.fileInputs[0]?.ref;
    expect(fileRef).toBeDefined();
    if (fileRef === undefined) {
      throw new Error('Fixture did not expose the hidden file input.');
    }

    await expect(controller.setInputFiles({
      snapshotId: observed.snapshotId,
      ref: fileRef,
      paths: ['relative-video.mp4'],
      frameId: null,
      completion: null,
      observationMs: 0,
      previewDepth: 8,
      timeoutMs: 5_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'INVALID_FILE',
      details: { reason: 'file_path_not_absolute', fileIndex: 0 },
    });

    const selected = await controller.setInputFiles({
      snapshotId: observed.snapshotId,
      ref: fileRef,
      paths: [videoPath],
      frameId: null,
      completion: {
        expectedComplete: {
          role: 'button',
          name: 'Processing complete',
          exact: true,
          frameId: null,
        },
        expectedError: null,
        timeoutMs: 2_000,
      },
      observationMs: 100,
      previewDepth: 8,
      timeoutMs: 5_000,
    });
    expect(selected).toMatchObject({
      selection: {
        dispatched: true,
        confirmedByInput: true,
        fileCount: 1,
        totalBytes: 1_024,
        files: [{ name: 'rick-rubin-test.mp4', sizeBytes: 1_024 }],
      },
      attachmentPreview: { available: true },
      processing: {
        state: 'completion_observed',
        evidence: 'expected_completion_visible',
      },
    });
    expect(selected.attachmentPreview.snapshot).toContain('Processing complete');
    expect(JSON.stringify(selected)).not.toContain(temporaryRoot);

    await expect(controller.setInputFiles({
      snapshotId: observed.snapshotId,
      ref: fileRef,
      paths: [videoPath],
      frameId: null,
      completion: null,
      observationMs: 0,
      previewDepth: 8,
      timeoutMs: 5_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'TARGET_NOT_FOUND',
      details: { reason: 'stale_or_unknown_snapshot' },
    });
  });

  it('hands authentication to an uncontrolled browser, scopes deep modals, and reports bounded diagnostics', async () => {
    let authenticated = false;
    server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://fixture.invalid');
      if (requestUrl.pathname === '/missing') {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('missing');
        return;
      }
      if (requestUrl.pathname === '/success') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
        return;
      }
      if (requestUrl.pathname === '/background') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><html><head><title>Background tab</title></head><body>Background</body></html>');
        return;
      }
      if (requestUrl.pathname === '/login') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        if (authenticated) {
          response.end('<!doctype html><html><head><title>Stage5 account</title></head><body><h1>Signed in</h1><a href="/account">Stage5 account</a></body></html>');
          return;
        }
        response.end(`<!doctype html><html><head><title>Login modal</title><style>
          #continue-wrap { display: inline-block; position: relative; }
          #cover { position: absolute; inset: 0; z-index: 100; background: transparent; }
        </style></head><body>
          <main><section><div><div><div><div><div><div><div><div><div><div>
            <div role="dialog" aria-modal="true" aria-labelledby="login-heading">
              <h2 id="login-heading">Sign in</h2>
              <label for="username">Username</label><input id="username" />
              <span id="continue-wrap"><button type="button">Continue</button><span id="cover"></span></span>
              <button type="button" aria-selected="false" onclick="fetch('/success?token=private-success-value').then(() => this.setAttribute('aria-selected', 'true'))">Use password</button>
            </div>
          </div></div></div></div></div></div></div></div></div></div></section></main>
          <script>
            console.error('automation rejection private-console-value');
            fetch('/missing?otp=private-network-value#fragment');
            setTimeout(() => { throw new Error('private-page-error-value'); }, 10);
            setTimeout(() => {
              const popup = window.open('/background?token=private-popup-value', 'background');
              popup?.blur();
              window.focus();
            }, 25);
          </script>
        </body></html>`);
        return;
      }

      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Initial</title></head><body>Initial</body></html>');
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-auth-modal-'));
    const config = browserConfig(temporaryRoot);
    humanLauncher = new FakeHumanBrowserLauncher();
    controller = new BrowserController(config, config.browser, humanLauncher);
    await controller.open({ url: `${baseUrl}/login`, newTab: false, timeoutMs: 5_000 });

    const tabs = await controller.tabs();
    const loginTab = tabs.pages.find((page) => page.url === `${baseUrl}/login`);
    const backgroundTab = tabs.pages.find((page) => page.url.startsWith(`${baseUrl}/background`));
    expect(loginTab).toBeDefined();
    expect(backgroundTab).toBeDefined();
    if (backgroundTab === undefined || loginTab === undefined) {
      throw new Error('Fixture did not expose both authentication tabs.');
    }
    await controller.selectTab({ index: loginTab.index });
    expect((await controller.tabs()).activePageIndex).toBe(loginTab.index);

    const snapshot = await controller.snapshot({ depth: 4, boxes: false, frameId: null, timeoutMs: 5_000 });
    expect(snapshot).toMatchObject({ scope: 'modal', visibleModalCount: 1, warnings: [] });
    expect(snapshot.snapshot).toContain('Username');
    expect(snapshot.snapshot).toContain('Continue');
    expect(snapshot.refCount).toBeGreaterThanOrEqual(2);

    const selectedBackground = await controller.selectTab({ index: backgroundTab.index });
    expect(selectedBackground.authenticationTargetUpdated).toBe(false);
    await controller.selectTab({ index: loginTab.index });

    await expect(controller.clickByRole({
      role: 'button',
      name: 'Continue',
      exact: true,
      frameId: null,
      postcondition: null,
      timeoutMs: 1_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'OPERATION_FAILED',
      details: {
        reason: 'pointer_intercepted',
        clickDispatched: false,
        actionOutcome: 'blocked',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const diagnostics = await controller.diagnostics();
    expect(diagnostics.page).toMatchObject({
      pageUrl: `${baseUrl}/login`,
      totals: {
        pageErrors: 1,
        httpErrors: 1,
      },
      lastAction: {
        action: 'click_by_role',
        outcome: 'blocked',
        reason: 'pointer_intercepted',
        clickDispatched: false,
        targetState: {
          visible: true,
          enabled: true,
          receivesPointerEvents: false,
          role: 'button',
          coveredBy: { tagName: 'span' },
        },
      },
    });
    expect(diagnostics.page?.totals.consoleErrors).toBeGreaterThanOrEqual(1);
    expect(diagnostics.page?.consoleEvents).toContainEqual(expect.objectContaining({
      category: 'automation_rejection',
      fingerprint: expect.stringMatching(/^[a-f0-9]{12}$/),
    }));
    expect(diagnostics.page?.networkEvents).toContainEqual(expect.objectContaining({
      kind: 'http_error',
      status: 404,
      url: `${baseUrl}/missing`,
    }));
    const serializedDiagnostics = JSON.stringify(diagnostics);
    expect(serializedDiagnostics).not.toContain('private-console-value');
    expect(serializedDiagnostics).not.toContain('private-network-value');
    expect(serializedDiagnostics).not.toContain('private-page-error-value');
    expect(serializedDiagnostics).not.toContain('private-popup-value');

    await controller.clickByRole({
      role: 'button',
      name: 'Use password',
      exact: true,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: true,
        expectedVisible: null,
        timeoutMs: 1_000,
      },
      timeoutMs: 2_000,
    });
    const successfulDiagnostics = await controller.diagnostics();
    expect(successfulDiagnostics.page?.lastActionNetworkEvents).toContainEqual(expect.objectContaining({
      kind: 'http_response',
      status: 200,
      url: `${baseUrl}/success`,
    }));
    expect(successfulDiagnostics.page?.totals.httpSuccesses).toBeGreaterThan(0);

    // The controlled test browser is headless; only the injected native launcher runs during
    // handoff, so the regression exercises the lifecycle without opening a real GUI.
    config.headless = false;
    const handoff = await controller.requestLoginHandoff({
      url: `${baseUrl}/login`,
      timeoutMs: 5_000,
    });
    expect(handoff).toMatchObject({
      state: 'awaiting_user',
      browserConnected: false,
      targetOrigin: baseUrl,
      targetPageAvailable: false,
      page: null,
      controlMode: 'human_bootstrap',
      profileBinding: {
        userDataDir: config.profileDir,
        profileDirectory: 'Default',
        profilePath: path.join(config.profileDir, 'Default'),
      },
      humanBootstrap: {
        running: true,
        controlledByPlaywright: false,
        automationFlagsPresent: false,
        exactUserInteractionsObserved: false,
        handoffLabel: expect.stringContaining('Stage5 chromium'),
        launchIdentity: {
          browser: 'chromium',
          engine: 'chromium',
          applicationName: expect.any(String),
          profile: {
            userDataDir: config.profileDir,
            profileDirectory: 'Default',
          },
        },
      },
    });
    expect(handoff.instructions).toContain(handoff.humanBootstrap!.launchIdentity.applicationName);
    expect(handoff.instructions).not.toContain('may not exit Brave');
    expect(humanLauncher.launches).toHaveLength(1);
    expect(humanLauncher.launches[0]).toMatchObject({
      profileDir: config.profileDir,
      url: `${baseUrl}/login`,
      target: { browser: 'chromium', engine: 'chromium' },
    });
    await expect(controller.tabs()).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'AUTH_HANDOFF_REQUIRED',
    });
    await expect(controller.stop()).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'AUTH_HANDOFF_REQUIRED',
    });
    const humanDiagnostics = await controller.diagnostics();
    expect(humanDiagnostics.automationExposure).toEqual({
      controlMode: 'human_bootstrap',
      controlledByPlaywright: false,
      enableAutomationArgument: 'absent',
      navigatorWebdriver: null,
      navigatorWebdriverObserved: false,
      observation: 'uncontrolled_browser_not_instrumented',
    });

    await expect(controller.resumeAfterLogin({
      expected: { url: `${baseUrl}/login`, match: 'exact' },
      timeoutMs: 1_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'AUTH_HANDOFF_REQUIRED',
      details: { reason: 'human_browser_still_running' },
    });

    authenticated = true;
    await humanLauncher.finish(true);
    const expectedRuntimeProfilePath = await realpath(path.join(config.profileDir, 'Default'));
    const resumed = await controller.resumeAfterLogin({
      expected: { url: `${baseUrl}/login`, match: 'exact' },
      timeoutMs: 5_000,
    });
    expect(resumed).toMatchObject({
      state: 'ready_for_agent_verification',
      verificationRequired: true,
      controlMode: 'playwright',
      humanBootstrap: {
        running: false,
        profileShutdown: {
          state: 'clean',
          exitType: 'normal',
          exitedCleanly: true,
          exitedCleanlySource: 'process_exit',
          profileDirectory: 'Default',
          currentSessionEvidence: 'clean_process_exit',
          reattachmentDecision: 'allowed',
        },
      },
      lastHandoffOutcome: {
        observation: 'sanitized_before_after_boundary',
        exactUserInteractionsObserved: false,
        beforeUrl: `${baseUrl}/login`,
        afterUrl: `${baseUrl}/login`,
        routeChanged: false,
        semanticStructureChanged: true,
        launchIdentityMatched: true,
        runtimeProfile: {
          source: expect.stringMatching(/^chromium_(command_line|version_page)$/),
          profilePath: expectedRuntimeProfilePath,
          matchesConfigured: true,
        },
        storageContinuity: {
          state: expect.stringMatching(/preserved|unverified/),
          afterControlledStart: {
            cookieDatabase: { inspection: 'live_context_metadata' },
          },
          afterTargetLoad: {
            cookieDatabase: { inspection: 'live_context_metadata' },
          },
          targetOriginLoadedAtControlledStart: false,
          navigatorWebdriverAtControlledStart: true,
        },
      },
    });
    expect(resumed.verificationPreview).toMatchObject({
      observation: 'bounded_semantic_preview',
      available: true,
      snapshot: expect.stringContaining('Signed in'),
    });
    const resumedDiagnostics = await controller.diagnostics();
    expect(resumedDiagnostics.automationExposure).toMatchObject({
      controlMode: 'playwright',
      controlledByPlaywright: true,
      enableAutomationArgument: 'present',
      navigatorWebdriver: true,
      navigatorWebdriverObserved: true,
    });
    const verified = await controller.snapshot({ depth: 4, boxes: false, frameId: null, timeoutMs: 5_000 });
    expect(verified.snapshot).toContain('Signed in');
    expect(await controller.authStatus()).toMatchObject({
      state: 'profile_ready',
      verificationRequired: false,
      lastHandoffOutcome: { semanticStructureChanged: true },
    });
  });

  it('resumes a Firefox handoff after a delayed profile unlock without relaunching control', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Firefox handoff</title></head><body><button>Continue</button></body></html>');
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-firefox-handoff-'));
    const config = {
      ...browserConfig(temporaryRoot),
      browser: 'firefox' as const,
      profileDir: path.join(temporaryRoot, 'profiles', 'firefox'),
    };
    humanLauncher = new FakeHumanBrowserLauncher();
    controller = new BrowserController(config, 'firefox', humanLauncher);
    await controller.open({
      url: `http://127.0.0.1:${port}/private-step`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    config.headless = false;

    const retainedLock = path.join(config.profileDir, 'lock');
    await writeFile(retainedLock, 'delayed-firefox-unlock');
    const firstAttemptAt = Date.now();
    await expect(controller.requestLoginHandoff({
      url: null,
      timeoutMs: 1_500,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'AUTH_HANDOFF_REQUIRED',
      details: {
        reason: 'handoff_release_pending',
        phase: 'process_exited',
        ownershipRetained: true,
        profileLockFiles: expect.arrayContaining(['lock']),
      },
    });
    expect(Date.now() - firstAttemptAt).toBeLessThan(2_000);
    expect(humanLauncher.launches).toHaveLength(0);
    expect(await controller.authStatus()).toMatchObject({
      state: 'releasing_control',
      controlMode: 'human_bootstrap',
      targetOrigin: `http://127.0.0.1:${port}`,
    });

    await rm(retainedLock);
    expect(await waitForProfileUnlock(config.profileDir, 30_000)).toBe(true);
    const resumed = await controller.requestLoginHandoff({ url: null, timeoutMs: 5_000 });
    expect(resumed).toMatchObject({
      state: 'awaiting_user',
      userActionRequired: true,
      humanBootstrap: { launchIdentity: { browser: 'firefox', engine: 'firefox' } },
    });
    expect(humanLauncher.launches).toHaveLength(1);
  });

  it('reattaches after a zero process exit even when Chromium retains a crashed marker', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Login</title></head><body><h1>Login</h1></body></html>');
    });
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/login`;
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-stale-exit-marker-'));
    const config = browserConfig(temporaryRoot);
    humanLauncher = new FakeHumanBrowserLauncher();
    controller = new BrowserController(config, config.browser, humanLauncher);
    await controller.open({ url, newTab: false, timeoutMs: 5_000 });
    config.headless = false;
    await controller.requestLoginHandoff({ url, timeoutMs: 5_000 });
    await humanLauncher.finish(false, 0);

    const resumed = await controller.resumeAfterLogin({ expected: null, timeoutMs: 5_000 });
    expect(resumed).toMatchObject({
      state: 'ready_for_agent_verification',
      humanBootstrap: {
        running: false,
        profileShutdown: {
          state: 'clean',
          exitType: 'crashed',
          exitedCleanly: true,
          exitedCleanlySource: 'process_exit',
          profileLocks: [],
          currentSessionEvidence: 'clean_process_exit',
          reattachmentDecision: 'allowed',
        },
      },
    });
  });

  it('offers one explicit unlocked-profile override after an abnormal human-browser exit', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Login</title></head><body><h1>Login</h1></body></html>');
    });
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/login`;
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-unclean-auth-'));
    const config = browserConfig(temporaryRoot);
    humanLauncher = new FakeHumanBrowserLauncher();
    controller = new BrowserController(config, config.browser, humanLauncher);
    await controller.open({ url, newTab: false, timeoutMs: 5_000 });
    config.headless = false;
    await controller.requestLoginHandoff({ url, timeoutMs: 5_000 });
    await humanLauncher.finish(false);

    await expect(controller.resumeAfterLogin({ expected: null, timeoutMs: 2_000 })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'AUTH_HANDOFF_REQUIRED',
      details: {
        reason: 'abnormal_human_browser_process_exit',
        exitType: 'crashed',
        exitedCleanly: false,
        overrideAvailable: true,
        suggestedAction: expect.not.stringContaining('Request a new login handoff'),
      },
    });
    expect(await controller.authStatus()).toMatchObject({
      state: 'awaiting_user',
      browserConnected: false,
      humanBootstrap: {
        running: false,
        profileShutdown: {
          state: 'unclean',
          currentSessionEvidence: 'abnormal_process_exit',
          reattachmentDecision: 'override_available',
        },
      },
    });

    const resumed = await controller.resumeAfterLogin({ expected: null, timeoutMs: 5_000 });
    expect(resumed).toMatchObject({
      state: 'ready_for_agent_verification',
      humanBootstrap: {
        running: false,
        profileShutdown: {
          state: 'unknown',
          profileLocks: [],
          reattachmentDecision: 'explicit_unlocked_profile_override',
        },
      },
    });
  });

  it('rejects an origin-only authentication URL expectation before reattachment', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Login</title></head><body><h1>Login</h1></body></html>');
    });
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-origin-auth-'));
    const config = browserConfig(temporaryRoot);
    humanLauncher = new FakeHumanBrowserLauncher();
    controller = new BrowserController(config, config.browser, humanLauncher);
    await controller.open({ url: `${origin}/login`, newTab: false, timeoutMs: 5_000 });
    config.headless = false;
    await controller.requestLoginHandoff({ url: null, timeoutMs: 5_000 });
    await humanLauncher.finish(true);

    await expect(controller.resumeAfterLogin({
      expected: { url: origin, match: 'prefix' },
      timeoutMs: 2_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'OPERATION_FAILED',
      details: {
        reason: 'auth_url_expectation_too_weak',
      },
    });
    expect(await controller.authStatus()).toMatchObject({
      state: 'awaiting_user',
      browserConnected: false,
    });
  });

  it('accepts an exact post-login route when the site appends an incidental query', async () => {
    server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (requestUrl.pathname === '/personal-profile' && requestUrl.search === '') {
        response.writeHead(302, { location: '/personal-profile?checkpoint_src=any' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Profile</title></head><body><h1>Signed-in personal profile</h1></body></html>');
    });
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    const expectedRoute = `${origin}/personal-profile`;
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-auth-query-'));
    const config = browserConfig(temporaryRoot);
    const offlineInspections = [
      storageInspection(origin, []),
      storageInspection(origin, ['human-added-key']),
    ];
    const controlledInspections = [
      storageInspection(origin, ['human-added-key']),
      storageInspection(origin, ['human-added-key']),
    ];
    humanLauncher = new FakeHumanBrowserLauncher();
    controller = new BrowserController(
      config,
      config.browser,
      humanLauncher,
      async () => {
        const inspection = offlineInspections.shift();
        if (inspection === undefined) throw new Error('Unexpected offline storage inspection.');
        return inspection;
      },
      async () => {
        const inspection = controlledInspections.shift();
        if (inspection === undefined) throw new Error('Unexpected controlled storage inspection.');
        return inspection;
      },
    );
    await controller.open({ url: expectedRoute, newTab: false, timeoutMs: 5_000 });
    config.headless = false;
    await controller.requestLoginHandoff({ url: null, timeoutMs: 5_000 });
    await humanLauncher.finish(true);

    const resumed = await controller.resumeAfterLogin({
      expected: { url: expectedRoute, match: 'exact' },
      timeoutMs: 2_000,
    });
    expect(resumed).toMatchObject({
      state: 'ready_for_agent_verification',
      browserConnected: true,
      page: { url: `${expectedRoute}?checkpoint_src=any` },
      lastHandoffOutcome: {
        storageContinuity: {
          state: 'preserved',
          lossBoundary: 'none',
          humanSessionEvidenceObserved: true,
        },
      },
    });
    expect(resumed.verificationPreview.snapshot).toContain('Signed-in personal profile');
  });

  it('returns AUTH_NOT_PERSISTED when a human session cannot reach the non-root post-login route', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Account</title></head><body><button>Sign in</button></body></html>');
    });
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    const url = `${origin}/account`;
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-lost-auth-'));
    const config = browserConfig(temporaryRoot);
    const offlineInspections = [
      storageInspection(origin, []),
      storageInspection(origin, ['human-added-key']),
    ];
    const controlledInspections = [
      storageInspection(origin, ['human-added-key']),
      storageInspection(origin, ['human-added-key']),
    ];
    humanLauncher = new FakeHumanBrowserLauncher();
    controller = new BrowserController(
      config,
      config.browser,
      humanLauncher,
      async () => {
        const inspection = offlineInspections.shift();
        if (inspection === undefined) {
          throw new Error('Unexpected offline profile-storage inspection.');
        }
        return inspection;
      },
      async () => {
        const inspection = controlledInspections.shift();
        if (inspection === undefined) {
          throw new Error('Unexpected controlled profile-storage inspection.');
        }
        return inspection;
      },
    );
    await controller.open({ url, newTab: false, timeoutMs: 5_000 });
    config.headless = false;
    await controller.requestLoginHandoff({ url: null, timeoutMs: 5_000 });
    await humanLauncher.finish(true);

    await expect(controller.resumeAfterLogin({
      expected: { url: `${origin}/signed-in`, match: 'exact' },
      timeoutMs: 500,
    }))
      .rejects.toMatchObject<Partial<Stage5BrowserError>>({
        code: 'AUTH_NOT_PERSISTED',
        details: {
          reason: 'post_login_url_not_reached',
          storageContinuity: { humanSessionEvidenceObserved: true },
        },
      });
    expect(await controller.authStatus()).toMatchObject({
      state: 'ready_for_agent_verification',
      browserConnected: true,
      lastHandoffOutcome: {
        launchIdentityMatched: true,
        storageContinuity: { humanSessionEvidenceObserved: true },
      },
    });
  });

  it('returns the exact storage-loss boundary before asking the user to repeat login', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Account</title></head><body><button>Sign in</button></body></html>');
    });
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    const url = `${origin}/account`;
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-storage-boundary-'));
    const config = browserConfig(temporaryRoot);
    const offlineInspections = [
      storageInspection(origin, []),
      storageInspection(origin, ['human-added-key']),
    ];
    const controlledInspections = [
      storageInspection(origin, ['human-added-key']),
      storageInspection(origin, []),
    ];
    humanLauncher = new FakeHumanBrowserLauncher();
    controller = new BrowserController(
      config,
      config.browser,
      humanLauncher,
      async () => {
        const inspection = offlineInspections.shift();
        if (inspection === undefined) {
          throw new Error('Unexpected offline profile-storage inspection.');
        }
        return inspection;
      },
      async () => {
        const inspection = controlledInspections.shift();
        if (inspection === undefined) {
          throw new Error('Unexpected controlled profile-storage inspection.');
        }
        return inspection;
      },
    );
    await controller.open({ url, newTab: false, timeoutMs: 5_000 });
    config.headless = false;
    await controller.requestLoginHandoff({ url: null, timeoutMs: 5_000 });
    await humanLauncher.finish(true);

    await expect(controller.resumeAfterLogin({ expected: null, timeoutMs: 2_000 }))
      .rejects.toMatchObject<Partial<Stage5BrowserError>>({
        code: 'AUTH_NOT_PERSISTED',
        details: {
          reason: 'authentication_storage_lost',
          storageContinuity: {
            lossBoundary: 'target_load',
            automationCorrelation: 'loss_after_automation_exposure',
            humanSessionEvidenceObserved: true,
          },
        },
      });
    expect(await controller.authStatus()).toMatchObject({
      state: 'ready_for_agent_verification',
      browserConnected: true,
      lastHandoffOutcome: {
        storageContinuity: { lossBoundary: 'target_load', state: 'lost' },
      },
    });
  });

  it('inspects and acts inside an observed cross-origin frame without coordinate guessing', async () => {
    frameServer = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><body>
        <h2>Embedded Groove Lab</h2>
        <label for="song">Song name</label><input id="song" />
        <button type="button" onclick="document.querySelector('#result').textContent='Frame clicked'">
          Download Boss Battle
        </button>
        <p id="result"></p>
      </body></html>`);
    });
    const framePort = await listen(frameServer);

    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Frame host</title></head><body>
        <h1>Outer application</h1>
        <iframe name="groove-lab" src="http://127.0.0.1:${framePort}/embedded?token=secret#fragment"></iframe>
      </body></html>`);
    });
    const hostPort = await listen(server);

    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-frame-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    for (const [index, browser] of (['chromium', 'firefox', 'webkit'] as const).entries()) {
      if (index > 0) {
        await controller.switchBrowser({ browser });
      }
      await controller.open({
        url: `http://127.0.0.1:${hostPort}/host`,
        newTab: false,
        timeoutMs: 5_000,
      });

      const inventory = await controller.frames();
      const embedded = inventory.frames.find((frame) => frame.name === 'groove-lab');
      expect(embedded).toBeDefined();
      expect(embedded?.url).toBe(`http://127.0.0.1:${framePort}/embedded`);
      if (embedded === undefined) {
        throw new Error(`Cross-origin fixture frame was not observed in ${browser}.`);
      }

      const snapshot = await controller.snapshot({
        depth: 8,
        boxes: false,
        frameId: embedded.id,
        timeoutMs: 5_000,
      });
      expect(snapshot.snapshot).toContain('Embedded Groove Lab');

      await controller.fillByRole({
        role: 'textbox',
        name: 'Song name',
        exact: true,
        frameId: embedded.id,
        value: 'Boss Battle',
        timeoutMs: 5_000,
      });
      await controller.clickByRole({
        role: 'button',
        name: 'Download Boss Battle',
        exact: true,
        frameId: embedded.id,
        postcondition: null,
        timeoutMs: 5_000,
      });

      const after = await controller.snapshot({
        depth: 8,
        boxes: false,
        frameId: embedded.id,
        timeoutMs: 5_000,
      });
      expect(after.snapshot).toContain('Frame clicked');

      await controller.open({ url: 'about:blank', newTab: false, timeoutMs: 5_000 });
      await expect(
        controller.snapshot({ depth: 8, boxes: false, frameId: embedded.id, timeoutMs: 5_000 }),
      ).rejects.toMatchObject<Partial<Stage5BrowserError>>({ code: 'TARGET_NOT_FOUND' });
    }
  });

  it('reports sanitized lock-owner evidence and fails closed when automatic reattachment is unproven', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-owned-lock-'));
    const config = browserConfig(temporaryRoot);
    config.readinessTimeoutMs = 10;
    await mkdir(config.profileDir, { recursive: true });
    await writeFile(path.join(config.profileDir, 'SingletonLock'), 'owned-browser-fixture');
    const inspectOwner = vi.fn(async () => ({
      evidence: {
        classification: 'dedicated_browser_control_unavailable' as const,
        ownership: 'proven' as const,
        lockOwnerProcess: 'running' as const,
        expectedApplication: 'Chromium',
        applicationIdentity: 'matched' as const,
        loopbackControl: 'absent' as const,
        authenticationHandoff: 'unverified' as const,
        recovery: 'close_dedicated_browser_normally' as const,
        suggestedAction: 'Close only the dedicated Chromium application normally, then retry once.',
      },
      reconnectRecord: null,
    }));
    controller = new BrowserController(
      config,
      config.browser,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      inspectOwner,
    );

    const stopped = await controller.status();
    expect(stopped).toMatchObject({
      state: 'stopped',
      profileLockState: 'possible_external_owner',
      profileOwner: {
        classification: 'dedicated_browser_control_unavailable',
        ownership: 'proven',
        expectedApplication: 'Chromium',
        recovery: 'close_dedicated_browser_normally',
      },
    });
    await expect(controller.start()).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'BROWSER_NOT_READY',
      details: {
        reason: 'profile_locked',
        ownershipReason: 'dedicated_browser_control_unavailable',
        profileOwner: {
          loopbackControl: 'absent',
          recovery: 'close_dedicated_browser_normally',
        },
        suggestedAction: 'Close only the dedicated Chromium application normally, then retry once.',
      },
    });
    const diagnostic = await controller.diagnostics();
    expect(diagnostic.profileOwner).toMatchObject({
      classification: 'dedicated_browser_control_unavailable',
      ownership: 'proven',
      lockOwnerProcess: 'running',
      applicationIdentity: 'matched',
    });
    expect(inspectOwner).toHaveBeenCalled();
  });

  it('reattaches through a reconstructed exact owned-process capability instead of launching into a lock', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-reconnect-lock-'));
    const config = browserConfig(temporaryRoot);
    config.readinessTimeoutMs = 10;
    await mkdir(config.profileDir, { recursive: true });
    await writeFile(path.join(config.profileDir, 'SingletonLock'), 'owned-browser-fixture');
    const reconnectRecord: NativeControlRecord = {
      version: 1,
      kind: 'chromium_cdp',
      browser: 'chromium',
      state: 'controlled',
      processId: 42_424,
      port: 29_123,
      createdAt: '2026-08-25T04:00:00.000Z',
    };
    const inspectOwner = vi.fn(async () => ({
      evidence: {
        classification: 'reconnectable_stage5_browser' as const,
        ownership: 'proven' as const,
        lockOwnerProcess: 'running' as const,
        expectedApplication: 'Google Chrome for Testing',
        applicationIdentity: 'matched' as const,
        loopbackControl: 'available' as const,
        authenticationHandoff: 'absent' as const,
        recovery: 'automatic_reattach' as const,
        suggestedAction: 'Stage5 Browser can safely reattach automatically.',
      },
      reconnectRecord,
    }));
    controller = new BrowserController(
      config,
      config.browser,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      inspectOwner,
    );
    const internals = controller as unknown as {
      attachToNativeChromium: (
        record: NativeControlRecord,
        identity: BrowserLaunchIdentity,
        targetOrigin: string | null,
      ) => Promise<BrowserStatus>;
    };
    const attach = vi.spyOn(internals, 'attachToNativeChromium').mockImplementation(async (
      _record,
      identity,
    ) => ({
      browser: 'chromium',
      state: 'running',
      workerPid: process.pid,
      browserConnected: true,
      pages: [],
      activePageIndex: null,
      lastKnownUrl: null,
      launchIdentity: identity,
      runtimeProfile: null,
      profileLockState: 'owned_browser_running',
      profileLockFiles: ['SingletonLock'],
      profileOwner: {
        classification: 'owned_active',
        ownership: 'proven',
        lockOwnerProcess: 'running',
        expectedApplication: identity.applicationName,
        applicationIdentity: 'matched',
        loopbackControl: 'available',
        authenticationHandoff: 'absent',
        recovery: 'none',
        suggestedAction: null,
      },
    }));

    await expect(controller.start()).resolves.toMatchObject({
      state: 'running',
      browserConnected: true,
      profileOwner: { classification: 'owned_active' },
    });
    expect(attach).toHaveBeenCalledWith(
      reconnectRecord,
      expect.objectContaining({
        browser: 'chromium',
        profile: expect.objectContaining({
          userDataDir: config.profileDir,
          profileDirectory: 'Default',
        }),
      }),
      null,
    );
  });
});
