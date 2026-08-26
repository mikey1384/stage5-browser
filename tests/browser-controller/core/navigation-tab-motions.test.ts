import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BrowserController } from '../../../src/browser-controller.js';
import { browserConfig, cleanBrowserControllerTestState, listen } from '../../browser-controller-fixture.js';

let server: Server | undefined;
let controller: BrowserController | undefined;
let temporaryRoot: string | undefined;

afterEach(async () => {
  await cleanBrowserControllerTestState({ controller, server, temporaryRoot });
  controller = undefined;
  server = undefined;
  temporaryRoot = undefined;
});

async function startFixture(): Promise<string> {
  server = createServer((request, response) => {
    const route = request.url === '/two' ? 'two' : 'one';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><title>Page ${route}</title></head><body><h1>Page ${route}</h1></body></html>`);
  });
  const port = await listen(server);
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-navigation-motions-'));
  controller = new BrowserController(browserConfig(temporaryRoot));
  return `http://127.0.0.1:${port}`;
}

describe('BrowserController navigation and tab motions', () => {
  it('moves back, forward, and reloads under one bounded navigation state machine', async () => {
    const origin = await startFixture();
    await controller?.open({ url: `${origin}/one`, newTab: false, stabilizationMs: 0, timeoutMs: 5_000 });
    await controller?.open({ url: `${origin}/two`, newTab: false, stabilizationMs: 0, timeoutMs: 5_000 });

    const back = await controller?.navigateHistory({
      action: 'back',
      expectedUrl: { url: `${origin}/one`, match: 'exact' },
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    expect(back).toMatchObject({ action: 'back', actionDispatched: true, moved: true, finalUrl: `${origin}/one` });

    const forward = await controller?.navigateHistory({
      action: 'forward',
      expectedUrl: { url: `${origin}/two`, match: 'exact' },
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    expect(forward).toMatchObject({ action: 'forward', actionDispatched: true, moved: true, finalUrl: `${origin}/two` });

    const reload = await controller?.navigateHistory({
      action: 'reload',
      expectedUrl: { url: `${origin}/two`, match: 'exact' },
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    expect(reload).toMatchObject({ action: 'reload', actionDispatched: true, moved: false, finalUrl: `${origin}/two` });
  });

  it('closes only an exact opaque tab and reconciles the remaining selection', async () => {
    const origin = await startFixture();
    await controller?.open({ url: `${origin}/one`, newTab: false, stabilizationMs: 0, timeoutMs: 5_000 });
    await controller?.open({ url: `${origin}/two`, newTab: true, stabilizationMs: 0, timeoutMs: 5_000 });
    const tabs = await controller?.tabs();
    const selected = tabs?.pages.find((page) => page.index === tabs.activePageIndex);
    const preserved = tabs?.pages.find((page) => page.tabId !== selected?.tabId);
    if (selected === undefined || preserved === undefined) throw new Error('Fixture did not expose two exact tab IDs.');

    const closed = await controller?.closeTab({ tabId: selected.tabId, timeoutMs: 5_000 });
    expect(closed).toMatchObject({
      closedTabId: selected.tabId,
      wasSelected: true,
      actionDispatched: true,
      selectedTabId: preserved.tabId,
    });
    expect(closed?.pages.map(({ tabId }) => tabId)).toEqual([preserved.tabId]);
  });
});
