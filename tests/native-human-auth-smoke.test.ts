import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { BrowserController } from '../src/browser-controller.js';
import type { Stage5BrowserConfig } from '../src/config.js';
import {
  inspectProfileShutdown,
  waitForProfileUnlock,
} from '../src/human-auth-bootstrap.js';
import {
  processIsRunning,
  removeNativeControlRecord,
} from '../src/native-control-channel.js';
import {
  readProfileOwnershipLease,
  writeProfileOwnershipLease,
} from '../src/profile-ownership-lease.js';

const runNativeSmoke = process.env.STAGE5_BROWSER_NATIVE_SMOKE === '1';

describe.skipIf(!runNativeSmoke)('native human-authentication smoke', () => {
  let root: string | undefined;
  let controller: BrowserController | undefined;
  let ownedHumanProcessId: number | null = null;

  afterAll(async () => {
    await controller?.stop().catch(() => undefined);
    if (ownedHumanProcessId !== null && processIsRunning(ownedHumanProcessId)) {
      process.kill(ownedHumanProcessId, 'SIGTERM');
    }
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('attaches to the same native Brave process without losing its temporary session', async () => {
    let observedWebdriver: string | null = null;
    let reattachedSessionCookiePresent = false;
    let reattachedPersistentCookiePresent = false;
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
        if (observedWebdriver === 'false') {
          reportObserved?.();
        }
        return;
      }
      if (requestUrl.pathname === '/reattach') {
        const cookies = (request.headers.cookie ?? '').split(';').map((entry) => entry.trim());
        reattachedSessionCookiePresent = cookies.includes('stage5_native_session=present');
        reattachedPersistentCookiePresent = cookies.includes('stage5_native_persistent=present');
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><html><head><title>Reattachment</title></head><body>Reattachment</body></html>');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Stage5 native smoke</title></head><body>
        <h1>Native human authentication fixture</h1>
        <script>
          if (navigator.webdriver === false) {
            document.cookie = 'stage5_native_session=present; Path=/; SameSite=Lax';
            document.cookie = 'stage5_native_persistent=present; Max-Age=3600; Path=/; SameSite=Lax';
          }
          fetch('/report?webdriver=' + encodeURIComponent(String(navigator.webdriver)))
        </script>
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
      const config: Stage5BrowserConfig = {
        browser: 'brave',
        browserExecutablePath: null,
        profilesDir: path.dirname(root),
        profileDir: root,
        artifactsDir: path.join(root, 'artifacts'),
        headless: false,
        operationTimeoutMs: 5_000,
        navigationTimeoutMs: 5_000,
        readinessTimeoutMs: 2_000,
        workerStartupTimeoutMs: 10_000,
        workerShutdownGraceMs: 500,
      };
      controller = new BrowserController(config, 'brave');
      const origin = `http://127.0.0.1:${address.port}`;
      await controller.start();
      await controller.open({
        url: origin,
        newTab: false,
        timeoutMs: 10_000,
      });
      const handoff = await controller.requestLoginHandoff({ url: null, timeoutMs: 10_000 });
      expect(handoff.controlMode).toBe('human_bootstrap');
      ownedHumanProcessId = handoff.humanBootstrap?.processId ?? null;
      expect(handoff.instructions.toLocaleLowerCase()).toContain('leave that exact browser application open');
      expect(ownedHumanProcessId).toEqual(expect.any(Number));

      await Promise.race([
        reportPromise,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('Native Brave did not report webdriver state.')), 15_000);
        }),
      ]);
      expect(observedWebdriver).toBe('false');

      const unrelatedWorker = new BrowserController(config, 'brave');
      await expect(unrelatedWorker.start()).rejects.toMatchObject({
        code: 'BROWSER_NOT_READY',
        details: {
          reason: 'profile_locked',
          ownershipReason: 'busy_other_stage5_session',
          profileOwner: { controlMode: 'human_handoff', phase: 'human_input' },
        },
      });

      const resumed = await controller.resumeAfterLogin({ expected: null, timeoutMs: 10_000 });
      expect(resumed.browserConnected).toBe(true);
      expect(resumed.controlMode).toBe('playwright');
      expect(resumed.humanBootstrap?.controlledByPlaywright).toBe(true);
      expect(resumed.lastHandoffOutcome?.storageContinuity).toMatchObject({
        state: 'preserved',
        lossBoundary: 'none',
        automationCorrelation: 'not_observed',
        navigatorWebdriverAtControlledStart: false,
      });
      await controller.open({
        url: `${origin}/reattach`,
        newTab: false,
        timeoutMs: 10_000,
      });
      expect(reattachedPersistentCookiePresent).toBe(true);
      expect(reattachedSessionCookiePresent).toBe(true);

      await controller.detachForWorkerShutdown();
      await removeNativeControlRecord(root);
      const detachedLease = await readProfileOwnershipLease(root);
      if (detachedLease === null) throw new Error('Detached worker did not retain its durable ownership lease.');
      // The smoke runs both controller instances in one Vitest process. Mark the
      // first simulated worker identity as exited while retaining the exact live
      // browser identity that a real replacement worker would inspect.
      await writeProfileOwnershipLease(root, {
        ...detachedLease,
        ownerWorkerProcessId: 2_147_483_000,
        ownerWorkerStartedAt: 'terminated-smoke-worker',
      });
      controller = new BrowserController(config, 'brave');
      const recovered = await controller.start();
      expect(recovered.browserConnected).toBe(true);
      expect(recovered.runtimeProfile?.matchesConfigured).toBe(true);
      expect(recovered.profileOwner).toMatchObject({
        classification: 'owned_active',
        ownership: 'proven',
        applicationIdentity: 'matched',
      });
      reattachedSessionCookiePresent = false;
      reattachedPersistentCookiePresent = false;
      await controller.open({
        url: `${origin}/reattach`,
        newTab: false,
        timeoutMs: 10_000,
      });
      expect(reattachedPersistentCookiePresent).toBe(true);
      expect(reattachedSessionCookiePresent).toBe(true);

      await controller.stop();
      controller = undefined;
      if (ownedHumanProcessId === null) {
        throw new Error('Native Brave did not expose an owned process ID.');
      }
      const deadline = Date.now() + 10_000;
      while (processIsRunning(ownedHumanProcessId) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(processIsRunning(ownedHumanProcessId)).toBe(false);
      ownedHumanProcessId = null;
      expect(await waitForProfileUnlock(root, 5_000)).toBe(true);
      await expect(inspectProfileShutdown(root, 'brave')).resolves.toMatchObject({
        state: 'clean',
        exitedCleanly: true,
        profileLocks: [],
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 45_000);
});
