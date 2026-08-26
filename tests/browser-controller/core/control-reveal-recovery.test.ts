import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';

import { BrowserController } from '../../../src/browser-controller.js';
import { browserConfig, cleanBrowserControllerTestState, listen } from '../../browser-controller-fixture.js';

describe('BrowserController control reveal recovery', () => {
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
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-control-reveal-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/form`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    return (controller as unknown as { activePage: Page }).activePage;
  }

  it('reconciles a popup opened by partial pointer input without replaying the opener', async () => {
    const page = await openFixture(`<!doctype html><html><body>
      <button id="prior" aria-haspopup="listbox" aria-controls="prior-options" aria-expanded="true">Intended use</button>
      <div id="prior-options" role="listbox" aria-label="Intended use choices"><div role="option">Treasury</div></div>
      <button id="target" aria-haspopup="listbox" aria-controls="target-options" aria-expanded="true">Funding source</button>
      <div id="target-options" role="listbox" aria-label="Funding source choices" hidden><div role="option">Company treasury</div></div>
      <output id="escapes">0</output><output id="downs">0</output><output id="clicks">0</output>
      <script>
        prior.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape') return;
          escapes.value = String(Number(escapes.value) + 1);
          prior.setAttribute('aria-expanded', 'false');
          document.getElementById('prior-options').hidden = true;
        });
        target.addEventListener('mousedown', () => {
          downs.value = String(Number(downs.value) + 1);
          document.getElementById('target-options').hidden = false;
          const replacement = target.cloneNode(true);
          replacement.setAttribute('aria-expanded', 'true');
          target.replaceWith(replacement);
        });
        target.addEventListener('click', () => { clicks.value = String(Number(clicks.value) + 1); });
        target.focus();
      </script>
    </body></html>`);

    const inspected = await controller?.inspectControl({
      control: { role: 'button', name: 'Funding source', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    });

    expect(inspected?.inspection).toMatchObject({
      options: [{ name: 'Company treasury' }],
      reveal: {
        competingPopupDismissed: true,
        preparationActionDispatched: true,
        openerActionDispatched: true,
        popupOpened: true,
      },
    });
    await expect(page.locator('#prior-options').isHidden()).resolves.toBe(true);
    await expect(page.locator('#target-options').isVisible()).resolves.toBe(true);
    await expect(page.locator('#escapes').textContent()).resolves.toBe('1');
    await expect(page.locator('#downs').textContent()).resolves.toBe('1');
    await expect(page.locator('#clicks').textContent()).resolves.toBe('0');
    expect(controller?.drainActionPhaseTelemetry().actionPhases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'click_by_role',
        dispatchState: 'dispatched',
        dispatchAttempts: 1,
        terminalOutcome: 'succeeded',
      }),
    ]));
  });

  it('passively inspects its exact open popup while another popup remains open', async () => {
    const page = await openFixture(`<!doctype html><html><body>
      <button id="prior" aria-haspopup="listbox" aria-controls="prior-options" aria-expanded="true">Intended use</button>
      <div id="prior-options" role="listbox" aria-label="Intended use choices"><div role="option">Treasury</div></div>
      <button id="target" aria-haspopup="listbox" aria-controls="target-options" aria-expanded="true">Funding source</button>
      <div id="target-options" role="listbox" aria-label="Funding source choices"><div role="option">Company treasury</div></div>
      <output id="inputs">0</output>
      <script>
        for (const control of [prior, target]) {
          control.addEventListener('click', () => { inputs.value = String(Number(inputs.value) + 1); });
          control.addEventListener('keydown', () => { inputs.value = String(Number(inputs.value) + 1); });
        }
      </script>
    </body></html>`);

    const inspected = await controller?.inspectControl({
      control: { role: 'button', name: 'Funding source', exact: true },
      frameId: null,
      revealOptions: false,
      maxOptions: 20,
      timeoutMs: 5_000,
    });

    expect(inspected?.inspection).toMatchObject({
      options: [{ name: 'Company treasury' }],
      reveal: {
        requested: false,
        competingPopupDismissed: false,
        preparationActionDispatched: false,
        openerActionDispatched: false,
        popupOpened: true,
      },
    });
    await expect(page.locator('#prior-options').isVisible()).resolves.toBe(true);
    await expect(page.locator('#target-options').isVisible()).resolves.toBe(true);
    await expect(page.locator('#inputs').textContent()).resolves.toBe('0');
  });
});
