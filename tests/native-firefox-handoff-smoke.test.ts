import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { BrowserController } from '../src/browser-controller.js';
import type { Stage5BrowserConfig } from '../src/config.js';
import { Stage5BrowserError } from '../src/errors.js';
import { waitForProfileUnlock } from '../src/human-auth-bootstrap.js';
import { processIsRunning } from '../src/native-control-channel.js';
import type { BrowserCommandOutput } from '../src/protocol.js';

const runFirefoxSmoke = process.env.STAGE5_BROWSER_FIREFOX_NATIVE_SMOKE === '1';

describe.skipIf(!runFirefoxSmoke)('native Firefox private-handoff smoke', () => {
  let root: string | undefined;
  let controller: BrowserController | undefined;
  let ownedHumanProcessId: number | null = null;

  afterAll(async () => {
    await controller?.stop().catch(() => undefined);
    if (ownedHumanProcessId !== null && processIsRunning(ownedHumanProcessId)) {
      process.kill(ownedHumanProcessId, 'SIGTERM');
    }
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('retains the handoff through Firefox exit and profile unlock, then resumes the same profile', async () => {
    let humanRuntimeObserved = false;
    let observedWebdriver: string | null = null;
    let resumedCookiePresent = false;
    let reportPhase: 'controlled' | 'human' = 'controlled';
    let controlledReportObserved: (() => void) | undefined;
    let humanReportObserved: (() => void) | undefined;
    const controlledReportPromise = new Promise<void>((resolve) => {
      controlledReportObserved = resolve;
    });
    const humanReportPromise = new Promise<void>((resolve) => {
      humanReportObserved = resolve;
    });
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (requestUrl.pathname === '/report') {
        observedWebdriver = requestUrl.searchParams.get('webdriver');
        if (reportPhase === 'human') humanRuntimeObserved = true;
        response.writeHead(204);
        response.end();
        if (reportPhase === 'controlled') controlledReportObserved?.();
        else humanReportObserved?.();
        return;
      }
      if (requestUrl.pathname === '/reattach') {
        resumedCookiePresent = (request.headers.cookie ?? '')
          .split(';')
          .map((entry) => entry.trim())
          .includes('stage5_firefox_private=present');
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><html><head><title>Firefox resumed</title></head><body>Firefox resumed</body></html>');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Firefox private handoff</title></head><body>
        <h1>Private handoff fixture</h1>
        <script>
          if (${reportPhase === 'human' ? 'true' : 'false'}) {
            document.cookie = 'stage5_firefox_private=present; Max-Age=3600; Path=/; SameSite=Lax';
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
    if (address === null || typeof address === 'string') throw new Error('Firefox smoke server did not bind.');

    try {
      root = await mkdtemp(path.join(os.tmpdir(), 'stage5-native-firefox-smoke-'));
      const config: Stage5BrowserConfig = {
        browser: 'firefox',
        browserExecutablePath: null,
        profilesDir: path.dirname(root),
        profileDir: root,
        artifactsDir: path.join(root, 'artifacts'),
        headless: false,
        operationTimeoutMs: 15_000,
        navigationTimeoutMs: 15_000,
        readinessTimeoutMs: 5_000,
        workerStartupTimeoutMs: 10_000,
        workerShutdownGraceMs: 1_000,
      };
      controller = new BrowserController(config, 'firefox');
      const origin = `http://127.0.0.1:${address.port}`;
      await controller.open({ url: origin, newTab: false, stabilizationMs: 0, timeoutMs: 15_000 });
      await Promise.race([
        controlledReportPromise,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('Controlled Firefox did not report its runtime.')), 5_000);
        }),
      ]);
      expect(observedWebdriver).toBe('true');
      reportPhase = 'human';

      let handoff: BrowserCommandOutput<'requestLoginHandoff'> | null = null;
      for (let attempt = 0; attempt < 3 && handoff === null; attempt += 1) {
        try {
          handoff = await controller.requestLoginHandoff({ url: null, timeoutMs: 15_000 });
        } catch (error) {
          if (!(error instanceof Stage5BrowserError) || error.details?.reason !== 'handoff_release_pending') {
            throw error;
          }
        }
      }
      if (handoff === null) throw new Error('Firefox handoff did not leave its retained release phase.');
      expect(handoff.state).toBe('awaiting_user');
      expect(handoff.instructions).toContain('quit');
      ownedHumanProcessId = handoff.humanBootstrap?.processId ?? null;
      expect(ownedHumanProcessId).toEqual(expect.any(Number));

      await Promise.race([
        humanReportPromise,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('Native Firefox did not report its human runtime.')), 15_000);
        }),
      ]);
      expect(observedWebdriver).toMatch(/^(?:false|true)$/);
      expect(humanRuntimeObserved).toBe(true);
      if (ownedHumanProcessId === null) throw new Error('Native Firefox did not expose its owned PID.');
      process.kill(ownedHumanProcessId, 'SIGTERM');
      const exitDeadline = Date.now() + 15_000;
      while (processIsRunning(ownedHumanProcessId) && Date.now() < exitDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(processIsRunning(ownedHumanProcessId)).toBe(false);
      expect(await waitForProfileUnlock(root, 15_000)).toBe(true);

      let resumed: BrowserCommandOutput<'resumeAfterLogin'> | null = null;
      for (let attempt = 0; attempt < 3 && resumed === null; attempt += 1) {
        try {
          resumed = await controller.resumeAfterLogin({ expected: null, timeoutMs: 15_000 });
        } catch (error) {
          if (!(error instanceof Stage5BrowserError) || error.code !== 'AUTH_HANDOFF_REQUIRED') throw error;
        }
      }
      if (resumed === null) throw new Error('Firefox handoff did not resume after its exact process exited.');
      expect(resumed).toMatchObject({
        browserConnected: true,
        state: 'ready_for_agent_verification',
        controlMode: 'playwright',
      });
      await controller.open({
        url: `${origin}/reattach`,
        newTab: false,
        stabilizationMs: 0,
        timeoutMs: 15_000,
      });
      expect(resumedCookiePresent).toBe(true);
      await controller.stop();
      controller = undefined;
      ownedHumanProcessId = null;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 90_000);
});
