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

async function openFixture(html: string): Promise<BrowserController> {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  const port = await listen(server);
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-covered-popup-reveal-'));
  controller = new BrowserController(browserConfig(temporaryRoot));
  await controller.open({
    url: `http://127.0.0.1:${port}/form`,
    newTab: false,
    stabilizationMs: 0,
    timeoutMs: 5_000,
  });
  return controller;
}

describe('BrowserController popup reveal pointer contact', () => {
  it('uses exact native keyboard activation when custom reconciliation proves the popup opened', async () => {
    const activeController = await openFixture(`<!doctype html><html><head><style>
        #scroller { height: 96px; overflow-y: auto; }
        #spacer { height: 180px; }
        #control-wrap { position: relative; width: 240px; height: 48px; }
        #control { width: 240px; height: 48px; }
        #visual-cover {
          position: absolute;
          inset: 0;
          z-index: 2;
          display: grid;
          place-items: center;
          pointer-events: auto;
        }
      </style></head><body>
        <div id="scroller">
          <div id="spacer"></div>
          <div id="control-wrap">
            <button id="control" type="button" aria-label="Ordinary field"
              aria-haspopup="listbox" aria-controls="choices" aria-expanded="false"></button>
            <span id="visual-cover" aria-hidden="true">Ordinary field</span>
          </div>
        </div>
        <div id="choices" role="listbox" aria-label="Ordinary field choices" hidden>
          <div role="option">First choice</div>
          <div role="option">Second choice</div>
        </div>
        <output id="opener-count">0</output>
        <script>
          const control = document.getElementById('control');
          const choices = document.getElementById('choices');
          const openerCount = document.getElementById('opener-count');
          control.addEventListener('click', () => {
            openerCount.value = String(Number(openerCount.value) + 1);
            control.setAttribute('aria-expanded', 'true');
            choices.hidden = false;
          });
        </script>
      </body></html>`);

    const inspected = await activeController.inspectControl({
      control: { role: 'button', name: 'Ordinary field', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 10,
      timeoutMs: 5_000,
    });

    expect(inspected.inspection).toMatchObject({
      kind: 'custom_popup',
      optionsComplete: true,
      reveal: {
        openerActionDispatched: true,
        popupOpened: true,
      },
    });
    expect(inspected.inspection.options.map(({ name }) => name)).toEqual([
      'First choice',
      'Second choice',
    ]);
    const page = (activeController as unknown as {
      activePage: { locator(selector: string): { textContent(): Promise<string | null> } };
    }).activePage;
    expect(await page.locator('#opener-count').textContent()).toBe('1');
    expect((await activeController.diagnostics()).page?.lastAction).toMatchObject({
      outcome: 'succeeded',
      actionDispatched: true,
      clickDispatched: true,
      targetState: {
        visible: true,
        enabled: true,
        inViewport: true,
        receivesPointerEvents: false,
      },
      dispatchEvidence: {
        trustedEventObserved: true,
        keyDownOnTarget: true,
        clickOnTarget: true,
        misdirectedEventBlocked: false,
        targetStateChangeBlocked: false,
      },
    });
  });

  it('keeps a covered non-native control closed before any input', async () => {
    const activeController = await openFixture(`<!doctype html><html><head><style>
      #control-wrap { position: relative; width: 240px; height: 48px; }
      #control { width: 240px; height: 48px; }
      #external-cover { position: absolute; inset: 0; z-index: 2; pointer-events: auto; }
    </style></head><body>
      <div id="control-wrap">
        <div id="control" role="button" aria-label="Ordinary field" tabindex="0"
          aria-haspopup="listbox" aria-controls="choices" aria-expanded="false"></div>
        <span id="external-cover" aria-hidden="true">Ordinary field</span>
      </div>
      <div id="choices" role="listbox" hidden><div role="option">First choice</div></div>
      <output id="opener-count">0</output>
      <script>
        const control = document.getElementById('control');
        const choices = document.getElementById('choices');
        const openerCount = document.getElementById('opener-count');
        control.addEventListener('click', () => {
          openerCount.value = String(Number(openerCount.value) + 1);
          control.setAttribute('aria-expanded', 'true');
          choices.hidden = false;
        });
      </script>
    </body></html>`);

    await expect(activeController.inspectControl({
      control: { role: 'button', name: 'Ordinary field', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 10,
      timeoutMs: 5_000,
    })).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      details: {
        reason: 'target_covered_after_scroll',
        actionDispatched: false,
        clickDispatched: false,
      },
    });
    const page = (activeController as unknown as {
      activePage: { locator(selector: string): { getAttribute(name: string): Promise<string | null>; textContent(): Promise<string | null> } };
    }).activePage;
    expect(await page.locator('#opener-count').textContent()).toBe('0');
    expect(await page.locator('#control').getAttribute('aria-expanded')).toBe('false');
    expect(await page.locator('#choices').getAttribute('hidden')).toBe('');
  });
});
