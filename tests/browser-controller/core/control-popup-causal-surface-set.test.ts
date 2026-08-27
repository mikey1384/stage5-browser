import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { Page } from 'playwright';
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

async function openFixture(html: string): Promise<{ controller: BrowserController; page: Page }> {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  const port = await listen(server);
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-causal-surface-set-'));
  controller = new BrowserController(browserConfig(temporaryRoot));
  await controller.open({
    url: `http://127.0.0.1:${port}/form`,
    newTab: false,
    stabilizationMs: 0,
    timeoutMs: 5_000,
  });
  return {
    controller,
    page: (controller as unknown as { activePage: Page }).activePage,
  };
}

describe('BrowserController causal popup surface sets', () => {
  it('composes sibling semantic groups inside one newly rendered positioned portal', async () => {
    const { controller: activeController, page } = await openFixture(`<!doctype html><html><head><style>
      body { margin: 0; min-height: 600px; position: relative; }
      #target { position: absolute; left: 20px; top: 20px; width: 180px; height: 40px; }
      #portal { position: absolute; left: 500px; top: 100px; width: 260px; padding: 8px; }
      [role=listbox] { height: 44px; }
    </style></head><body tabindex="-1">
      <button id="target" type="button">Ordinary field</button>
      <div id="portal" hidden>
        <div role="listbox"><div role="option">Choice 1</div></div>
        <div role="listbox"><div role="option">Choice 2</div></div>
        <div role="listbox"><div role="option">Choice 3</div></div>
        <div role="listbox"><div role="option">Choice 4</div></div>
        <div role="listbox"><div role="option">Choice 5</div></div>
        <div role="listbox"><div role="option">Choice 6</div></div>
        <div role="listbox"><div role="option">Choice 7</div></div>
      </div>
      <output id="opens">0</output>
      <script>
        const target = document.getElementById('target');
        const portal = document.getElementById('portal');
        const opens = document.getElementById('opens');
        target.addEventListener('click', () => {
          opens.value = String(Number(opens.value) + 1);
          portal.hidden = false;
          document.body.focus();
        });
      </script>
    </body></html>`);

    const inspected = await activeController.inspectControl({
      control: { role: 'button', name: 'Ordinary field', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    });

    expect(inspected.inspection).toMatchObject({
      optionsComplete: true,
      reveal: {
        openerActionDispatched: true,
        popupOpened: true,
        associationProof: 'post_dispatch_unique',
        surfaceProof: 'semantic_role',
        renderedPopupCount: 7,
      },
    });
    expect(inspected.inspection.options.map(({ name }) => name)).toEqual([
      'Choice 1',
      'Choice 2',
      'Choice 3',
      'Choice 4',
      'Choice 5',
      'Choice 6',
      'Choice 7',
    ]);
    await expect(page.locator('#opens').textContent()).resolves.toBe('1');
  });

  it('does not compose newly rendered surfaces from independent positioned portals', async () => {
    const { controller: activeController, page } = await openFixture(`<!doctype html><html><head><style>
      body { margin: 0; min-height: 600px; position: relative; }
      #target { position: absolute; left: 20px; top: 20px; width: 180px; height: 40px; }
      .portal { position: absolute; top: 120px; width: 220px; }
      #portal-a { left: 320px; }
      #portal-b { left: 700px; }
    </style></head><body tabindex="-1">
      <button id="target" type="button">Ordinary field</button>
      <div id="portal-a" class="portal" hidden>
        <div role="listbox"><div role="option">First independent choice</div></div>
      </div>
      <div id="portal-b" class="portal" hidden>
        <div role="listbox"><div role="option">Second independent choice</div></div>
      </div>
      <output id="opens">0</output>
      <script>
        const target = document.getElementById('target');
        const opens = document.getElementById('opens');
        target.addEventListener('click', () => {
          opens.value = String(Number(opens.value) + 1);
          document.getElementById('portal-a').hidden = false;
          document.getElementById('portal-b').hidden = false;
          document.body.focus();
        });
      </script>
    </body></html>`);

    await expect(activeController.inspectControl({
      control: { role: 'button', name: 'Ordinary field', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    })).rejects.toMatchObject({
      details: {
        actionDispatched: true,
        renderedPopupCount: 2,
      },
    });
    await expect(page.locator('#opens').textContent()).resolves.toBe('1');
  });
});
