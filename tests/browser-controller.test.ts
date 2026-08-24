import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BrowserController } from '../src/browser-controller.js';
import type { Stage5BrowserConfig } from '../src/config.js';
import { Stage5BrowserError } from '../src/errors.js';

let server: Server | undefined;
let frameServer: Server | undefined;
let controller: BrowserController | undefined;
let temporaryRoot: string | undefined;

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

afterEach(async () => {
  await controller?.stop();
  controller = undefined;
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
