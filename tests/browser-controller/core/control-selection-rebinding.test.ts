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

async function inspectFundingControl(): Promise<{
  controller: BrowserController;
  inspectionId: string;
  optionId: string;
  page: Page;
}> {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><body>
      <section id="funding-field">
        <div id="selected-values"></div>
        <button id="funding" aria-haspopup="listbox" aria-controls="funding-options" aria-expanded="false">
          Funding source
        </button>
      </section>
      <div id="funding-options" role="listbox" aria-label="Funding source choices" aria-multiselectable="true" hidden>
        <div id="company-funds" role="option">Proprietary funds</div>
      </div>
      <output id="opener-clicks">0</output>
      <output id="option-clicks">0</output>
      <script>
        funding.addEventListener('click', () => {
          const openerCount = document.querySelector('#opener-clicks');
          openerCount.value = String(Number(openerCount.value) + 1);
          funding.setAttribute('aria-expanded', 'true');
          document.querySelector('#funding-options').hidden = false;
        });
        document.addEventListener('click', (event) => {
          if (event.target.id !== 'company-funds') return;
          const optionCount = document.querySelector('#option-clicks');
          optionCount.value = String(Number(optionCount.value) + 1);
          document.querySelector('#selected-values').innerHTML = '<span class="chip">Proprietary funds</span>';
        });
      </script>
    </body></html>`);
  });
  const port = await listen(server);
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-selection-rebinding-'));
  controller = new BrowserController(browserConfig(temporaryRoot));
  await controller.open({
    url: `http://127.0.0.1:${port}/form`,
    newTab: false,
    stabilizationMs: 0,
    timeoutMs: 5_000,
  });
  const inspected = await controller.inspectControl({
    control: { role: 'button', name: 'Funding source', exact: true },
    frameId: null,
    revealOptions: true,
    maxOptions: 20,
    timeoutMs: 5_000,
  });
  const optionId = inspected.inspection.options[0]?.optionId;
  if (optionId === undefined) throw new Error('The rebind fixture exposed no exact option.');
  controller.drainActionPhaseTelemetry();
  const page = (controller as unknown as { activePage: Page }).activePage;
  return { controller, inspectionId: inspected.inspection.inspectionId, optionId, page };
}

async function selectFunding(
  fixture: Awaited<ReturnType<typeof inspectFundingControl>>,
  timeoutMs = 5_000,
) {
  return fixture.controller.selectOption({
    inspectionId: fixture.inspectionId,
    optionId: fixture.optionId,
    control: null,
    option: null,
    frameId: null,
    timeoutMs,
  });
}

describe('BrowserController custom selection capability rebinding', () => {
  it('read-only rebinds a framework-replaced control before one exact option dispatch', async () => {
    const fixture = await inspectFundingControl();
    await fixture.page.evaluate(() => {
      const original = document.querySelector('#funding');
      if (original === null) throw new Error('Missing disposable control.');
      original.replaceWith(original.cloneNode(true));
    });

    const selected = await selectFunding(fixture);

    expect(selected.evidence).toMatchObject({
      actionDispatched: true,
      selectedRepresentationObserved: true,
      popupClosed: false,
    });
    expect(fixture.controller.drainActionPhaseTelemetry().actionPhases).toEqual([
      expect.objectContaining({
        recovery: expect.objectContaining({ reason: 'target_changed_before_input' }),
      }),
    ]);
    expect(await fixture.page.locator('#option-clicks').textContent()).toBe('1');
  });

  it('read-only rebinds a framework-replaced popup before one exact option dispatch', async () => {
    const fixture = await inspectFundingControl();
    await fixture.page.evaluate(() => {
      const original = document.querySelector('#funding-options');
      if (original === null) throw new Error('Missing disposable popup.');
      original.replaceWith(original.cloneNode(true));
    });

    const selected = await selectFunding(fixture);

    expect(selected.evidence).toMatchObject({
      actionDispatched: true,
      selectedRepresentationObserved: true,
      popupClosed: false,
    });
    expect(fixture.controller.drainActionPhaseTelemetry().actionPhases).toEqual([
      expect.objectContaining({
        recovery: expect.objectContaining({ reason: 'target_changed_before_input' }),
      }),
    ]);
    expect(await fixture.page.locator('#option-clicks').textContent()).toBe('1');
  });

  it('waits through a bounded framework replacement gap without replaying the opener', async () => {
    const fixture = await inspectFundingControl();
    await fixture.page.evaluate(() => {
      const original = document.querySelector('#funding-options');
      if (original === null) throw new Error('Missing disposable popup.');
      const replacement = original.cloneNode(true);
      original.remove();
      setTimeout(() => document.body.append(replacement), 250);
    });

    const selected = await selectFunding(fixture);

    expect(selected.evidence).toMatchObject({
      actionDispatched: true,
      selectedRepresentationObserved: true,
      popupClosed: false,
    });
    expect(fixture.controller.drainActionPhaseTelemetry().actionPhases).toEqual([
      expect.objectContaining({
        recovery: expect.objectContaining({ reason: 'target_changed_before_input' }),
      }),
    ]);
    expect(await fixture.page.locator('#opener-clicks').textContent()).toBe('1');
    expect(await fixture.page.locator('#option-clicks').textContent()).toBe('1');
  });

  it('prefers one uniquely owned rendered replacement over a retained hidden popup', async () => {
    const fixture = await inspectFundingControl();
    await fixture.page.evaluate(() => {
      const retained = document.querySelector<HTMLElement>('#funding-options');
      if (retained === null) throw new Error('Missing disposable popup.');
      const replacement = retained.cloneNode(true) as HTMLElement;
      replacement.id = 'replacement-funding-options';
      retained.hidden = true;
      replacement.hidden = false;
      retained.after(replacement);
    });

    const selected = await selectFunding(fixture);

    expect(selected.evidence).toMatchObject({
      actionDispatched: true,
      selectedRepresentationObserved: true,
      popupClosed: false,
    });
    expect(fixture.controller.drainActionPhaseTelemetry().actionPhases).toEqual([
      expect.objectContaining({
        recovery: expect.objectContaining({ reason: 'target_changed_before_input' }),
      }),
    ]);
    expect(await fixture.page.locator('#opener-clicks').textContent()).toBe('1');
    expect(await fixture.page.locator('#option-clicks').textContent()).toBe('1');
  });

  it('does not replay the opener when a retained popup merely closed', async () => {
    const fixture = await inspectFundingControl();
    await fixture.page.evaluate(() => {
      const popup = document.querySelector<HTMLElement>('#funding-options');
      const control = document.querySelector('#funding');
      if (popup === null || control === null) throw new Error('Missing disposable control capability.');
      popup.hidden = true;
      control.setAttribute('aria-expanded', 'false');
    });

    await expect(selectFunding(fixture, 1_000)).rejects.toMatchObject({
      details: { actionDispatched: false },
    });
    expect(await fixture.page.locator('#opener-clicks').textContent()).toBe('1');
    expect(await fixture.page.locator('#option-clicks').textContent()).toBe('0');
  });
});
