import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { resolveBrowserLaunchTarget } from '../src/browser-provider.js';
import { BrowserController } from '../src/browser-controller.js';
import type { Stage5BrowserConfig } from '../src/config.js';
import {
  inspectProfileShutdown,
  NativeHumanBrowserLauncher,
  waitForProfileUnlock,
  type HumanBrowserSession,
} from '../src/human-auth-bootstrap.js';
import { inspectProfileStorage } from '../src/profile-binding.js';

const runNativeSmoke = process.env.STAGE5_BROWSER_NATIVE_SMOKE === '1';

describe.skipIf(!runNativeSmoke)('native human-authentication smoke', () => {
  let root: string | undefined;
  let session: HumanBrowserSession | undefined;
  let controller: BrowserController | undefined;

  afterAll(async () => {
    await controller?.stop();
    const state = session?.state();
    if (state?.running && state.processId !== null) {
      process.kill(state.processId, 'SIGTERM');
      if (!(await session!.waitForExit(5_000))) {
        process.kill(state.processId, 'SIGKILL');
      }
    }
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('launches real Brave without webdriver exposure and closes its temporary profile cleanly', async () => {
    let observedWebdriver: string | null = null;
    let reattachedCookiePresent = false;
    let reportObserved: (() => void) | undefined;
    const reportPromise = new Promise<void>((resolve) => {
      reportObserved = resolve;
    });
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (requestUrl.pathname === '/report') {
        observedWebdriver = requestUrl.searchParams.get('webdriver');
        response.writeHead(204);
        response.end();
        reportObserved?.();
        return;
      }
      if (requestUrl.pathname === '/reattach') {
        reattachedCookiePresent = (request.headers.cookie ?? '')
          .split(';')
          .some((entry) => entry.trim() === 'stage5_native_session=present');
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html><html><head><title>${reattachedCookiePresent ? 'Session restored' : 'Session missing'}</title></head><body>Reattachment</body></html>`);
        return;
      }
      response.setHeader('set-cookie', 'stage5_native_session=present; Max-Age=3600; Path=/; SameSite=Lax');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Stage5 native smoke</title></head><body>
        <h1>Native human authentication fixture</h1>
        <script>fetch('/report?webdriver=' + encodeURIComponent(String(navigator.webdriver)))</script>
      </body></html>`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Native smoke fixture did not bind to TCP.');
    }

    try {
      root = await mkdtemp(path.join(os.tmpdir(), 'stage5-native-auth-smoke-'));
      const target = await resolveBrowserLaunchTarget({ browser: 'brave', executablePath: null });
      session = await new NativeHumanBrowserLauncher().launch({
        target,
        profileDir: root,
        handoffLabel: 'Stage5 brave · native smoke · TEST1234',
        url: `http://127.0.0.1:${address.port}/`,
      });
      await Promise.race([
        reportPromise,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('Native Brave did not report webdriver state.')), 15_000);
        }),
      ]);
      expect(observedWebdriver).toBe('false');

      const processId = session.state().processId;
      if (processId === null) {
        throw new Error('Native Brave did not expose an owned process ID.');
      }
      process.kill(processId, 'SIGTERM');
      expect(await session.waitForExit(10_000)).toBe(true);
      expect(await waitForProfileUnlock(root, 5_000)).toBe(true);
      expect(await inspectProfileShutdown(root, 'brave')).toMatchObject({
        state: 'clean',
        exitedCleanly: true,
        profileLocks: [],
      });

      const launchIdentity = session.identity();
      const afterHumanStorage = await inspectProfileStorage(
        launchIdentity.profile,
        launchIdentity.engine,
        `http://127.0.0.1:${address.port}`,
      );
      expect(afterHumanStorage.cookieDatabase).toMatchObject({
        targetOriginCookiePresent: true,
        persistentCookiePresent: true,
      });

      const config: Stage5BrowserConfig = {
        browser: 'brave',
        browserExecutablePath: null,
        profilesDir: path.dirname(root),
        profileDir: root,
        artifactsDir: path.join(root, 'artifacts'),
        headless: true,
        operationTimeoutMs: 5_000,
        navigationTimeoutMs: 5_000,
        readinessTimeoutMs: 2_000,
        workerStartupTimeoutMs: 5_000,
        workerShutdownGraceMs: 500,
      };
      controller = new BrowserController(config, 'brave');
      await controller.open({
        url: `http://127.0.0.1:${address.port}/reattach`,
        newTab: false,
        timeoutMs: 10_000,
      });
      expect(reattachedCookiePresent).toBe(true);
      const controlledStatus = await controller.status();
      expect(controlledStatus.launchIdentity).toEqual(launchIdentity);
      const expectedRuntimeProfilePath = await realpath(path.join(root, 'Default'));
      expect(controlledStatus.runtimeProfile).toMatchObject({
        source: expect.stringMatching(/^chromium_(command_line|version_page)$/),
        profilePath: expectedRuntimeProfilePath,
        configuredProfilePath: path.join(root, 'Default'),
        matchesConfigured: true,
      });
      const afterReattachmentStorage = await inspectProfileStorage(
        launchIdentity.profile,
        launchIdentity.engine,
        `http://127.0.0.1:${address.port}`,
        { liveBrowser: true },
      );
      expect(afterReattachmentStorage.cookieDatabase).toMatchObject({
        inspection: 'live_process_metadata_only',
        targetOriginCookiePresent: null,
        persistentCookiePresent: null,
      });
      await controller.stop();
      controller = undefined;
      const afterControlledShutdownStorage = await inspectProfileStorage(
        launchIdentity.profile,
        launchIdentity.engine,
        `http://127.0.0.1:${address.port}`,
      );
      expect(afterControlledShutdownStorage.cookieDatabase).toMatchObject({
        inspection: 'aggregate_metadata',
        targetOriginCookiePresent: true,
        persistentCookiePresent: true,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 35_000);
});
