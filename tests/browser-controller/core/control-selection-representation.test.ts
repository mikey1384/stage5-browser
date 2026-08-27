import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { ElementHandle, Locator, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';

import { BrowserController } from '../../../src/browser-controller.js';
import { reconcileCustomControlSelection } from '../../../src/controller/controls/selection-evidence.js';
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
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-selection-representation-'));
  controller = new BrowserController(browserConfig(temporaryRoot));
  await controller.open({
    url: `http://127.0.0.1:${port}/form`,
    newTab: false,
    stabilizationMs: 0,
    timeoutMs: 5_000,
  });
}

describe('BrowserController custom selection representation', () => {
  it('accepts one newly rendered field chip while the owned popup intentionally stays open', async () => {
    await openFixture(`<!doctype html><html><body>
      <section id="funding-field">
        <div id="selected-values"></div>
        <div class="trigger-shell">
          <button id="funding" aria-haspopup="listbox" aria-controls="funding-options" aria-expanded="false">
            Funding source
          </button>
        </div>
      </section>
      <section id="unrelated-field">
        <button aria-haspopup="listbox">Different field</button>
        <span>Proprietary funds</span>
      </section>
      <div id="funding-options" role="listbox" aria-label="Funding source choices" aria-multiselectable="true" hidden>
        <div id="company-funds" role="option">Proprietary funds</div>
      </div>
      <output id="clicks">0</output>
      <script>
        funding.addEventListener('click', () => {
          funding.setAttribute('aria-expanded', 'true');
          document.querySelector('#funding-options').hidden = false;
        });
        document.querySelector('#company-funds').addEventListener('click', () => {
          clicks.value = String(Number(clicks.value) + 1);
          document.querySelector('#selected-values').innerHTML = '<span class="chip">Proprietary funds</span>';
        });
      </script>
    </body></html>`);

    const inspected = await controller?.inspectControl({
      control: { role: 'button', name: 'Funding source', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    const intended = inspected?.inspection.options[0];
    if (inspected === undefined || intended === undefined) {
      throw new Error('The disposable custom-control fixture did not expose its exact option.');
    }
    expect(inspected.inspection.multiple).toBe(true);

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
      selectedRepresentationObserved: true,
      selectedState: null,
      popupClosed: false,
    });
    const page = (
      controller as unknown as {
        activePage: {
          locator: (selector: string) => {
            textContent: () => Promise<string | null>;
          };
        };
      }
    ).activePage;
    expect(await page.locator('#clicks').textContent()).toBe('1');
  });

  it('read-only rebinds a framework-replaced control before one exact option dispatch', async () => {
    await openFixture(`<!doctype html><html><body>
      <section id="funding-field">
        <div id="selected-values"></div>
        <button id="funding" aria-haspopup="listbox" aria-controls="funding-options" aria-expanded="false">
          Funding source
        </button>
      </section>
      <div id="funding-options" role="listbox" aria-label="Funding source choices" aria-multiselectable="true" hidden>
        <div id="company-funds" role="option">Proprietary funds</div>
      </div>
      <output id="clicks">0</output>
      <script>
        funding.addEventListener('click', () => {
          funding.setAttribute('aria-expanded', 'true');
          document.querySelector('#funding-options').hidden = false;
        });
        document.querySelector('#company-funds').addEventListener('click', () => {
          clicks.value = String(Number(clicks.value) + 1);
          document.querySelector('#selected-values').innerHTML = '<span class="chip">Proprietary funds</span>';
        });
      </script>
    </body></html>`);

    const inspected = await controller?.inspectControl({
      control: { role: 'button', name: 'Funding source', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    const intended = inspected?.inspection.options[0];
    if (inspected === undefined || intended === undefined) {
      throw new Error('The replacement fixture did not expose its exact option.');
    }
    const page = (
      controller as unknown as {
        activePage: {
          evaluate: (callback: () => void) => Promise<void>;
          locator: (selector: string) => { textContent: () => Promise<string | null> };
        };
      }
    ).activePage;
    await page.evaluate(() => {
      const original = document.querySelector('#funding');
      if (original === null) throw new Error('Missing disposable control.');
      original.replaceWith(original.cloneNode(true));
    });

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
      selectedRepresentationObserved: true,
      selectedState: null,
      popupClosed: false,
    });
    expect(await page.locator('#clicks').textContent()).toBe('1');
  });

  it('finishes through the action phases without dispatch when the control already represents the option', async () => {
    await openFixture(`<!doctype html><html><body>
      <button id="funding" aria-label="Funding source" aria-haspopup="listbox" aria-controls="funding-options" aria-expanded="false">
        Proprietary funds
      </button>
      <div id="funding-options" role="listbox" aria-label="Funding source choices" hidden>
        <div id="company-funds" role="option">Proprietary funds</div>
      </div>
      <output id="clicks">0</output>
      <script>
        funding.addEventListener('click', () => {
          funding.setAttribute('aria-expanded', 'true');
          document.querySelector('#funding-options').hidden = false;
        });
        document.querySelector('#company-funds').addEventListener('click', () => {
          clicks.value = String(Number(clicks.value) + 1);
        });
      </script>
    </body></html>`);

    const inspected = await controller?.inspectControl({
      control: { role: 'button', name: 'Funding source', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    const intended = inspected?.inspection.options[0];
    if (inspected === undefined || intended === undefined || controller === undefined) {
      throw new Error('The already-represented fixture did not expose its exact option.');
    }
    controller.drainActionPhaseTelemetry();

    const selected = await controller.selectOption({
      inspectionId: inspected.inspection.inspectionId,
      optionId: intended.optionId,
      control: null,
      option: null,
      frameId: null,
      timeoutMs: 5_000,
    });

    expect(selected.evidence).toMatchObject({
      actionDispatched: false,
      selectionEffectObserved: true,
      selectedRepresentationObserved: true,
    });
    expect(controller.drainActionPhaseTelemetry().actionPhases).toEqual([
      expect.objectContaining({
        action: 'select_option',
        dispatchState: 'not_attempted',
        dispatchAttempts: 0,
        terminalOutcome: 'succeeded',
      }),
    ]);
    const page = (controller as unknown as {
      activePage: { locator: (selector: string) => { textContent: () => Promise<string | null> } };
    }).activePage;
    expect(await page.locator('#clicks').textContent()).toBe('0');
  });

  it('does not mistake a same-text change in another field for the intended selection', async () => {
    await openFixture(`<!doctype html><html><body>
      <section id="funding-field">
        <div id="selected-values"></div>
        <button id="funding" aria-haspopup="listbox" aria-controls="funding-options" aria-expanded="false">
          Funding source
        </button>
      </section>
      <section id="unrelated-field">
        <div id="unrelated-values"></div>
        <button aria-haspopup="listbox">Different field</button>
      </section>
      <div id="funding-options" role="listbox" aria-label="Funding source choices" aria-multiselectable="true" hidden>
        <div id="company-funds" role="option">Proprietary funds</div>
      </div>
      <output id="clicks">0</output>
      <script>
        funding.addEventListener('click', () => {
          funding.setAttribute('aria-expanded', 'true');
          document.querySelector('#funding-options').hidden = false;
        });
        document.querySelector('#company-funds').addEventListener('click', () => {
          clicks.value = String(Number(clicks.value) + 1);
          document.querySelector('#unrelated-values').innerHTML = '<span>Proprietary funds</span>';
        });
      </script>
    </body></html>`);

    const inspected = await controller?.inspectControl({
      control: { role: 'button', name: 'Funding source', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    const intended = inspected?.inspection.options[0];
    if (inspected === undefined || intended === undefined) {
      throw new Error('The isolation fixture did not expose its exact option.');
    }

    await expect(
      controller?.selectOption({
        inspectionId: inspected.inspection.inspectionId,
        optionId: intended.optionId,
        control: null,
        option: null,
        frameId: null,
        timeoutMs: 2_500,
      }),
    ).rejects.toMatchObject({
      code: 'POSTCONDITION_FAILED',
      details: {
        reason: 'control_option_selection_not_observed',
        actionDispatched: true,
        clickDispatched: true,
        checks: expect.arrayContaining([
          expect.objectContaining({
            kind: 'selection_representation',
            passed: false,
          }),
          expect.objectContaining({ kind: 'popup_closed', observed: false }),
        ]),
      },
    });
    const page = (
      controller as unknown as {
        activePage: {
          locator: (selector: string) => {
            textContent: () => Promise<string | null>;
          };
        };
      }
    ).activePage;
    expect(await page.locator('#clicks').textContent()).toBe('1');
  });

  it('does not treat popup closure alone as a successful multi-select choice', async () => {
    await openFixture(`<!doctype html><html><body>
      <section>
        <div id="selected-values"></div>
        <button id="funding" aria-haspopup="listbox" aria-controls="funding-options" aria-expanded="false">
          Funding source
        </button>
      </section>
      <div id="funding-options" role="listbox" aria-label="Funding source choices" aria-multiselectable="true" hidden>
        <div id="company-funds" role="option">Proprietary funds</div>
      </div>
      <output id="clicks">0</output>
      <script>
        funding.addEventListener('click', () => {
          funding.setAttribute('aria-expanded', 'true');
          document.querySelector('#funding-options').hidden = false;
        });
        document.querySelector('#company-funds').addEventListener('click', () => {
          clicks.value = String(Number(clicks.value) + 1);
          document.querySelector('#funding-options').hidden = true;
          funding.setAttribute('aria-expanded', 'false');
        });
      </script>
    </body></html>`);

    const inspected = await controller?.inspectControl({
      control: { role: 'button', name: 'Funding source', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    const intended = inspected?.inspection.options[0];
    if (inspected === undefined || intended === undefined) {
      throw new Error('The popup-closure fixture did not expose its exact option.');
    }
    expect(inspected.inspection.multiple).toBe(true);

    await expect(
      controller?.selectOption({
        inspectionId: inspected.inspection.inspectionId,
        optionId: intended.optionId,
        control: null,
        option: null,
        frameId: null,
        timeoutMs: 2_500,
      }),
    ).rejects.toMatchObject({
      code: 'POSTCONDITION_FAILED',
      details: {
        reason: 'control_option_selection_not_observed',
        actionDispatched: true,
        clickDispatched: true,
        checks: expect.arrayContaining([
          expect.objectContaining({
            kind: 'selection_representation',
            passed: false,
          }),
          expect.objectContaining({ kind: 'popup_closed', observed: true }),
        ]),
      },
    });
    const page = (
      controller as unknown as {
        activePage: {
          locator: (selector: string) => {
            textContent: () => Promise<string | null>;
          };
        };
      }
    ).activePage;
    expect(await page.locator('#clicks').textContent()).toBe('1');
  });

  it('does not manufacture popup closure when the authoritative visibility observation times out', async () => {
    const unchangedRepresentation = {
      controlRepresentsOption: false,
      localExactRepresentationCount: 0,
    };
    const control = {
      evaluate: async () => unchangedRepresentation,
    } as unknown as ElementHandle<HTMLElement>;
    const popup = {
      evaluate: () => new Promise<never>(() => undefined),
    } as unknown as ElementHandle<HTMLElement>;
    const page = {
      waitForTimeout: async (timeoutMs: number) => await new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    } as unknown as Page;

    await expect(reconcileCustomControlSelection({
      before: unchangedRepresentation,
      control,
      deadlineAt: Date.now() + 50,
      option: {} as Locator,
      optionName: 'Proprietary funds',
      owner: control,
      page,
      popup,
      requireSelected: false,
      selectedState: async () => null,
    })).rejects.toMatchObject({
      code: 'POSTCONDITION_FAILED',
      details: {
        actionDispatched: true,
        checks: expect.arrayContaining([
          expect.objectContaining({ kind: 'popup_closed', passed: false, observed: false }),
        ]),
      },
    });
  });
});
