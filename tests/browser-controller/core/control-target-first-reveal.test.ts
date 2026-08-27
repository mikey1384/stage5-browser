import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';

import { BrowserController } from '../../../src/browser-controller.js';
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

async function openFixture(html: string): Promise<Page> {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  const port = await listen(server);
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-target-first-reveal-'));
  controller = new BrowserController(browserConfig(temporaryRoot));
  await controller.open({
    url: `http://127.0.0.1:${port}/form`,
    newTab: false,
    stabilizationMs: 0,
    timeoutMs: 5_000,
  });
  return (controller as unknown as { activePage: Page }).activePage;
}

describe('BrowserController target-first popup reveal', () => {
  it('uses exact focused-target evidence before a global owner inventory can overflow', async () => {
    const unrelated = Array.from({ length: 120 }, (_, index) =>
      `<button type="button">Unrelated ${index}</button>`).join('');
    const page = await openFixture(`<!doctype html><html><head><style>
      body { margin: 0; }
      #country, #options { position: absolute; left: 20px; width: 240px; box-sizing: border-box; }
      #country { top: 20px; height: 40px; }
      #options { top: 60px; height: 80px; border: 1px solid black; }
      #noise { position: absolute; top: 180px; }
    </style></head><body>
      <label for="country">Country of Issuance</label>
      <input id="country" role="combobox">
      <div id="options" role="listbox" hidden><div role="option">United States</div></div>
      <div id="noise">${unrelated}</div>
      <output id="clicks">0</output>
      <script>
        country.addEventListener('click', () => {
          clicks.value = String(Number(clicks.value) + 1);
          options.hidden = false;
          country.focus();
        });
      </script>
    </body></html>`);

    const inspected = await controller?.inspectControl({
      control: { role: 'combobox', name: 'Country of Issuance', exact: true },
      frameId: null,
      revealOptions: true,
      revealInteraction: 'pointer',
      maxOptions: 20,
      timeoutMs: 5_000,
    });

    expect(inspected?.inspection).toMatchObject({
      options: [{ name: 'United States' }],
      reveal: {
        interactionUsed: 'pointer',
        associationProof: 'focused',
        popupOpened: true,
        popupOwnership: {
          proofTier: 'focused',
          candidateCount: 1,
          decision: 'single_candidate',
        },
      },
    });
    await expect(page.locator('#clicks').textContent()).resolves.toBe('1');
  });

  it('lets the agent choose keyboard reveal before dispatch when pointerDown would detach', async () => {
    const page = await openFixture(`<!doctype html><html><body>
      <button id="role-control" type="button" aria-haspopup="listbox">Role</button>
      <div id="role-options" role="listbox" hidden><div role="option">Director</div></div>
      <output id="counts">keys:0 pointers:0</output>
      <script>
        const roleControl = document.querySelector('#role-control');
        const roleOptions = document.querySelector('#role-options');
        const counts = document.querySelector('#counts');
        let keys = 0;
        let pointers = 0;
        const render = () => { counts.value = 'keys:' + keys + ' pointers:' + pointers; };
        roleControl.addEventListener('pointerdown', () => {
          pointers += 1;
          roleControl.replaceWith(roleControl.cloneNode(true));
          render();
        });
        roleControl.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return;
          keys += 1;
          roleOptions.hidden = false;
          const replacement = roleControl.cloneNode(true);
          replacement.setAttribute('aria-controls', 'role-options');
          roleControl.replaceWith(replacement);
          replacement.focus();
          render();
        });
      </script>
    </body></html>`);

    const inspected = await controller?.inspectControl({
      control: { role: 'button', name: 'Role', exact: true },
      frameId: null,
      revealOptions: true,
      revealInteraction: 'keyboard',
      maxOptions: 20,
      timeoutMs: 5_000,
    });

    expect(inspected?.inspection).toMatchObject({
      options: [{ name: 'Director' }],
      reveal: {
        interactionUsed: 'keyboard',
        openerActionDispatched: true,
        popupOpened: true,
        associationProof: 'explicit',
      },
    });
    await expect(page.locator('#counts').textContent()).resolves.toBe('keys:1 pointers:0');
    expect(controller?.drainActionPhaseTelemetry().actionPhases).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'press', dispatchState: 'dispatched', dispatchAttempts: 1 }),
    ]));
  });

});
