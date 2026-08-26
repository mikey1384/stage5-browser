import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BrowserController } from '../../../src/browser-controller.js';
import { BrowserPageLifecycleManager } from '../../../src/controller/lifecycle/page-events.js';
import { browserConfig, cleanBrowserControllerTestState, listen } from '../../browser-controller-fixture.js';

let controller: BrowserController | undefined;
let server: Server | undefined;
let temporaryRoot: string | undefined;

afterEach(async () => {
  await cleanBrowserControllerTestState({ controller, server, temporaryRoot });
  controller = undefined;
  server = undefined;
  temporaryRoot = undefined;
});

describe('BrowserController durable page lifecycle evidence', () => {
  it('records a new-document state-loss boundary, excludes same-document history, and restores sanitized evidence', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><body><label>Public draft <input></label></body></html>');
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-page-lifecycle-'));
    const config = browserConfig(temporaryRoot);
    controller = new BrowserController(config);
    await controller.open({
      url: `http://127.0.0.1:${port}/form?private=query#initial`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const baseline = await controller.pageEvents({ afterSequence: null, limit: 50 });
    await controller.fillByRole({
      role: 'textbox',
      name: 'Public draft',
      exact: true,
      frameId: null,
      value: 'disposable-draft-value',
      timeoutMs: 5_000,
    });
    const page = (controller as unknown as { activePage: {
      evaluate: (operation: () => void) => Promise<void>;
      reload: () => Promise<unknown>;
      locator: (selector: string) => { inputValue: () => Promise<string> };
    } }).activePage;
    await page.evaluate(() => history.pushState({}, '', '#same-document'));
    const sameDocument = await controller.pageEvents({ afterSequence: baseline.cursor, limit: 50 });
    expect(sameDocument.events).toEqual([]);

    await page.reload();
    expect(await page.locator('input').inputValue()).toBe('');
    const replaced = await controller.pageEvents({ afterSequence: baseline.cursor, limit: 50 });
    expect(replaced.events).toEqual([
      expect.objectContaining({
        kind: 'document_replaced',
        sanitizedUrl: `http://127.0.0.1:${port}/form`,
        stateRisk: 'all_unsaved_form_state_may_be_lost',
      }),
    ]);

    const restored = await new BrowserPageLifecycleManager(config.artifactsDir)
      .list({ afterSequence: baseline.cursor, limit: 50 });
    expect(restored.events).toEqual(replaced.events);
    const manifest = await readFile(path.join(config.artifactsDir, 'page-lifecycle', 'manifest.json'), 'utf8');
    expect(manifest).not.toContain('private=query');
    expect(manifest).not.toContain('same-document');
    expect(manifest).not.toContain('disposable-draft-value');
  });
});
