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

async function openFixture(html: string): Promise<void> {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  const port = await listen(server);
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-motions-'));
  controller = new BrowserController(browserConfig(temporaryRoot));
  await controller.open({
    url: `http://127.0.0.1:${port}/motions`,
    newTab: false,
    stabilizationMs: 0,
    timeoutMs: 5_000,
  });
}

describe('BrowserController composable motions', () => {
  it('hovers one semantic target and reconciles the revealed surface', async () => {
    await openFixture(`<!doctype html><html><body>
      <button id="trigger">Products</button>
      <div id="menu" role="menu" aria-label="Products menu" hidden><button role="menuitem">Translate</button></div>
      <script>trigger.addEventListener('pointerover', () => { menu.hidden = false; });</script>
    </body></html>`);

    const result = await controller?.motion({
      motion: { kind: 'hover', target: { kind: 'role', role: 'button', name: 'Products', exact: true } },
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedNewPageUrl: null,
        expectedSelected: null,
        expectedVisible: { role: 'menu', name: 'Products menu', exact: true, frameId: null },
        expectedHidden: null,
        satisfaction: 'all',
        timeoutMs: 1_000,
      },
      timeoutMs: 5_000,
    });

    expect(result?.dispatch).toMatchObject({ actionDispatched: true, kind: 'hover', hoverObserved: true });
    expect(result?.postcondition?.passed).toBe(true);
  });

  it('focuses and presses a bounded key on exact targets', async () => {
    await openFixture(`<!doctype html><html><body>
      <label for="query">Query</label><input id="query">
      <button id="menu" aria-expanded="true">Actions</button>
      <div id="panel" role="menu" aria-label="Actions menu"><button role="menuitem">Archive</button></div>
      <script>menu.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { panel.hidden = true; menu.setAttribute('aria-expanded', 'false'); }
      });</script>
    </body></html>`);

    const focused = await controller?.motion({
      motion: { kind: 'focus', target: { kind: 'role', role: 'textbox', name: 'Query', exact: true } },
      frameId: null,
      postcondition: null,
      timeoutMs: 5_000,
    });
    expect(focused?.dispatch).toMatchObject({ actionDispatched: true, focusObserved: true });

    const pressed = await controller?.motion({
      motion: {
        kind: 'press',
        key: 'Escape',
        target: { kind: 'role', role: 'button', name: 'Actions', exact: true },
      },
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedNewPageUrl: null,
        expectedSelected: false,
        expectedVisible: null,
        expectedHidden: null,
        satisfaction: 'all',
        timeoutMs: 1_000,
      },
      timeoutMs: 5_000,
    });
    expect(pressed?.dispatch).toMatchObject({ actionDispatched: true, keyDownObserved: true, keyUpObserved: true });
    expect(pressed?.postcondition?.passed).toBe(true);
  });

  it('drags between exact refs once and reports pointer/drop evidence', async () => {
    await openFixture(`<!doctype html><html><head><style>
      #source, #destination { width: 120px; height: 80px; margin: 30px; border: 1px solid black; }
    </style></head><body>
      <button id="source" draggable="true">Draft card</button>
      <section id="destination" role="region" aria-label="Published lane">Published lane</section>
      <output id="result" role="status" aria-label="Move complete" hidden>pending</output>
      <script>
        source.addEventListener('dragstart', (event) => { event.dataTransfer.setData('text/plain', 'card'); });
        destination.addEventListener('dragover', (event) => event.preventDefault());
        destination.addEventListener('drop', (event) => {
          event.preventDefault(); result.value = 'moved'; result.hidden = false;
          destination.setAttribute('aria-selected', 'true');
        });
      </script>
    </body></html>`);
    const snapshot = await controller?.snapshot({ depth: 8, boxes: false, frameId: null, timeoutMs: 5_000 });
    const sourceRef = snapshot?.snapshot.match(/button "Draft card"[^\n]*\[ref=([^\]]+)\]/u)?.[1];
    const destinationRef = snapshot?.snapshot.match(/region "Published lane"[^\n]*\[ref=([^\]]+)\]/u)?.[1];
    if (snapshot === undefined || sourceRef === undefined || destinationRef === undefined) {
      throw new Error('The drag fixture did not expose exact endpoint refs.');
    }

    const dragged = await controller?.motion({
      motion: {
        kind: 'drag',
        source: { kind: 'ref', snapshotId: snapshot.snapshotId, ref: sourceRef },
        destination: { kind: 'ref', snapshotId: snapshot.snapshotId, ref: destinationRef },
      },
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedNewPageUrl: null,
        expectedSelected: null,
        expectedVisible: { role: 'status', name: 'Move complete', exact: true, frameId: null },
        expectedHidden: null,
        satisfaction: 'all',
        timeoutMs: 1_000,
      },
      timeoutMs: 5_000,
    });
    expect(dragged?.dispatch).toMatchObject({ actionDispatched: true, pointerDownObserved: true, dragStartObserved: true, dropObserved: true });
  });

  it('supports exact double-click and context-menu gestures', async () => {
    await openFixture(`<!doctype html><html><body>
      <button id="open">Open item</button>
      <button id="menu">Item actions</button>
      <output role="status" aria-label="Item opened" hidden>opened</output>
      <div role="menu" aria-label="Item actions menu" hidden><button role="menuitem">Archive</button></div>
      <script>
        document.querySelector('#open').addEventListener('dblclick', () => {
          document.querySelector('output').hidden = false;
        });
        document.querySelector('#menu').addEventListener('contextmenu', (event) => {
          event.preventDefault(); document.querySelector('[role=menu]').hidden = false;
        });
      </script>
    </body></html>`);

    const doubleClicked = await controller?.motion({
      motion: { kind: 'double_click', target: { kind: 'role', role: 'button', name: 'Open item', exact: true } },
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedNewPageUrl: null,
        expectedDownload: false,
        expectedSelected: null,
        expectedVisible: { role: 'status', name: 'Item opened', exact: true, frameId: null },
        expectedHidden: null,
        satisfaction: 'all',
        timeoutMs: 1_000,
      },
      timeoutMs: 5_000,
    });
    expect(doubleClicked?.dispatch).toMatchObject({ actionDispatched: true, doubleClickObserved: true });

    const contextClicked = await controller?.motion({
      motion: { kind: 'context_click', target: { kind: 'role', role: 'button', name: 'Item actions', exact: true } },
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedNewPageUrl: null,
        expectedDownload: false,
        expectedSelected: null,
        expectedVisible: { role: 'menu', name: 'Item actions menu', exact: true, frameId: null },
        expectedHidden: null,
        satisfaction: 'all',
        timeoutMs: 1_000,
      },
      timeoutMs: 5_000,
    });
    expect(contextClicked?.dispatch).toMatchObject({ actionDispatched: true, contextMenuObserved: true });
  });
});
