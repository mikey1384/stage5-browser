import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';

import { BrowserController } from '../../../src/browser-controller.js';
import { inspectTargetState } from '../../../src/page-diagnostics.js';
import { browserConfig, cleanBrowserControllerTestState, listen } from '../../browser-controller-fixture.js';

describe('BrowserController modal target viewport preparation', () => {
  let controller: BrowserController | undefined;
  let server: Server | undefined;
  let temporaryRoot: string | undefined;

  afterEach(async () => {
    await cleanBrowserControllerTestState({ controller, server, temporaryRoot });
    controller = undefined;
    server = undefined;
    temporaryRoot = undefined;
  });

  it('scrolls the clipping modal ancestor before contacting its exact observed button', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><style>
        body { margin: 0; height: 100vh; overflow: hidden; }
        #modal { position: fixed; inset: 40px auto auto 40px; width: 320px; height: 100px; overflow-y: auto; }
        #spacer { height: 320px; }
      </style></head><body>
        <div id="modal" role="dialog" aria-modal="true" aria-label="Premium offer">
          <h1>Premium offer</h1><div id="spacer"></div>
          <button id="dismiss" type="button">No thanks</button>
        </div>
        <output id="clicks">0</output>
        <script>
          dismiss.addEventListener('click', () => { clicks.value = String(Number(clicks.value) + 1); });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-modal-viewport-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/modal`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const observed = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 2_000,
    });
    expect(observed.scope).toBe('modal');
    const ref = observed.snapshot.match(/button "No thanks"[^\n]*\[ref=([^\]]+)\]/u)?.[1];
    expect(ref).toBeDefined();
    if (ref === undefined) throw new Error('Modal fixture did not expose the dismiss ref.');

    const page = (controller as unknown as { activePage: Page }).activePage;
    await expect(inspectTargetState(page.locator('#dismiss'))).resolves.toMatchObject({
      visible: true,
      inViewport: false,
    });
    await expect(page.locator('#modal').evaluate((modal) => modal.scrollTop)).resolves.toBe(0);

    await expect(controller.clickRef({
      snapshotId: observed.snapshotId,
      ref,
      frameId: null,
      postcondition: null,
      timeoutMs: 4_000,
    })).resolves.toMatchObject({
      dispatch: { actionDispatched: true, clickDispatched: true },
    });
    await expect(page.locator('#modal').evaluate((modal) => modal.scrollTop)).resolves.toBeGreaterThan(0);
    await expect(page.locator('#clicks').textContent()).resolves.toBe('1');
  });
});
