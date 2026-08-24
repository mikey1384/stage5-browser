import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BrowserController } from '../src/browser-controller.js';
import type { Stage5BrowserConfig } from '../src/config.js';
import { Stage5BrowserError } from '../src/errors.js';
import type {
  HumanBrowserLaunchInput,
  HumanBrowserLauncher,
  HumanBrowserProcessState,
  HumanBrowserSession,
} from '../src/human-auth-bootstrap.js';
import {
  launchIdentityForTarget,
  type ProfileStorageInspection,
} from '../src/profile-binding.js';

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
      processId: 43_210,
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

    const available = await controller.availableBrowsers();
    for (const browser of ['chromium', 'firefox', 'webkit'] as const) {
      expect(available.browsers.find((entry) => entry.browser === browser)?.available).toBe(true);
    }

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

      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Timeline fixture</title>
        <style>body { margin: 0; } #spacer { height: 2200px; }</style></head><body>
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
        storageContinuity: { state: expect.stringMatching(/preserved|unverified/) },
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
    const inspections = [
      storageInspection(origin, []),
      storageInspection(origin, ['human-added-key']),
      storageInspection(origin, []),
    ];
    humanLauncher = new FakeHumanBrowserLauncher();
    controller = new BrowserController(
      config,
      config.browser,
      humanLauncher,
      async () => {
        const inspection = inspections.shift();
        if (inspection === undefined) {
          throw new Error('Unexpected profile-storage inspection.');
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
});
