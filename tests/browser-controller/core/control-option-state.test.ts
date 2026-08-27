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
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-control-option-state-'));
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

async function inspectCheckboxBackedOption(checked: boolean): Promise<{
  controller: BrowserController;
  inspectionMultiple: boolean;
  observedSelected: boolean | null;
  inspectionId: string;
  optionId: string;
  page: Page;
}> {
  const fixture = await openFixture(`<!doctype html><html><body>
      <button id="funding" aria-haspopup="listbox" aria-controls="funding-options" aria-expanded="false">
        Funding source
      </button>
      <div id="funding-options" role="listbox" hidden>
        <div id="company-funds" role="option">
          <span>Company treasury</span>
          <input id="selection-marker" type="checkbox" aria-hidden="true" ${checked ? 'checked' : ''}>
        </div>
      </div>
      <output id="opener-clicks">0</output>
      <output id="option-clicks">0</output>
      <script>
        const openerClicks = document.querySelector('#opener-clicks');
        const optionClicks = document.querySelector('#option-clicks');
        const funding = document.querySelector('#funding');
        const fundingOptions = document.querySelector('#funding-options');
        const companyFunds = document.querySelector('#company-funds');
        const selectionMarker = document.querySelector('#selection-marker');
        funding.addEventListener('click', () => {
          openerClicks.value = String(Number(openerClicks.value) + 1);
          funding.setAttribute('aria-expanded', 'true');
          fundingOptions.hidden = false;
        });
        companyFunds.addEventListener('click', () => {
          optionClicks.value = String(Number(optionClicks.value) + 1);
          selectionMarker.checked = !selectionMarker.checked;
        });
      </script>
    </body></html>`);
  const inspected = await fixture.controller.inspectControl({
    control: { role: 'button', name: 'Funding source', exact: true },
    frameId: null,
    revealOptions: true,
    maxOptions: 20,
    timeoutMs: 5_000,
  });
  const option = inspected.inspection.options[0];
  if (option === undefined) throw new Error('The checkbox-backed fixture exposed no option.');
  return {
    ...fixture,
    inspectionMultiple: inspected.inspection.multiple,
    observedSelected: option.selected,
    inspectionId: inspected.inspection.inspectionId,
    optionId: option.optionId,
  };
}

async function selectOption(fixture: Awaited<ReturnType<typeof inspectCheckboxBackedOption>>) {
  return fixture.controller.selectOption({
    inspectionId: fixture.inspectionId,
    optionId: fixture.optionId,
    control: null,
    option: null,
    frameId: null,
    timeoutMs: 2_000,
  });
}

describe('BrowserController custom option state', () => {
  it('recognizes a nested checkbox as multi-select state while the popup stays open', async () => {
    const fixture = await inspectCheckboxBackedOption(false);
    expect(fixture.inspectionMultiple).toBe(true);
    expect(fixture.observedSelected).toBe(false);

    const selected = await selectOption(fixture);

    expect(selected.evidence).toMatchObject({
      actionDispatched: true,
      selectedState: true,
      popupClosed: false,
    });
    expect(await fixture.page.locator('#opener-clicks').textContent()).toBe('1');
    expect(await fixture.page.locator('#option-clicks').textContent()).toBe('1');
  });

  it('does not toggle an already checked nested option', async () => {
    const fixture = await inspectCheckboxBackedOption(true);

    const selected = await selectOption(fixture);

    expect(selected.evidence).toMatchObject({
      actionDispatched: false,
      selectedState: true,
    });
    expect(await fixture.page.locator('#opener-clicks').textContent()).toBe('1');
    expect(await fixture.page.locator('#option-clicks').textContent()).toBe('0');
    expect(await fixture.page.locator('#selection-marker').isChecked()).toBe(true);
  });

  it('deselects one explicitly checked custom multi-select option exactly once', async () => {
    const fixture = await inspectCheckboxBackedOption(true);

    const deselected = await fixture.controller.selectOption({
      inspectionId: fixture.inspectionId,
      optionId: fixture.optionId,
      control: null,
      option: null,
      selected: false,
      frameId: null,
      timeoutMs: 2_000,
    });

    expect(deselected).toMatchObject({
      selected: false,
      evidence: {
        actionDispatched: true,
        selectedState: false,
        popupClosed: false,
      },
    });
    expect(await fixture.page.locator('#opener-clicks').textContent()).toBe('1');
    expect(await fixture.page.locator('#option-clicks').textContent()).toBe('1');
    expect(await fixture.page.locator('#selection-marker').isChecked()).toBe(false);
  });

  it('deselects one native multi-select option without disturbing its peers', async () => {
    const fixture = await openFixture(`<!doctype html><html><body>
      <label for="sources">Funding sources</label>
      <select id="sources" multiple>
        <option selected>Treasury funds</option>
        <option selected>Operating revenue</option>
        <option>Client funds</option>
      </select>
      <output id="events">0</output>
      <script>
        sources.addEventListener('change', () => { events.value = String(Number(events.value) + 1); });
      </script>
    </body></html>`);
    const inspected = await fixture.controller.inspectControl({
      control: { role: 'listbox', name: 'Funding sources', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    const treasury = inspected.inspection.options.find(({ name }) => name === 'Treasury funds');
    if (treasury === undefined) throw new Error('Native multi-select fixture exposed no selected option.');

    const deselected = await fixture.controller.selectOption({
      inspectionId: inspected.inspection.inspectionId,
      optionId: treasury.optionId,
      control: null,
      option: null,
      selected: false,
      frameId: null,
      timeoutMs: 5_000,
    });

    expect(deselected).toMatchObject({
      selected: false,
      evidence: {
        actionDispatched: true,
        selectionEffectObserved: true,
        selectedState: false,
      },
    });
    expect(await fixture.page.locator('#sources').inputValue()).toBe('Operating revenue');
    expect(await fixture.page.locator('#events').textContent()).toBe('1');
  });

  it('maps several existing field chips back to their exact options without input', async () => {
    const fixture = await openFixture(`<!doctype html><html><body>
      <section id="funding-field">
        <div id="selected-values">
          <span id="treasury-chip">Treasury funds</span>
          <span id="operating-chip">Operating revenue</span>
          <span id="investment-chip">Investment proceeds</span>
          <span>Conflicting choice</span>
          <span>Ambiguous funds</span>
          <input type="text" aria-label="Funding source">
        </div>
        <button aria-haspopup="listbox" aria-controls="funding-options" aria-expanded="true">
          Funding source
        </button>
      </section>
      <section id="other-field">
        <button aria-haspopup="listbox">Other field</button>
        <span>Unrelated exact text</span>
      </section>
      <div id="funding-options" role="listbox">
        <div role="option">Treasury funds — company holdings</div>
        <div role="option">Operating revenue — customer receipts</div>
        <div role="option">Investment proceeds — asset sales</div>
        <div role="option" aria-selected="false">Conflicting choice — contradictory state</div>
        <div role="option">Ambiguous funds — first source</div>
        <div role="option">Ambiguous funds — second source</div>
        <div role="option">Unselected choice</div>
        <div role="option">Unrelated exact text</div>
      </div>
      <output id="option-clicks">0</output>
      <script>
        const optionClicks = document.querySelector('#option-clicks');
        document.addEventListener('click', (event) => {
          const option = event.target.closest('#funding-options [role=option]');
          if (option === null) return;
          optionClicks.value = String(Number(optionClicks.value) + 1);
          if (option.textContent.startsWith('Treasury funds')) {
            document.querySelector('#treasury-chip')?.remove();
          }
        });
      </script>
    </body></html>`);

    const inspected = await fixture.controller.inspectControl({
      control: { role: 'button', name: 'Funding source', exact: true },
      frameId: null,
      revealOptions: false,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    const byName = new Map(inspected.inspection.options.map((option) => [option.name, option]));

    expect(inspected.inspection.multiple).toBe(true);
    expect(byName.get('Treasury funds — company holdings')?.selected).toBe(true);
    expect(byName.get('Operating revenue — customer receipts')?.selected).toBe(true);
    expect(byName.get('Investment proceeds — asset sales')?.selected).toBe(true);
    expect(byName.get('Conflicting choice — contradictory state')?.selected).toBeNull();
    expect(inspected.inspection.options
      .filter(({ name }) => name.startsWith('Ambiguous funds —'))
      .every(({ selected }) => selected === null)).toBe(true);
    expect(byName.get('Unselected choice')?.selected).toBeNull();
    expect(byName.get('Unrelated exact text')?.selected).toBeNull();
    expect(inspected.inspection.reveal).toMatchObject({
      openerActionDispatched: false,
      preparationActionDispatched: false,
    });

    const represented = byName.get('Treasury funds — company holdings');
    if (represented === undefined) throw new Error('The represented option was not observed.');
    fixture.controller.drainActionPhaseTelemetry();
    const selected = await fixture.controller.selectOption({
      inspectionId: inspected.inspection.inspectionId,
      optionId: represented.optionId,
      control: null,
      option: null,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(selected.evidence).toMatchObject({
      actionDispatched: false,
      selectedRepresentationObserved: true,
      selectedState: null,
    });
    expect(await fixture.page.locator('#option-clicks').textContent()).toBe('0');
    expect(fixture.controller.drainActionPhaseTelemetry().actionPhases).toEqual([
      expect.objectContaining({
        action: 'select_option',
        dispatchState: 'not_attempted',
        dispatchAttempts: 0,
        terminalOutcome: 'succeeded',
      }),
    ]);

    const reboundInspection = await fixture.controller.inspectControl({
      control: { role: 'button', name: 'Funding source', exact: true },
      frameId: null,
      revealOptions: false,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    const reboundTreasury = reboundInspection.inspection.options.find(({ name }) =>
      name === 'Treasury funds — company holdings');
    if (reboundTreasury === undefined) throw new Error('The represented option was not observed before replacement.');
    await fixture.page.evaluate(() => {
      const opener = document.querySelector('#funding-field button');
      const popup = document.querySelector('#funding-options');
      opener?.replaceWith(opener.cloneNode(true));
      popup?.replaceWith(popup.cloneNode(true));
    });
    const reboundSelected = await fixture.controller.selectOption({
      inspectionId: reboundInspection.inspection.inspectionId,
      optionId: reboundTreasury.optionId,
      control: null,
      option: null,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(reboundSelected.evidence).toMatchObject({
      actionDispatched: false,
      selectedRepresentationObserved: true,
    });
    expect(await fixture.page.locator('#option-clicks').textContent()).toBe('0');

    const deselectionInspection = await fixture.controller.inspectControl({
      control: { role: 'button', name: 'Funding source', exact: true },
      frameId: null,
      revealOptions: false,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    const selectedTreasury = deselectionInspection.inspection.options.find(({ name }) =>
      name === 'Treasury funds — company holdings');
    if (selectedTreasury === undefined) throw new Error('The selected treasury option was not observed.');
    fixture.controller.drainActionPhaseTelemetry();
    const deselected = await fixture.controller.selectOption({
      inspectionId: deselectionInspection.inspection.inspectionId,
      optionId: selectedTreasury.optionId,
      control: null,
      option: null,
      selected: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(deselected).toMatchObject({
      selected: false,
      evidence: {
        actionDispatched: true,
        selectionEffectObserved: true,
        selectedRepresentationObserved: false,
        selectedState: null,
        popupClosed: false,
      },
    });
    expect(await fixture.page.locator('#option-clicks').textContent()).toBe('1');
    expect(await fixture.page.locator('#treasury-chip').count()).toBe(0);
    expect(await fixture.page.locator('#operating-chip').count()).toBe(1);
    expect(await fixture.page.locator('#investment-chip').count()).toBe(1);
    expect(fixture.controller.drainActionPhaseTelemetry().actionPhases).toEqual([
      expect.objectContaining({
        action: 'select_option',
        dispatchState: 'dispatched',
        dispatchAttempts: 1,
        terminalOutcome: 'succeeded',
      }),
    ]);

    const unknownInspection = await fixture.controller.inspectControl({
      control: { role: 'button', name: 'Funding source', exact: true },
      frameId: null,
      revealOptions: false,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    const unknown = unknownInspection.inspection.options.find(({ name }) => name === 'Unselected choice');
    if (unknown === undefined) throw new Error('The unknown-state option was not observed.');
    await expect(fixture.controller.selectOption({
      inspectionId: unknownInspection.inspection.inspectionId,
      optionId: unknown.optionId,
      control: null,
      option: null,
      selected: false,
      frameId: null,
      timeoutMs: 5_000,
    })).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      details: { reason: 'control_option_current_state_unknown', actionDispatched: false },
    });
    expect(await fixture.page.locator('#option-clicks').textContent()).toBe('1');

    const conflictInspection = await fixture.controller.inspectControl({
      control: { role: 'button', name: 'Funding source', exact: true },
      frameId: null,
      revealOptions: false,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    const conflicting = conflictInspection.inspection.options.find(({ name }) =>
      name === 'Conflicting choice — contradictory state');
    if (conflicting === undefined) throw new Error('The conflicting option was not observed.');
    await expect(fixture.controller.selectOption({
      inspectionId: conflictInspection.inspection.inspectionId,
      optionId: conflicting.optionId,
      control: null,
      option: null,
      frameId: null,
      timeoutMs: 5_000,
    })).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      details: { reason: 'control_option_state_conflict', actionDispatched: false },
    });
    expect(await fixture.page.locator('#option-clicks').textContent()).toBe('1');
  });

  it('recognizes explicit framework state without trusting appearance-only classes', async () => {
    const fixture = await openFixture(`<!doctype html><html><body>
      <button aria-haspopup="listbox" aria-controls="choices" aria-expanded="true">Framework choices</button>
      <div id="choices" role="listbox">
        <div role="option">Framework checked <span role="checkbox" data-state="checked"></span></div>
        <div role="option">Framework unchecked <span role="checkbox" data-state="unchecked"></span></div>
        <div role="option" class="selected checked active">Appearance only</div>
      </div>
    </body></html>`);

    const inspected = await fixture.controller.inspectControl({
      control: { role: 'button', name: 'Framework choices', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    const byName = new Map(inspected.inspection.options.map((option) => [option.name, option]));

    expect(inspected.inspection.multiple).toBe(true);
    expect(byName.get('Framework checked')?.selected).toBe(true);
    expect(byName.get('Framework unchecked')?.selected).toBe(false);
    expect(byName.get('Appearance only')?.selected).toBeNull();
    expect(inspected.inspection.reveal.openerActionDispatched).toBe(false);
  });
});
