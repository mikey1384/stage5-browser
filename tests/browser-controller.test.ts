import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserController } from '../src/browser-controller.js';
import { playwrightBrowserType, resolveBrowserLaunchTarget } from '../src/browser-provider.js';
import type { Stage5BrowserConfig } from '../src/config.js';
import { Stage5BrowserError } from '../src/errors.js';
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
        bringToFrontSucceeded: true,
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
        <button id="moving-target" type="button"
          onclick="document.querySelector('#expanded').hidden = false">See more</button>
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
        <button id="target" type="button"
          onclick="document.querySelector('#expanded').hidden = false">See more</button>
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
          attemptCount: 3,
          controllerSelected: true,
          bringToFrontAttempted: true,
          bringToFrontSucceeded: true,
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
        dispatchEvidence: {
          pageActivation: {
            visibilityAfter: 'hidden',
            nativeWindow: {
              applicationActivationSucceeded: true,
              result: 'visibility_unchanged',
            },
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
        <button id="unstable-target" type="button">See more</button>
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
