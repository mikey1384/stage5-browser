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
        associationProof: 'explicit',
      },
    });
    await expect(page.locator('#prior-options').isVisible()).resolves.toBe(true);
    await expect(page.locator('#target-options').isVisible()).resolves.toBe(true);
    await expect(page.locator('#inputs').textContent()).resolves.toBe('0');
  });

  it('passively associates two unlinked portal popups with their unique geometric anchors', async () => {
    const page = await openFixture(`<!doctype html><html><head><style>
      body { margin: 0; position: relative; min-height: 500px; }
      button, .popup { position: absolute; left: 24px; width: 240px; box-sizing: border-box; }
      button { height: 40px; }
      .popup { height: 80px; border: 1px solid black; overflow-y: auto; }
      .popup [role="option"] { height: 32px; }
      #prior { top: 24px; }
      #prior-options { top: 64px; }
      #target { top: 210px; }
      #target-options { top: 250px; }
    </style></head><body>
      <button id="prior" type="button">Intended use</button>
      <button id="target" type="button">Funding source</button>
      <div id="prior-options" class="popup"><div role="option">Treasury</div></div>
      <div id="target-options" class="popup">
        <div role="option">Business revenue</div>
        <div role="option">Company capital</div>
        <div role="option">Client funds</div>
        <div role="option">External financing</div>
      </div>
      <output id="inputs">0</output>
      <script>
        for (const control of [prior, target]) {
          control.addEventListener('click', () => { inputs.value = String(Number(inputs.value) + 1); });
          control.addEventListener('keydown', () => { inputs.value = String(Number(inputs.value) + 1); });
        }
        document.body.focus();
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
      expanded: null,
      reveal: {
        requested: false,
        competingPopupDismissed: false,
        preparationActionDispatched: false,
        openerActionDispatched: false,
        popupOpened: true,
        associationProof: 'spatial',
        surfaceProof: 'positioned_option_group',
        renderedPopupCount: 2,
      },
    });
    expect(inspected?.inspection.options.map(({ name }) => name)).toEqual([
      'Business revenue',
      'Company capital',
      'Client funds',
      'External financing',
    ]);
    expect(inspected?.inspection.reveal.scrollSteps).toBeGreaterThan(0);
    await expect(page.locator('#prior-options').isVisible()).resolves.toBe(true);
    await expect(page.locator('#target-options').isVisible()).resolves.toBe(true);
    await expect(page.locator('#inputs').textContent()).resolves.toBe('0');
  });

  it('partitions logical option branches inside one broad positioned portal', async () => {
    const page = await openFixture(`<!doctype html><html><head><style>
      body { margin: 0; position: relative; min-height: 500px; }
      button, #portal { position: absolute; left: 24px; width: 240px; box-sizing: border-box; }
      button { height: 40px; }
      #prior { top: 24px; }
      #target { top: 196px; }
      #portal { top: 64px; height: 212px; display: flex; flex-direction: column; gap: 100px; }
      .option-branch { height: 32px; border: 1px solid black; }
      [role="option"] { height: 30px; }
    </style></head><body>
      <button id="prior" type="button">Intended use</button>
      <button id="target" type="button">Funding source</button>
      <div id="portal">
        <div id="prior-options" class="option-branch"><div role="option">Treasury</div></div>
        <div id="target-options" class="option-branch"><div role="option">Company capital</div></div>
      </div>
      <output id="inputs">0</output>
      <script>
        for (const control of [prior, target]) {
          control.addEventListener('click', () => { inputs.value = String(Number(inputs.value) + 1); });
          control.addEventListener('keydown', () => { inputs.value = String(Number(inputs.value) + 1); });
        }
        document.body.focus();
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
      options: [{ name: 'Company capital' }],
      reveal: {
        requested: false,
        openerActionDispatched: false,
        preparationActionDispatched: false,
        popupOpened: true,
        associationProof: 'spatial',
        surfaceProof: 'positioned_option_group',
        renderedPopupCount: 2,
      },
    });
    await expect(page.locator('#prior-options').isVisible()).resolves.toBe(true);
    await expect(page.locator('#target-options').isVisible()).resolves.toBe(true);
    await expect(page.locator('#inputs').textContent()).resolves.toBe('0');
  });

  it('keeps contiguous option wrappers as one positioned popup surface', async () => {
    const page = await openFixture(`<!doctype html><html><head><style>
      body { margin: 0; position: relative; min-height: 300px; }
      #target, #portal { position: absolute; left: 24px; width: 240px; box-sizing: border-box; }
      #target { top: 24px; height: 40px; }
      #portal { top: 64px; }
      .option-wrapper, [role="option"] { height: 32px; }
    </style></head><body>
      <button id="target" type="button">Funding source</button>
      <div id="portal">
        <div class="option-wrapper"><div role="option">Business revenue</div></div>
        <div class="option-wrapper"><div role="option">Company capital</div></div>
        <div class="option-wrapper"><div role="option">External financing</div></div>
      </div>
      <output id="inputs">0</output>
      <script>
        target.addEventListener('click', () => { inputs.value = String(Number(inputs.value) + 1); });
        target.addEventListener('keydown', () => { inputs.value = String(Number(inputs.value) + 1); });
        document.body.focus();
      </script>
    </body></html>`);

    const inspected = await controller?.inspectControl({
      control: { role: 'button', name: 'Funding source', exact: true },
      frameId: null,
      revealOptions: false,
      maxOptions: 20,
      timeoutMs: 5_000,
    });

    expect(inspected?.inspection.reveal).toMatchObject({
      openerActionDispatched: false,
      popupOpened: true,
      associationProof: 'spatial',
      surfaceProof: 'positioned_option_group',
      renderedPopupCount: 1,
    });
    expect(inspected?.inspection.options.map(({ name }) => name)).toEqual([
      'Business revenue',
      'Company capital',
      'External financing',
    ]);
    await expect(page.locator('#inputs').textContent()).resolves.toBe('0');
  });

  it('associates an unlinked popup with its uniquely nearest plausible anchor', async () => {
    const page = await openFixture(`<!doctype html><html><head><style>
      body { margin: 0; position: relative; min-height: 400px; }
      button, .popup { position: absolute; left: 24px; width: 240px; box-sizing: border-box; }
      button { height: 40px; }
      #first { top: 20px; }
      #target { top: 60px; }
      #options { top: 100px; height: 80px; border: 1px solid black; }
    </style></head><body>
      <button id="first" type="button">First source</button>
      <button id="target" type="button">Funding source</button>
      <div id="options" class="popup"><div role="option">Company capital</div></div>
      <output id="inputs">0</output>
      <script>
        for (const control of [first, target]) {
          control.addEventListener('click', () => { inputs.value = String(Number(inputs.value) + 1); });
          control.addEventListener('keydown', () => { inputs.value = String(Number(inputs.value) + 1); });
        }
        document.body.focus();
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
      options: [{ name: 'Company capital' }],
      reveal: {
        openerActionDispatched: false,
        popupOpened: true,
        associationProof: 'spatial',
        renderedPopupCount: 1,
        popupOwnership: {
          proofTier: 'spatial',
          candidateCount: 2,
          exteriorCandidateCount: 2,
          overlappingCandidateCount: 0,
          surfaceCoveredCandidateCount: 0,
          decision: 'decisive_distance',
        },
      },
    });
    await expect(page.locator('#inputs').textContent()).resolves.toBe('0');
  });

  it('prefers an exterior adjacent anchor over controls geometrically covered by the popup', async () => {
    const page = await openFixture(`<!doctype html><html><head><style>
      body { margin: 0; position: relative; min-height: 400px; }
      button, .popup { position: absolute; left: 24px; width: 240px; box-sizing: border-box; }
      button { height: 40px; }
      #target { top: 60px; }
      #options { top: 100px; height: 160px; border: 1px solid black; z-index: 2; }
      #covered { top: 140px; }
    </style></head><body>
      <button id="target" type="button">Funding source</button>
      <div id="options" class="popup"><div role="option">Company capital</div></div>
      <button id="covered" type="button">Covered sibling</button>
      <output id="inputs">0</output>
      <script>
        for (const control of [target, covered]) {
          control.addEventListener('click', () => { inputs.value = String(Number(inputs.value) + 1); });
          control.addEventListener('keydown', () => { inputs.value = String(Number(inputs.value) + 1); });
        }
        document.body.focus();
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
      options: [{ name: 'Company capital' }],
      reveal: {
        openerActionDispatched: false,
        popupOpened: true,
        associationProof: 'spatial',
        renderedPopupCount: 1,
        popupOwnership: {
          proofTier: 'spatial',
          candidateCount: 2,
          exteriorCandidateCount: 1,
          overlappingCandidateCount: 1,
          surfaceCoveredCandidateCount: 1,
          decision: 'covered_siblings_excluded',
        },
      },
    });
    await expect(page.locator('#inputs').textContent()).resolves.toBe('0');
  });

  it('keeps an uncovered overlapping control ambiguous with an exterior anchor', async () => {
    const page = await openFixture(`<!doctype html><html><head><style>
      body { margin: 0; position: relative; min-height: 400px; }
      button, .popup { position: absolute; left: 24px; width: 240px; box-sizing: border-box; }
      button { height: 40px; }
      #target { top: 60px; }
      #options { top: 100px; height: 160px; border: 1px solid black; z-index: 2; }
      #overlap { top: 140px; z-index: 3; }
    </style></head><body>
      <button id="target" type="button">Funding source</button>
      <div id="options" class="popup"><div role="option">Company capital</div></div>
      <button id="overlap" type="button">Uncovered overlap</button>
      <output id="inputs">0</output>
      <script>
        for (const control of [target, overlap]) {
          control.addEventListener('click', () => { inputs.value = String(Number(inputs.value) + 1); });
          control.addEventListener('keydown', () => { inputs.value = String(Number(inputs.value) + 1); });
        }
        document.body.focus();
      </script>
    </body></html>`);

    await expect(controller?.inspectControl({
      control: { role: 'button', name: 'Funding source', exact: true },
      frameId: null,
      revealOptions: false,
      maxOptions: 20,
      timeoutMs: 5_000,
    })).rejects.toMatchObject({
      code: 'AMBIGUOUS_TARGET',
      details: {
        reason: 'ambiguous_control_popup',
        actionDispatched: false,
        popupOwnership: {
          proofTier: 'spatial',
          candidateCount: 2,
          exteriorCandidateCount: 1,
          overlappingCandidateCount: 1,
          surfaceCoveredCandidateCount: 0,
          decision: 'tie_or_near',
        },
      },
    });
    await expect(page.locator('#inputs').textContent()).resolves.toBe('0');
  });

  it('fails closed when two popup anchors are positionally tied', async () => {
    const page = await openFixture(`<!doctype html><html><head><style>
      body { margin: 0; position: relative; min-height: 200px; }
      button, .popup { position: absolute; top: 40px; height: 40px; box-sizing: border-box; }
      #first { left: 20px; width: 100px; }
      #options { left: 120px; width: 80px; border: 1px solid black; }
      #target { left: 200px; width: 100px; }
    </style></head><body>
      <button id="first" type="button">First source</button>
      <div id="options" class="popup"><div role="option">Company capital</div></div>
      <button id="target" type="button">Funding source</button>
      <output id="inputs">0</output>
      <script>
        for (const control of [first, target]) {
          control.addEventListener('click', () => { inputs.value = String(Number(inputs.value) + 1); });
          control.addEventListener('keydown', () => { inputs.value = String(Number(inputs.value) + 1); });
        }
        document.body.focus();
      </script>
    </body></html>`);

    await expect(controller?.inspectControl({
      control: { role: 'button', name: 'Funding source', exact: true },
      frameId: null,
      revealOptions: false,
      maxOptions: 20,
      timeoutMs: 5_000,
    })).rejects.toMatchObject({
      code: 'AMBIGUOUS_TARGET',
      details: {
        reason: 'ambiguous_control_popup',
        actionDispatched: false,
        popupOwnership: {
          proofTier: 'spatial',
          candidateCount: 2,
          exteriorCandidateCount: 2,
          overlappingCandidateCount: 0,
          surfaceCoveredCandidateCount: 0,
          decision: 'tie_or_near',
        },
      },
    });
    await expect(page.locator('#inputs').textContent()).resolves.toBe('0');
  });
});
