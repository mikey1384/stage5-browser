import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BrowserController } from '../src/browser-controller.js';
import type { Stage5BrowserConfig } from '../src/config.js';
import { Stage5BrowserError } from '../src/errors.js';

let server: Server | undefined;
let controller: BrowserController | undefined;
let temporaryRoot: string | undefined;

afterEach(async () => {
  await controller?.stop();
  controller = undefined;
  await new Promise<void>((resolve, reject) => {
    if (server === undefined || !server.listening) {
      resolve();
      return;
    }
    server.closeAllConnections();
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  server = undefined;
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
    await new Promise<void>((resolve, reject) => {
      const fixtureServer = server;
      if (fixtureServer === undefined) {
        reject(new Error('Fixture server was not created.'));
        return;
      }
      const onError = (error: Error): void => reject(error);
      fixtureServer.once('error', onError);
      fixtureServer.listen(0, '127.0.0.1', () => {
        fixtureServer.off('error', onError);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Fixture server did not bind to TCP.');
    }

    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-controller-'));
    const config: Stage5BrowserConfig = {
      profileDir: path.join(temporaryRoot, 'profile'),
      artifactsDir: path.join(temporaryRoot, 'artifacts'),
      headless: true,
      operationTimeoutMs: 5_000,
      navigationTimeoutMs: 5_000,
      readinessTimeoutMs: 2_000,
      workerStartupTimeoutMs: 5_000,
      workerShutdownGraceMs: 500,
    };
    controller = new BrowserController(config);

    const opened = await controller.open({
      url: `http://127.0.0.1:${address.port}/watch/example`,
      newTab: false,
      timeoutMs: 5_000,
    });
    expect(opened.responseStatus).toBe(200);
    expect(opened.page.title).toBe('Stage5 Browser fixture');

    const snapshot = await controller.snapshot({ depth: 8, boxes: false, timeoutMs: 5_000 });
    expect(snapshot.snapshot).toContain('Translator tools fixture');
    await controller.fillByRole({
      role: 'textbox',
      name: 'Search videos',
      exact: true,
      value: 'hello',
      timeoutMs: 5_000,
    });

    await expect(
      controller.clickByRole({
        role: 'button',
        name: 'Duplicate',
        exact: true,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({ code: 'AMBIGUOUS_TARGET' });

    const screenshot = await controller.screenshot({ fullPage: false, timeoutMs: 5_000 });
    expect((await stat(screenshot.path)).mode & 0o777).toBe(0o600);
    expect(screenshot.dataBase64.length).toBeGreaterThan(100);
  });
});
