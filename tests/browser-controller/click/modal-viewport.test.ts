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

    const clicked = await controller.clickRef({
      snapshotId: observed.snapshotId,
      ref,
      frameId: null,
      postcondition: null,
      timeoutMs: 4_000,
    });
    expect(clicked).toMatchObject({
      dispatch: { actionDispatched: true, clickDispatched: true },
      viewportPreparation: {
        verticalMovement: true,
        nestedSurfaceMovement: true,
        completedInViewport: true,
      },
    });
    await expect(page.locator('#modal').evaluate((modal) => modal.scrollTop)).resolves.toBeGreaterThan(0);
    await expect(page.locator('#clicks').textContent()).resolves.toBe('1');
    expect(controller.drainActionPhaseTelemetry().actionPhases.at(-1)?.viewportPreparation).toMatchObject({
      verticalMovement: true,
      nestedSurfaceMovement: true,
      completedInViewport: true,
    });
  });

  it('scrolls a horizontally clipped modal action before exact contact', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><style>
        body { margin: 0; height: 100vh; overflow: hidden; }
        #modal { position: fixed; inset: 40px auto auto 40px; width: 140px; height: 100px; overflow-x: auto; overflow-y: hidden; }
        #actions { display: flex; align-items: center; width: 720px; height: 80px; }
        #dismiss { margin-left: 600px; flex: none; }
      </style></head><body>
        <div id="modal" role="dialog" aria-modal="true" aria-label="Responsive offer">
          <div id="actions"><button id="dismiss" type="button">No thanks</button></div>
        </div>
        <output id="clicks">0</output>
        <script>
          dismiss.addEventListener('click', () => { clicks.value = String(Number(clicks.value) + 1); });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-modal-horizontal-'));
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
    if (ref === undefined) throw new Error('Horizontal modal fixture did not expose the dismiss ref.');

    const page = (controller as unknown as { activePage: Page }).activePage;
    await expect(inspectTargetState(page.locator('#dismiss'))).resolves.toMatchObject({
      visible: true,
      inViewport: false,
    });
    await expect(page.locator('#modal').evaluate((modal) => modal.scrollLeft)).resolves.toBe(0);

    const clicked = await controller.clickRef({
      snapshotId: observed.snapshotId,
      ref,
      frameId: null,
      postcondition: null,
      timeoutMs: 4_000,
    });
    expect(clicked).toMatchObject({
      dispatch: { actionDispatched: true, clickDispatched: true },
      viewportPreparation: {
        horizontalMovement: true,
        nestedSurfaceMovement: true,
        completedInViewport: true,
      },
    });
    await expect(page.locator('#modal').evaluate((modal) => modal.scrollLeft)).resolves.toBeGreaterThan(0);
    await expect(page.locator('#clicks').textContent()).resolves.toBe('1');
    expect(controller.drainActionPhaseTelemetry().actionPhases.at(-1)?.viewportPreparation).toMatchObject({
      horizontalMovement: true,
      nestedSurfaceMovement: true,
      completedInViewport: true,
    });
  });

  it('finds the clipping scroll surface through a composed slot boundary', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><style>
        body { margin: 0; height: 100vh; overflow: hidden; }
        modal-shell { position: fixed; inset: 40px auto auto 40px; width: 320px; height: 100px; display: block; }
        #spacer { height: 1000px; }
      </style></head><body>
        <modal-shell role="dialog" aria-modal="true" aria-label="Component offer">
          <div id="spacer"></div><button id="dismiss" type="button">No thanks</button>
        </modal-shell>
        <output id="clicks">0</output>
        <script>
          customElements.define('modal-shell', class extends HTMLElement {
            constructor() {
              super();
              const root = this.attachShadow({ mode: 'open' });
              root.innerHTML = '<style>#surface { width: 320px; height: 100px; overflow-y: auto; }</style><div id="surface"><slot></slot></div>';
            }
          });
          dismiss.addEventListener('click', () => { clicks.value = String(Number(clicks.value) + 1); });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-modal-composed-'));
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
    if (ref === undefined) throw new Error('Composed modal fixture did not expose the dismiss ref.');

    const page = (controller as unknown as { activePage: Page }).activePage;
    const surface = page.locator('modal-shell').locator('#surface');
    await expect(inspectTargetState(page.locator('#dismiss'))).resolves.toMatchObject({
      visible: true,
      inViewport: false,
    });
    await expect(surface.evaluate((element) => element.scrollTop)).resolves.toBe(0);

    await expect(controller.clickRef({
      snapshotId: observed.snapshotId,
      ref,
      frameId: null,
      postcondition: null,
      timeoutMs: 4_000,
    })).resolves.toMatchObject({
      dispatch: { actionDispatched: true, clickDispatched: true },
    });
    await expect(surface.evaluate((element) => element.scrollTop)).resolves.toBeGreaterThan(0);
    await expect(page.locator('#clicks').textContent()).resolves.toBe('1');
    expect(controller.drainActionPhaseTelemetry().actionPhases.at(-1)?.viewportPreparation).toMatchObject({
      verticalMovement: true,
      nestedSurfaceMovement: true,
      composedBoundaryTraversed: true,
      completedInViewport: true,
    });
  });

  it('uses exact postconditioned keyboard reach when an oversized fixed modal has no scroll surface', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><style>
        html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
        #modal { position: fixed; left: 40px; top: 20px; width: 320px; height: 1100px; overflow: visible; }
        #role-reach { position: absolute; left: 20px; top: 920px; }
        #dismiss { position: absolute; left: 20px; top: 980px; }
      </style></head><body>
        <div id="modal" role="dialog" aria-modal="true" aria-label="Oversized offer">
          <h1>Oversized offer</h1>
          <div id="role-outcome" role="status">Role outcome</div>
          <button id="role-reach" type="button">Hide marker</button>
          <button id="dismiss" type="button">No thanks</button>
        </div>
        <output id="role-clicks">0</output><output id="clicks">0</output>
        <script>
          document.getElementById('role-reach').addEventListener('click', () => {
            document.getElementById('role-clicks').value =
              String(Number(document.getElementById('role-clicks').value) + 1);
            document.getElementById('role-outcome').hidden = true;
          });
          dismiss.addEventListener('click', () => {
            clicks.value = String(Number(clicks.value) + 1);
            document.getElementById('modal').hidden = true;
          });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-modal-keyboard-reach-'));
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
    const ref = observed.snapshot.match(/button "No thanks"[^\n]*\[ref=([^\]]+)\]/u)?.[1];
    expect(ref).toBeDefined();
    if (ref === undefined) throw new Error('Oversized modal fixture did not expose the dismiss ref.');

    const page = (controller as unknown as { activePage: Page }).activePage;
    await expect(inspectTargetState(page.locator('#dismiss'))).resolves.toMatchObject({
      visible: true,
      inViewport: false,
      enabled: true,
    });

    await expect(controller.clickRef({
      snapshotId: observed.snapshotId,
      ref,
      frameId: null,
      postcondition: null,
      timeoutMs: 4_000,
    })).rejects.toMatchObject({
      details: {
        reason: 'target_not_actionable_in_viewport',
        actionDispatched: false,
        clickDispatched: false,
        viewportPreparation: { reachStrategy: 'pointer_viewport' },
      },
    });
    await expect(page.locator('#clicks').textContent()).resolves.toBe('0');

    await expect(controller.clickByRole({
      role: 'button',
      name: 'Hide marker',
      exact: true,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: null,
        expectedVisible: null,
        expectedHidden: {
          role: 'status',
          name: 'Role outcome',
          exact: true,
          frameId: null,
        },
        timeoutMs: 1_000,
      },
      timeoutMs: 4_000,
    })).resolves.toMatchObject({
      dispatch: { actionDispatched: true, clickDispatched: true },
      postcondition: { passed: true },
    });
    await expect(page.locator('#role-clicks').textContent()).resolves.toBe('1');

    const fresh = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 2_000,
    });
    const freshRef = fresh.snapshot.match(/button "No thanks"[^\n]*\[ref=([^\]]+)\]/u)?.[1];
    expect(freshRef).toBeDefined();
    if (freshRef === undefined) throw new Error('Fresh oversized-modal snapshot lost the dismiss ref.');

    await expect(controller.clickRef({
      snapshotId: fresh.snapshotId,
      ref: freshRef,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: null,
        expectedVisible: null,
        expectedHidden: {
          role: 'dialog',
          name: 'Oversized offer',
          exact: true,
          frameId: null,
        },
        timeoutMs: 1_000,
      },
      timeoutMs: 4_000,
    })).resolves.toMatchObject({
      dispatch: { actionDispatched: true, clickDispatched: true },
      viewportPreparation: {
        movements: 0,
        completedInViewport: false,
        reachStrategy: 'postconditioned_keyboard',
      },
      postcondition: { passed: true },
    });
    await expect(page.locator('#clicks').textContent()).resolves.toBe('1');
  });
});
