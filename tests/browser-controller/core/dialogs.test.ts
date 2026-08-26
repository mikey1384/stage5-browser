import { mkdtemp, readFile } from 'node:fs/promises';
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
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-dialogs-'));
  controller = new BrowserController(browserConfig(temporaryRoot));
  await controller.open({
    url: `http://127.0.0.1:${port}/dialogs`,
    newTab: false,
    stabilizationMs: 0,
    timeoutMs: 5_000,
  });
}

describe('BrowserController dialog manager', () => {
  it('accepts one exact action-scoped dialog without retaining its message', async () => {
    const privateDialogMessage = 'private account-specific confirmation';
    await openFixture(`<!doctype html><html><body>
      <button id="confirm">Continue</button>
      <output role="status" aria-label="Confirmed" hidden>Confirmed</output>
      <script>document.querySelector('#confirm').addEventListener('click', () => {
        if (window.confirm(${JSON.stringify(privateDialogMessage)})) {
          document.querySelector('output').hidden = false;
        }
      });</script>
    </body></html>`);

    const result = await controller?.withDialogHandling(
      'clickByRole',
      { type: 'confirm', response: 'accept' },
      () => controller!.clickByRole({
        role: 'button',
        name: 'Continue',
        exact: true,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedNewPageUrl: null,
          expectedDownload: false,
          expectedSelected: null,
          expectedVisible: { role: 'status', name: 'Confirmed', exact: true, frameId: null },
          expectedHidden: null,
          satisfaction: 'all',
          timeoutMs: 1_000,
        },
        timeoutMs: 5_000,
      }),
    );

    expect((result as { dialog?: unknown }).dialog).toMatchObject({
      expected: true,
      observed: true,
      satisfied: true,
      dialogs: [{ type: 'confirm', response: 'accept', expected: true }],
    });
    const status = await controller?.dialogStatus({ limit: 50 });
    expect(JSON.stringify(status)).not.toContain(privateDialogMessage);
    const manifest = await readFile(path.join(temporaryRoot!, 'artifacts', 'dialogs', 'manifest.json'), 'utf8');
    expect(manifest).not.toContain(privateDialogMessage);
  });

  it('dismisses an unexpected dialog, fails closed, and never replays the trigger', async () => {
    await openFixture(`<!doctype html><html><body>
      <button id="trigger">Run once</button>
      <output role="status" aria-label="Attempts">Attempts 0</output>
      <script>let attempts = 0; document.querySelector('#trigger').addEventListener('click', () => {
        attempts += 1; document.querySelector('output').textContent = 'Attempts ' + attempts;
        window.confirm('unexpected');
      });</script>
    </body></html>`);

    let failure: unknown;
    try {
      await controller?.withDialogHandling('clickByRole', null, () => controller!.clickByRole({
        role: 'button',
        name: 'Run once',
        exact: true,
        frameId: null,
        postcondition: null,
        timeoutMs: 5_000,
      }));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Stage5BrowserError);
    expect(failure).toMatchObject({
      code: 'POSTCONDITION_FAILED',
      details: { reason: 'unexpected_dialog_dismissed', actionDispatched: 'unknown' },
    });
    const snapshot = await controller?.snapshot({ depth: 6, boxes: false, frameId: null, timeoutMs: 5_000 });
    expect(snapshot?.snapshot).toContain('Attempts 1');
    expect(snapshot?.snapshot).not.toContain('Attempts 2');
  });
});
