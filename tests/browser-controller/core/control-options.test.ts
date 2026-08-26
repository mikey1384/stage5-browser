import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BrowserController } from '../../../src/browser-controller.js';
import { Stage5BrowserError } from '../../../src/errors.js';
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
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-control-options-'));
  controller = new BrowserController(browserConfig(temporaryRoot));
  await controller.open({
    url: `http://127.0.0.1:${port}/form`,
    newTab: false,
    stabilizationMs: 0,
    timeoutMs: 5_000,
  });
}

describe('BrowserController generic control inspection and selection', () => {
  it('inspects and selects a native option through a one-use exact capability', async () => {
    await openFixture(`<!doctype html><html><body>
      <label for="purpose">Use of account</label>
      <select id="purpose">
        <option>Business operations</option>
        <option>Client funds</option>
        <option>Proprietary trading / investing—using the company’s own capital</option>
      </select>
      <output id="events">0</output>
      <script>
        purpose.addEventListener('change', () => { events.value = String(Number(events.value) + 1); });
      </script>
    </body></html>`);

    const inspected = await controller?.inspectControl({
      control: { role: 'combobox', name: 'Use of account', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    expect(inspected?.inspection).toMatchObject({
      kind: 'native_select',
      optionsComplete: true,
      reveal: { openerActionDispatched: false, scrollSteps: 0, boundaryReached: true },
      choice: { responsibility: 'agent', decisionRequired: true },
    });
    expect(inspected?.inspection.options.map(({ name }) => name)).toEqual([
      'Business operations',
      'Client funds',
      'Proprietary trading / investing—using the company’s own capital',
    ]);
    const intended = inspected?.inspection.options.at(-1);
    expect(intended).toBeDefined();
    if (inspected === undefined || intended === undefined) throw new Error('Native fixture did not expose the intended option.');

    const selected = await controller?.selectOption({
      inspectionId: inspected.inspection.inspectionId,
      optionId: intended.optionId,
      control: null,
      option: null,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(selected?.evidence).toMatchObject({
      actionDispatched: true,
      changeEventObserved: true,
      selectionEffectObserved: true,
      selectedState: true,
      popupClosed: null,
    });
    const page = (controller as unknown as { activePage: { locator: (selector: string) => { inputValue: () => Promise<string>; textContent: () => Promise<string | null> } } }).activePage;
    expect(await page.locator('#purpose').inputValue()).toBe('Proprietary trading / investing—using the company’s own capital');
    expect(await page.locator('#events').textContent()).toBe('1');

    await expect(controller?.selectOption({
      inspectionId: inspected.inspection.inspectionId,
      optionId: intended.optionId,
      control: null,
      option: null,
      frameId: null,
      timeoutMs: 5_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'TARGET_NOT_FOUND',
      details: { reason: 'stale_control_inspection', actionDispatched: false },
    });

    const direct = await controller?.selectOption({
      inspectionId: null,
      optionId: null,
      control: { role: 'combobox', name: 'Use of account', exact: true },
      option: { name: 'Client funds', exact: true },
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(direct?.selectedName).toBe('Client funds');
    expect(direct?.evidence).toMatchObject({ actionDispatched: true, selectedState: true });
    expect(await page.locator('#events').textContent()).toBe('2');
  });

  it('reveals and scrolls only the exact custom popup before selecting a below-fold choice', async () => {
    await openFixture(`<!doctype html><html><head><style>
      #choices { max-height: 84px; overflow-y: auto; border: 1px solid black; }
      [role=option] { height: 38px; }
    </style></head><body>
      <button id="purpose" aria-haspopup="listbox" aria-controls="choices" aria-expanded="false">Use of account</button>
      <div id="choices" role="listbox" aria-label="Use of account choices" hidden>
        <div role="option">Business operations</div>
        <div role="option">Payroll</div>
        <div role="option">Client custody</div>
        <div role="option">Marketplace settlement</div>
        <div role="option">Treasury management</div>
        <div role="option">Proprietary trading / investing—using the company’s own capital</div>
      </div>
      <output id="opener-count">0</output><output id="option-count">0</output>
      <script>
        const openerCount = document.getElementById('opener-count');
        const optionCount = document.getElementById('option-count');
        purpose.addEventListener('click', () => {
          openerCount.value = String(Number(openerCount.value) + 1);
          purpose.setAttribute('aria-expanded', 'true');
          choices.hidden = false;
        });
        for (const option of choices.querySelectorAll('[role=option]')) {
          option.addEventListener('click', () => {
            optionCount.value = String(Number(optionCount.value) + 1);
            option.setAttribute('aria-selected', 'true');
            choices.hidden = true;
            purpose.setAttribute('aria-expanded', 'false');
          });
        }
      </script>
    </body></html>`);

    const inspected = await controller?.inspectControl({
      control: { role: 'button', name: 'Use of account', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    expect(inspected?.inspection).toMatchObject({
      kind: 'custom_popup',
      optionsComplete: true,
      reveal: {
        openerActionDispatched: true,
        popupOpened: true,
        boundaryReached: true,
      },
    });
    expect(inspected?.inspection.reveal.scrollSteps).toBeGreaterThan(0);
    const intended = inspected?.inspection.options.find(({ name }) => name.startsWith('Proprietary trading'));
    expect(intended).toBeDefined();
    if (inspected === undefined || intended === undefined) throw new Error('Custom fixture did not expose the below-fold option.');

    const selected = await controller?.selectOption({
      inspectionId: inspected.inspection.inspectionId,
      optionId: intended.optionId,
      control: null,
      option: null,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(selected?.evidence).toMatchObject({
      actionDispatched: true,
      selectionEffectObserved: true,
      popupClosed: true,
    });
    const page = (controller as unknown as { activePage: { locator: (selector: string) => { textContent: () => Promise<string | null> } } }).activePage;
    expect(await page.locator('#opener-count').textContent()).toBe('1');
    expect(await page.locator('#option-count').textContent()).toBe('1');
  });

  it('reconciles a popup that closes on pointer-down without replaying the option', async () => {
    await openFixture(`<!doctype html><html><body>
      <button id="purpose" aria-haspopup="listbox" aria-controls="choices" aria-expanded="true">Use of account</button>
      <div id="choices" role="listbox"><div id="choice" role="option">Treasury management</div></div>
      <output id="downs">0</output><output id="clicks">0</output>
      <script>
        choice.addEventListener('pointerdown', () => {
          downs.value = String(Number(downs.value) + 1);
          choices.hidden = true;
          purpose.setAttribute('aria-expanded', 'false');
        });
        choice.addEventListener('click', () => { clicks.value = String(Number(clicks.value) + 1); });
      </script>
    </body></html>`);
    const inspected = await controller?.inspectControl({
      control: { role: 'button', name: 'Use of account', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    const intended = inspected?.inspection.options[0];
    if (inspected === undefined || intended === undefined) throw new Error('Partial-input fixture did not expose its option.');

    const selected = await controller?.selectOption({
      inspectionId: inspected.inspection.inspectionId,
      optionId: intended.optionId,
      control: null,
      option: null,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(selected?.evidence.selectionEffectObserved).toBe(true);
    expect(selected?.evidence.popupClosed).toBe(true);
    const page = (controller as unknown as { activePage: { locator: (selector: string) => { textContent: () => Promise<string | null> } } }).activePage;
    expect(await page.locator('#downs').textContent()).toBe('1');
    expect(await page.locator('#clicks').textContent()).toBe('0');
  });

  it('dismisses one structurally owned competing popup before opening the intended control once', async () => {
    await openFixture(`<!doctype html><html><body>
      <button id="first" aria-haspopup="listbox" aria-controls="first-options" aria-expanded="true">Funding source</button>
      <div id="first-options" role="listbox" aria-label="Funding choices"><div role="option">Treasury</div></div>
      <button id="second" aria-haspopup="listbox" aria-controls="second-options" aria-expanded="false">Use of account</button>
      <div id="second-options" role="listbox" aria-label="Account use choices" hidden>
        <div role="option">Business operations</div><div role="option">Proprietary investing</div>
      </div>
      <output id="escapes">0</output><output id="target-clicks">0</output>
      <script>
        const first = document.querySelector('#first');
        const firstOptions = document.querySelector('#first-options');
        const second = document.querySelector('#second');
        const secondOptions = document.querySelector('#second-options');
        const escapeCount = document.querySelector('#escapes');
        const targetClickCount = document.querySelector('#target-clicks');
        first.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape') return;
          escapeCount.value = String(Number(escapeCount.value) + 1);
          firstOptions.hidden = true; first.setAttribute('aria-expanded', 'false');
        });
        second.addEventListener('click', () => {
          targetClickCount.value = String(Number(targetClickCount.value) + 1);
          if (!firstOptions.hidden) {
            firstOptions.hidden = true; first.setAttribute('aria-expanded', 'false'); return;
          }
          secondOptions.hidden = false; second.setAttribute('aria-expanded', 'true');
        });
      </script>
    </body></html>`);

    const inspected = await controller?.inspectControl({
      control: { role: 'button', name: 'Use of account', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    expect(inspected?.inspection.reveal).toMatchObject({
      competingPopupDismissed: true,
      preparationActionDispatched: true,
      openerActionDispatched: true,
      popupOpened: true,
    });
    expect(inspected?.inspection.options.map(({ name }) => name)).toEqual([
      'Business operations',
      'Proprietary investing',
    ]);
    const page = (controller as unknown as { activePage: { locator: (selector: string) => { textContent: () => Promise<string | null> } } }).activePage;
    expect(await page.locator('#escapes').textContent()).toBe('1');
    expect(await page.locator('#target-clicks').textContent()).toBe('1');
  });

  it('surfaces a document replacement instead of replaying or returning only the opener postcondition', async () => {
    let signInRequests = 0;
    server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (requestUrl.pathname === '/sign-in') {
        signInRequests += 1;
        response.end(`<!doctype html><html><body><h1>Session refresh</h1>
          <script>location.replace('/form?returned=1')</script></body></html>`);
        return;
      }
      response.end(`<!doctype html><html><body>
        <h1>${requestUrl.searchParams.has('returned') ? 'Replacement form' : 'Original form'}</h1>
        <button aria-haspopup="listbox" aria-expanded="false" onclick="location.href='/sign-in'">
          Intended dropdown
        </button>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-control-document-replacement-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/form`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const baseline = await controller.pageEvents({ afterSequence: null, limit: 50 });

    await expect(controller.inspectControl({
      control: { role: 'button', name: 'Intended dropdown', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'TARGET_NOT_FOUND',
      details: {
        reason: 'document_changed_during_control_inspection',
        actionDispatched: true,
        inspectionAborted: true,
        stateRisk: 'read_page_events_before_resuming',
      },
    });

    expect(signInRequests).toBe(1);
    const events = await controller.pageEvents({ afterSequence: baseline.cursor, limit: 50 });
    expect(events.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'document_replaced',
        stateRisk: 'all_unsaved_form_state_may_be_lost',
      }),
    ]));
    const fresh = await controller.snapshot({
      depth: 5,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(fresh.snapshot).toContain('Replacement form');
  });

  it('composes idempotent native and custom multi-selection without toggling satisfied choices', async () => {
    await openFixture(`<!doctype html><html><body>
      <label for="native">Native interests</label>
      <select id="native" multiple>
        <option selected>Research</option><option>Operations</option><option>Finance</option>
      </select>
      <output id="native-events">0</output>

      <button id="custom" aria-haspopup="listbox" aria-expanded="false">Custom interests</button>
      <div id="custom-options" role="listbox" aria-label="Custom interests choices" aria-multiselectable="true" hidden>
        <div id="selected-choice" role="option" aria-selected="true">Research</div>
        <div id="new-choice" role="option" aria-selected="false">Operations</div>
      </div>
      <output id="custom-opens">0</output><output id="selected-clicks">0</output><output id="new-clicks">0</output>
      <script>
        const nativeEvents = document.querySelector('#native-events');
        const customOptions = document.querySelector('#custom-options');
        const customOpens = document.querySelector('#custom-opens');
        const selectedChoice = document.querySelector('#selected-choice');
        const selectedClicks = document.querySelector('#selected-clicks');
        const newChoice = document.querySelector('#new-choice');
        const newClicks = document.querySelector('#new-clicks');
        native.addEventListener('change', () => { nativeEvents.value = String(Number(nativeEvents.value) + 1); });
        custom.addEventListener('click', () => {
          customOpens.value = String(Number(customOpens.value) + 1);
          custom.setAttribute('aria-expanded', 'true'); customOptions.hidden = false;
        });
        selectedChoice.addEventListener('click', () => {
          selectedClicks.value = String(Number(selectedClicks.value) + 1);
          selectedChoice.setAttribute('aria-selected', selectedChoice.getAttribute('aria-selected') === 'true' ? 'false' : 'true');
        });
        newChoice.addEventListener('click', () => {
          newClicks.value = String(Number(newClicks.value) + 1);
          newChoice.setAttribute('aria-selected', 'true');
        });
      </script>
    </body></html>`);

    const native = await controller?.selectOptions({
      inspectionId: null,
      optionIds: null,
      control: { role: 'listbox', name: 'Native interests', exact: true },
      options: [
        { name: 'Research', exact: true },
        { name: 'Operations', exact: true },
      ],
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(native?.selectedNames).toEqual(['Research', 'Operations']);
    expect(native?.selections.map(({ evidence }) => evidence.actionDispatched)).toEqual([false, true]);

    const custom = await controller?.selectOptions({
      inspectionId: null,
      optionIds: null,
      control: { role: 'button', name: 'Custom interests', exact: true },
      options: [
        { name: 'Research', exact: true },
        { name: 'Operations', exact: true },
      ],
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(custom?.selectedNames).toEqual(['Research', 'Operations']);
    expect(custom?.selections.map(({ evidence }) => evidence.actionDispatched)).toEqual([false, true]);

    const page = (controller as unknown as { activePage: { locator: (selector: string) => { textContent: () => Promise<string | null>; isChecked: () => Promise<boolean> } } }).activePage;
    expect(await page.locator('#native-events').textContent()).toBe('1');
    expect(await page.locator('#custom-opens').textContent()).toBe('1');
    expect(await page.locator('#selected-clicks').textContent()).toBe('0');
    expect(await page.locator('#new-clicks').textContent()).toBe('1');
  });
});
