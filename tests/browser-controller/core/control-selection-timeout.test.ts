import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('BrowserController custom selection baseline deadline', () => {
  it('fails with definite no-dispatch evidence when the retained control observation stalls', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><body>
        <button id="purpose" aria-haspopup="listbox" aria-controls="choices" aria-expanded="false">Use of account</button>
        <div id="choices" role="listbox" hidden>
          <div id="intended" role="option">Treasury management</div>
        </div>
        <output id="option-count">0</output>
        <script>
          purpose.addEventListener('click', () => {
            purpose.setAttribute('aria-expanded', 'true');
            choices.hidden = false;
          });
          intended.addEventListener('click', () => {
            optionCount.value = String(Number(optionCount.value) + 1);
          });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-selection-timeout-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/form`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const inspected = await controller.inspectControl({
      control: { role: 'button', name: 'Use of account', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    const intended = inspected.inspection.options[0];
    if (intended === undefined) throw new Error('The custom control fixture exposed no option.');
    const retained = (
      controller as unknown as {
        controlInspections: Map<string, { controlHandle: { evaluate: (...args: unknown[]) => Promise<unknown> } }>;
      }
    ).controlInspections.get(inspected.inspection.inspectionId);
    if (retained === undefined) throw new Error('The custom control fixture retained no inspection.');
    vi.spyOn(retained.controlHandle, 'evaluate').mockImplementation(
      () => new Promise<never>(() => undefined),
    );

    const startedAt = performance.now();
    let caught: unknown;
    try {
      await controller.selectOption({
        inspectionId: inspected.inspection.inspectionId,
        optionId: intended.optionId,
        control: null,
        option: null,
        frameId: null,
        timeoutMs: 3_000,
      });
    } catch (error) {
      caught = error;
    }

    expect(performance.now() - startedAt).toBeLessThan(1_500);
    expect(caught).toMatchObject<Partial<Stage5BrowserError>>({
      code: 'OPERATION_FAILED',
      details: {
        reason: 'control_selection_baseline_unavailable',
        actionDispatched: false,
      },
    });
    const page = (
      controller as unknown as { activePage: { locator: (selector: string) => { textContent: () => Promise<string | null> } } }
    ).activePage;
    expect(await page.locator('#option-count').textContent()).toBe('0');
  });
});
