import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserController } from '../../../src/browser-controller.js';
import type { SanitizedNativeWindowActivationEvidence, SanitizedPageActivationEvidence } from '../../../src/page-diagnostics.js';
import { browserConfig, cleanBrowserControllerTestState, listen } from '../../browser-controller-fixture.js';

describe('BrowserController duplicate semantic ref capabilities', () => {
  let controller: BrowserController | undefined;
  let server: Server | undefined;
  let temporaryRoot: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanBrowserControllerTestState({ controller, server, temporaryRoot });
    controller = undefined;
    server = undefined;
    temporaryRoot = undefined;
  });

  async function openRows(owner: 'article' | 'row' = 'article'): Promise<{ page: Page; ref: string; snapshotId: string }> {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><body>
        ${owner === 'article'
          ? `<article><h2>First credential</h2><button id="first">Row actions</button></article>
             <article><h2>Second credential</h2><button id="second">Row actions</button></article>`
          : `<table><tbody>
               <tr><th>First credential</th><td><button id="first">Row actions</button></td></tr>
               <tr><th>Second credential</th><td><button id="second">Row actions</button></td></tr>
             </tbody></table>`}
        <output id="clicks">none</output><output id="hovers">none</output>
        <script>
          first.addEventListener('click', () => { clicks.value = 'first'; });
          second.addEventListener('click', () => { clicks.value = 'second'; });
          first.addEventListener('pointerover', () => { hovers.value = 'first'; });
          second.addEventListener('pointerover', () => { hovers.value = 'second'; });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-duplicate-ref-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/rows`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({ depth: 8, boxes: false, frameId: null, timeoutMs: 2_000 });
    const refs = [...observed.snapshot.matchAll(/button "Row actions"[^\n]*\[ref=([^\]]+)\]/gu)]
      .map((match) => match[1])
      .filter((ref): ref is string => ref !== undefined);
    expect(refs).toHaveLength(2);
    const ref = refs[1];
    if (ref === undefined) throw new Error('Duplicate-row fixture did not expose its second action ref.');
    const page = (controller as unknown as { activePage: Page }).activePage;
    vi.spyOn(
      controller as unknown as { semanticForExactReference: (...args: unknown[]) => Promise<null> },
      'semanticForExactReference',
    ).mockResolvedValue(null);
    return { page, ref, snapshotId: observed.snapshotId };
  }

  it('clicks the exact still-connected row node without falling back to global duplicate semantics', async () => {
    const { page, ref, snapshotId } = await openRows();
    await expect(controller?.clickRef({
      snapshotId,
      ref,
      frameId: null,
      postcondition: null,
      timeoutMs: 3_000,
    })).resolves.toMatchObject({ dispatch: { actionDispatched: true, clickDispatched: true } });
    await expect(page.locator('#clicks').textContent()).resolves.toBe('second');
  });

  it('hovers the exact still-connected row node through the same retained capability', async () => {
    const { page, ref, snapshotId } = await openRows();
    await expect(controller?.motion({
      motion: { kind: 'hover', target: { kind: 'ref', snapshotId, ref } },
      frameId: null,
      postcondition: null,
      timeoutMs: 3_000,
    })).resolves.toMatchObject({ dispatch: { actionDispatched: true, hoverObserved: true } });
    await expect(page.locator('#hovers').textContent()).resolves.toBe('second');
  });

  it('rebinds a replaced duplicate action only inside its observed table row', async () => {
    const { page, ref, snapshotId } = await openRows('row');
    vi.restoreAllMocks();
    const internals = controller as unknown as {
      activateSelectedPageForInput: (
        page: Page,
        attemptCount: number,
        prior?: SanitizedNativeWindowActivationEvidence,
      ) => Promise<SanitizedPageActivationEvidence>;
    };
    const originalActivation = internals.activateSelectedPageForInput.bind(controller);
    vi.spyOn(internals, 'activateSelectedPageForInput').mockImplementation(async (...args) => {
      await page.locator('#second').evaluate((button) => {
        const replacement = button.cloneNode(true);
        replacement.addEventListener('click', () => {
          const output = document.querySelector<HTMLOutputElement>('#clicks');
          if (output !== null) output.value = 'second';
        });
        button.replaceWith(replacement);
      });
      return originalActivation(...args);
    });

    await expect(controller?.clickRef({
      snapshotId,
      ref,
      frameId: null,
      postcondition: null,
      timeoutMs: 3_000,
    })).resolves.toMatchObject({ dispatch: { actionDispatched: true, clickDispatched: true } });
    await expect(page.locator('#clicks').textContent()).resolves.toBe('second');
  });
});
