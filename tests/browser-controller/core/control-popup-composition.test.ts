import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';

import { BrowserController } from '../../../src/browser-controller.js';
import { browserConfig, cleanBrowserControllerTestState, listen } from '../../browser-controller-fixture.js';

describe('BrowserController composite popup ownership', () => {
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
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-popup-composition-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/form`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    return (controller as unknown as { activePage: Page }).activePage;
  }

  it('dismisses one composite competitor and reconciles one nested target popup without replay', async () => {
    const page = await openFixture(`<!doctype html><html><head><style>
      body { margin: 0; min-height: 600px; }
      button, [role="menu"] { position: absolute; left: 24px; width: 260px; }
      button { height: 40px; }
      #prior { top: 20px; }
      #prior-menu { top: 60px; }
      #target { top: 300px; }
      #target-menu { top: 340px; }
    </style></head><body>
      <button id="prior" aria-haspopup="menu" aria-controls="prior-menu" aria-expanded="true">Prior field</button>
      <div id="prior-menu" role="menu"><div role="listbox"><div role="option">Prior choice</div></div></div>
      <button id="target" aria-haspopup="menu" aria-expanded="false">Target field</button>
      <div id="target-menu" role="menu" hidden>
        <div role="listbox" aria-multiselectable="true">
          <div role="option" aria-selected="false">First choice</div>
          <div role="option" aria-selected="false">Second choice</div>
        </div>
      </div>
      <output id="escapes">0</output><output id="opens">0</output>
      <script>
        prior.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape') return;
          escapes.value = String(Number(escapes.value) + 1);
          prior.setAttribute('aria-expanded', 'false');
          document.getElementById('prior-menu').hidden = true;
        });
        target.addEventListener('click', () => {
          opens.value = String(Number(opens.value) + 1);
          target.setAttribute('aria-expanded', 'true');
          document.getElementById('target-menu').hidden = false;
        });
      </script>
    </body></html>`);

    const inspected = await controller?.inspectControl({
      control: { role: 'button', name: 'Target field', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    });

    expect(inspected?.inspection).toMatchObject({
      options: [{ name: 'First choice' }, { name: 'Second choice' }],
      reveal: {
        competingPopupDismissed: true,
        preparationActionDispatched: true,
        openerActionDispatched: true,
        popupOpened: true,
        renderedPopupCount: 2,
      },
    });
    await expect(page.locator('#escapes').textContent()).resolves.toBe('1');
    await expect(page.locator('#opens').textContent()).resolves.toBe('1');
  });

  it('retains disjoint surfaces with one explicit owner as one selectable capability', async () => {
    const page = await openFixture(`<!doctype html><html><body>
      <button id="target" aria-haspopup="listbox" aria-controls="group-a group-b"
        aria-expanded="true" aria-multiselectable="true">Target field</button>
      <div id="group-a" role="listbox" aria-multiselectable="true">
        <div role="option" aria-selected="false">First choice</div>
      </div>
      <div id="group-b" role="listbox" aria-multiselectable="true">
        <div id="second" role="option" aria-selected="false">Second choice</div>
      </div>
      <output id="inputs">0</output>
      <script>
        second.addEventListener('click', () => {
          inputs.value = String(Number(inputs.value) + 1);
          second.setAttribute('aria-selected', 'true');
        });
      </script>
    </body></html>`);

    const inspected = await controller?.inspectControl({
      control: { role: 'button', name: 'Target field', exact: true },
      frameId: null,
      revealOptions: false,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    expect(inspected?.inspection.reveal).toMatchObject({
      openerActionDispatched: false,
      associationProof: 'explicit',
      renderedPopupCount: 2,
    });
    expect(inspected?.inspection.options.map(({ name }) => name)).toEqual([
      'First choice',
      'Second choice',
    ]);

    const second = inspected?.inspection.options.find(({ name }) => name === 'Second choice');
    expect(second).toBeDefined();
    const selected = await controller?.selectOption({
      inspectionId: inspected!.inspection.inspectionId,
      optionId: second!.optionId,
      control: null,
      option: null,
      selected: true,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(selected?.evidence).toMatchObject({
      actionDispatched: true,
      selectionEffectObserved: true,
      selectedState: true,
      popupClosed: false,
    });
    await expect(page.locator('#inputs').textContent()).resolves.toBe('1');
  });

  it('keeps different competing owners ambiguous with zero input', async () => {
    const page = await openFixture(`<!doctype html><html><body>
      <button id="first" aria-controls="first-menu" aria-expanded="true">First field</button>
      <div id="first-menu" role="listbox"><div role="option">First choice</div></div>
      <button id="second" aria-controls="second-menu" aria-expanded="true">Second field</button>
      <div id="second-menu" role="listbox"><div role="option">Second choice</div></div>
      <button id="target" aria-controls="target-menu" aria-expanded="false">Target field</button>
      <div id="target-menu" role="listbox" hidden><div role="option">Target choice</div></div>
      <output id="inputs">0</output>
      <script>
        for (const control of [first, second, target]) {
          control.addEventListener('click', () => { inputs.value = String(Number(inputs.value) + 1); });
          control.addEventListener('keydown', () => { inputs.value = String(Number(inputs.value) + 1); });
        }
      </script>
    </body></html>`);

    await expect(controller?.inspectControl({
      control: { role: 'button', name: 'Target field', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    })).rejects.toMatchObject({
      code: 'AMBIGUOUS_TARGET',
      details: {
        reason: 'multiple_competing_popup_owners',
        actionDispatched: false,
        renderedPopupCount: 2,
      },
    });
    await expect(page.locator('#inputs').textContent()).resolves.toBe('0');
  });

  it('uses one newly rendered surface as causal ownership after one exact opener input', async () => {
    const page = await openFixture(`<!doctype html><html><head><style>
      body { margin: 0; min-height: 300px; }
      button, #options { position: absolute; left: 20px; width: 240px; height: 40px; box-sizing: border-box; }
      #target { top: 20px; }
      #options { top: 60px; height: 160px; border: 1px solid black; z-index: 2; }
      #other-exterior { top: 220px; }
      #covered-a { top: 80px; }
      #covered-b { top: 120px; }
      #uncovered { top: 160px; z-index: 3; }
    </style></head><body tabindex="-1">
      <button id="target">Target field</button>
      <div id="options" hidden><div role="option">Target choice</div></div>
      <button id="other-exterior">Other exterior field</button>
      <button id="covered-a">Covered field A</button>
      <button id="covered-b">Covered field B</button>
      <button id="uncovered">Uncovered field</button>
      <output id="opens">0</output>
      <script>
        target.addEventListener('mousedown', () => {
          opens.value = String(Number(opens.value) + 1);
          options.hidden = false;
          const replacement = target.cloneNode(true);
          target.replaceWith(replacement);
          document.body.focus();
        });
      </script>
    </body></html>`);

    const inspected = await controller?.inspectControl({
      control: { role: 'button', name: 'Target field', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    expect(inspected?.inspection).toMatchObject({
      options: [{ name: 'Target choice' }],
      reveal: {
        openerActionDispatched: true,
        popupOpened: true,
        associationProof: 'post_dispatch_unique',
        renderedPopupCount: 1,
        popupOwnership: {
          proofTier: 'spatial',
          candidateCount: 5,
          exteriorCandidateCount: 2,
          overlappingCandidateCount: 3,
          surfaceCoveredCandidateCount: 2,
          decision: 'tie_or_near',
        },
      },
    });
    await expect(page.locator('#opens').textContent()).resolves.toBe('1');
  });

  it('does not infer causality when a popup appears during reversible opener preparation', async () => {
    const page = await openFixture(`<!doctype html><html><head><style>
      body { margin: 0; min-height: 1800px; }
      #target { position: absolute; top: 1400px; left: 20px; }
      #other { position: fixed; top: 120px; left: 20px; }
      #options { position: fixed; top: 20px; left: 20px; width: 200px; height: 80px; border: 1px solid black; }
    </style></head><body>
      <button id="target">Target field</button>
      <button id="other" aria-controls="options">Other field</button>
      <div id="options" role="listbox" hidden><div role="option">Autonomous choice</div></div>
      <output id="opens">0</output>
      <script>
        addEventListener('scroll', () => { options.hidden = false; }, { once: true });
        target.addEventListener('mousedown', () => {
          opens.value = String(Number(opens.value) + 1);
        });
      </script>
    </body></html>`);

    await expect(controller?.inspectControl({
      control: { role: 'button', name: 'Target field', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    })).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      details: {
        reason: 'popup_surface_present_before_reveal',
        actionDispatched: false,
        renderedPopupCount: 1,
      },
    });
    await expect(page.locator('#opens').textContent()).resolves.toBe('0');
  });
});
