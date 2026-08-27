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

async function openSearchableCountry(activeOption: boolean, initiallySelected = false): Promise<void> {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><body>
      <form id="application">
        <label for="country">Country</label>
        <input id="country" role="combobox" aria-autocomplete="list" aria-expanded="false"
          value="${initiallySelected ? 'United States' : ''}">
        <div id="country-options" role="listbox" hidden></div>
        <button type="submit">Continue</button>
      </form>
      <div id="unrelated" role="listbox"><div role="option">Unrelated visible choice</div></div>
      <output id="counts">inputs:0 enters:0 submits:0 selected:0</output>
      <script>
        const state = { inputs: 0, enters: 0, submits: 0, selected: 0 };
        const renderCounts = () => {
          counts.value = 'inputs:' + state.inputs + ' enters:' + state.enters +
            ' submits:' + state.submits + ' selected:' + state.selected;
        };
        country.addEventListener('input', () => {
          state.inputs += 1;
          country.setAttribute('aria-expanded', 'true');
          country.setAttribute('aria-controls', 'country-options');
          const options = document.querySelector('#country-options');
          options.hidden = false;
          options.innerHTML = '<div id="country-us" role="option">United States</div>' +
            '<div role="option">United States Minor Outlying Islands</div>';
          if (${JSON.stringify(activeOption)}) country.setAttribute('aria-activedescendant', 'country-us');
          renderCounts();
        });
        country.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return;
          state.enters += 1;
          if (country.getAttribute('aria-activedescendant') === 'country-us') {
            event.preventDefault();
            state.selected += 1;
            country.setAttribute('aria-expanded', 'false');
            country.removeAttribute('aria-activedescendant');
            document.querySelector('#country-options').hidden = true;
          }
          renderCounts();
        });
        application.addEventListener('submit', (event) => {
          event.preventDefault();
          state.submits += 1;
          renderCounts();
        });
      </script>
    </body></html>`);
  });
  const port = await listen(server);
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-searchable-selection-'));
  controller = new BrowserController(browserConfig(temporaryRoot));
  await controller.open({
    url: `http://127.0.0.1:${port}/form`,
    newTab: false,
    stabilizationMs: 0,
    timeoutMs: 5_000,
  });
}

function selectionInput() {
  return {
    inspectionId: null,
    optionId: null,
    control: { role: 'combobox' as const, name: 'Country', exact: true },
    option: { name: 'United States', exact: true },
    selected: true,
    interaction: 'auto' as const,
    frameId: null,
    timeoutMs: 5_000,
  };
}

describe('BrowserController atomic searchable selection', () => {
  it('binds an open popup through the focused control active descendant, excluding unrelated lists', async () => {
    await openSearchableCountry(true);
    await controller?.fillByRole({
      role: 'combobox',
      name: 'Country',
      exact: true,
      frameId: null,
      value: 'United States',
      timeoutMs: 5_000,
    });

    const inspected = await controller?.inspectControl({
      control: { role: 'combobox', name: 'Country', exact: true },
      frameId: null,
      revealOptions: false,
      maxOptions: 20,
      timeoutMs: 5_000,
    });

    expect(inspected?.inspection.reveal.associationProof).toBe('active_descendant');
    expect(inspected?.inspection.options.map(({ name }) => name)).toContain('United States');
    expect(inspected?.inspection.options.map(({ name }) => name)).not.toContain('Unrelated visible choice');
  });

  it('types once and commits once when the focused control proves one exact active option', async () => {
    await openSearchableCountry(true);

    const result = await controller?.selectOption(selectionInput());

    expect(result).toMatchObject({
      interactionUsed: 'searchable_keyboard',
      selectionSucceeded: true,
      selectedName: 'United States',
      currentState: { popupOpen: false, multiple: false },
      evidence: {
        searchableCommit: {
          activeOptionProof: 'aria_activedescendant',
          queryActionDispatched: true,
          commitActionDispatched: true,
          selectionProof: 'value_and_popup_closed',
        },
      },
    });
    const page = (controller as unknown as { activePage: { locator: (selector: string) => {
      textContent: () => Promise<string | null>;
    } } }).activePage;
    expect(await page.locator('#counts').textContent()).toContain('inputs:1 enters:1 submits:0 selected:1');
  });

  it('returns an already-selected exact value without typing or pressing Enter', async () => {
    await openSearchableCountry(true, true);

    const result = await controller?.selectOption(selectionInput());

    expect(result).toMatchObject({
      interactionUsed: 'searchable_keyboard',
      selectionSucceeded: true,
      actionDispatched: false,
      selectedName: 'United States',
      evidence: {
        searchableCommit: {
          activeOptionProof: null,
          queryActionDispatched: false,
          commitActionDispatched: false,
          selectionProof: 'value_and_popup_closed',
        },
      },
    });
    const page = (controller as unknown as { activePage: { locator: (selector: string) => {
      textContent: () => Promise<string | null>;
    } } }).activePage;
    expect(await page.locator('#counts').textContent()).toContain('inputs:0 enters:0 submits:0 selected:0');
  });

  it('stops after the query and never presses Enter without exact active-option proof', async () => {
    await openSearchableCountry(false);

    await expect(controller?.selectOption({
      ...selectionInput(),
      interaction: 'type_and_enter',
    })).rejects.toMatchObject({
      details: {
        reason: 'searchable_selection_active_option_unproven',
        actionDispatched: true,
        searchableSelection: {
          queryActionDispatched: true,
          activeOptionProof: null,
          commitActionDispatched: false,
        },
      },
    });
    const page = (controller as unknown as { activePage: { locator: (selector: string) => {
      textContent: () => Promise<string | null>;
    } } }).activePage;
    expect(await page.locator('#counts').textContent()).toContain('inputs:1 enters:0 submits:0 selected:0');
  });
});
