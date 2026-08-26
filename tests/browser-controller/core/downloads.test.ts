import { mkdtemp, readFile } from 'node:fs/promises';
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

describe('BrowserController download transfer manager', () => {
  it('reconciles a click-created download and persists only sanitized metadata', async () => {
    const privateSourceFilename = 'company-secret-report.pdf';
    server = createServer((request, response) => {
      if (request.url === '/payload') {
        response.writeHead(200, {
          'content-type': 'application/pdf',
          'content-disposition': `attachment; filename="${privateSourceFilename}"`,
        });
        response.end('%PDF-1.4\nfixture\n');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><body><a href="/payload" download>Export report</a></body></html>');
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-downloads-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/downloads`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const baseline = await controller.downloads({ limit: 100 });
    const clicked = await controller.clickByRole({
      role: 'link',
      name: 'Export report',
      exact: true,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedNewPageUrl: null,
        expectedDownload: true,
        expectedSelected: null,
        expectedVisible: null,
        expectedHidden: null,
        satisfaction: 'all',
        timeoutMs: 2_000,
      },
      timeoutMs: 5_000,
    });

    expect(clicked.newDownloadCount).toBe(1);
    expect(clicked.newDownload?.sequence).toBeGreaterThan(baseline.cursor);
    await expect.poll(async () => {
      const current = await controller?.downloads({ limit: 100 });
      return current?.downloads.at(-1)?.state;
    }, { timeout: 5_000 }).toBe('completed');

    const current = await controller.downloads({ limit: 100 });
    const captured = current.downloads.at(-1);
    expect(captured).toMatchObject({
      state: 'completed',
      artifact: { extension: 'pdf' },
      failure: null,
    });
    expect(captured?.artifact.sizeBytes).toBeGreaterThan(0);
    const serialized = JSON.stringify(current);
    expect(serialized).not.toContain(privateSourceFilename);
    expect(captured?.artifact.path).not.toContain(privateSourceFilename);

    const manifest = await readFile(path.join(temporaryRoot, 'artifacts', 'downloads', 'manifest.json'), 'utf8');
    expect(manifest).not.toContain(privateSourceFilename);

    const restored = new BrowserController(browserConfig(temporaryRoot));
    const restoredDownloads = await restored.downloads({ limit: 100 });
    expect(restoredDownloads.downloads.at(-1)).toEqual(captured);
  });
});
