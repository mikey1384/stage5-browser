import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';

import { STAGE5_BROWSER_VERSION } from '../src/runtime-info.js';

let server: Server | undefined;
let client: Client | undefined;
let temporaryRoot: string | undefined;

async function listen(candidate: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    candidate.once('error', onError);
    candidate.listen(0, '127.0.0.1', () => {
      candidate.off('error', onError);
      resolve();
    });
  });
  const address = candidate.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Upload fixture did not bind to TCP.');
  }
  return address.port;
}

afterEach(async () => {
  if (client !== undefined) {
    await client.callTool({ name: 'browser_stop', arguments: {} }).catch(() => undefined);
    await client.close().catch(() => undefined);
    client = undefined;
  }
  if (server?.listening === true) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
  server = undefined;
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

describe('MCP file selection', () => {
  it('carries a fresh hidden-input capability through MCP, supervisor, worker, and browser', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>MCP upload</title></head><body>
        <div role="dialog" aria-modal="true" aria-label="Composer">
          <input id="media" type="file" accept="video/mp4" hidden>
          <script>
            document.addEventListener('input', (event) => {
              const input = event.target;
              if (!(input instanceof HTMLInputElement) || input.id !== 'media' || input.files.length === 0) return;
              document.querySelector('#name').textContent = input.files[0].name;
              document.querySelector('#ready').hidden = false;
              input.value = '';
            }, { capture: true });
          </script>
          <p id="name"></p>
          <button id="ready" hidden>Ready to post</button>
        </div>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-mcp-upload-'));
    const videoPath = path.join(temporaryRoot, 'mcp-upload.mp4');
    await writeFile(videoPath, Buffer.alloc(2_048, 5));

    client = new Client({ name: 'stage5-browser-upload-test', version: STAGE5_BROWSER_VERSION });
    const projectRoot = path.resolve('.');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(projectRoot, 'dist', 'launcher.js')],
      cwd: projectRoot,
      stderr: 'pipe',
      env: {
        ...getDefaultEnvironment(),
        PLAYWRIGHT_BROWSERS_PATH: path.join(projectRoot, '.playwright-browsers'),
        STAGE5_BROWSER_PROFILES_DIR: path.join(temporaryRoot, 'profiles'),
        STAGE5_BROWSER_PROFILE_DIR: path.join(temporaryRoot, 'profile'),
        STAGE5_BROWSER_ARTIFACTS_DIR: path.join(temporaryRoot, 'artifacts'),
        STAGE5_BROWSER_HEADLESS: '1',
        STAGE5_BROWSER_OPERATION_TIMEOUT_MS: '10000',
        STAGE5_BROWSER_NAVIGATION_TIMEOUT_MS: '10000',
      },
    });
    await client.connect(transport);

    const started = await client.callTool({ name: 'browser_start', arguments: { browser: 'chromium' } });
    expect(started.isError).not.toBe(true);

    const opened = await client.callTool({
      name: 'browser_open',
      arguments: {
        url: `http://127.0.0.1:${port}/composer`,
        newTab: false,
        stabilizationMs: 0,
        timeoutMs: 10_000,
      },
    });
    expect(opened.isError).not.toBe(true);
    const snapshot = await client.callTool({
      name: 'browser_snapshot',
      arguments: { depth: 8, boxes: false, frameId: null, timeoutMs: 10_000 },
    });
    expect(snapshot.isError).not.toBe(true);
    const snapshotResult = (snapshot.structuredContent as {
      result?: { snapshotId?: unknown; fileInputs?: Array<{ ref?: unknown }> };
    } | undefined)?.result;
    const snapshotId = snapshotResult?.snapshotId;
    const ref = snapshotResult?.fileInputs?.[0]?.ref;
    expect(typeof snapshotId).toBe('string');
    expect(typeof ref).toBe('string');
    if (typeof snapshotId !== 'string' || typeof ref !== 'string') {
      throw new Error('MCP snapshot did not expose the hidden file-input capability.');
    }

    const selected = await client.callTool({
      name: 'browser_set_input_files',
      arguments: {
        snapshotId,
        ref,
        paths: [videoPath],
        frameId: null,
        completion: {
          expectedComplete: {
            role: 'button',
            name: 'Ready to post',
            exact: true,
            frameId: null,
          },
          expectedError: null,
          timeoutMs: 2_000,
        },
        observationMs: 100,
        previewDepth: 8,
        timeoutMs: 10_000,
      },
    });
    expect(selected.isError).not.toBe(true);
    expect(selected.structuredContent).toMatchObject({
      result: {
        selection: {
          dispatched: true,
          confirmedByInput: true,
          files: [{ name: 'mcp-upload.mp4', sizeBytes: 2_048 }],
        },
        attachmentPreview: { available: true },
        processing: {
          state: 'completion_observed',
          evidence: 'expected_completion_visible',
        },
      },
    });
    expect(JSON.stringify(selected.structuredContent)).not.toContain(temporaryRoot);
  });
});
