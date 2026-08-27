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
