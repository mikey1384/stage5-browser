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
          <a id="leave" href="/elsewhere">Leave upload</a>
          <script>
            document.querySelector('#leave').addEventListener('click', (event) => {
              event.preventDefault();
              history.pushState({}, '', '/elsewhere');
              document.body.innerHTML = '<main><h1>Elsewhere</h1></main>';
            });
          </script>
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
        page: {
          stateRisk: {
            kind: 'possible_unsaved_file_selections',
            fileCount: 1,
            acknowledgementRequired: true,
          },
        },
        warnings: [expect.objectContaining({ code: 'workflow_persistence_unverified' })],
      },
    });
    expect(JSON.stringify(selected.structuredContent)).not.toContain(temporaryRoot);

    const navigationSnapshot = await client.callTool({
      name: 'browser_snapshot',
      arguments: { depth: 8, boxes: false, frameId: null, timeoutMs: 10_000 },
    });
    expect(navigationSnapshot.isError).not.toBe(true);
    const navigationResult = (navigationSnapshot.structuredContent as {
      result?: { snapshotId?: unknown; snapshot?: unknown };
    } | undefined)?.result;
    const navigationSnapshotId = navigationResult?.snapshotId;
    const navigationText = navigationResult?.snapshot;
    const navigationRef = typeof navigationText === 'string'
      ? navigationText.match(/link "Leave upload" \[ref=([^\]]+)\]/u)?.[1]
      : undefined;
    if (typeof navigationSnapshotId !== 'string' || typeof navigationRef !== 'string') {
      throw new Error('MCP snapshot did not expose the disposable navigation target.');
    }

    const blocked = await client.callTool({
      name: 'browser_click_ref',
      arguments: {
        snapshotId: navigationSnapshotId,
        ref: navigationRef,
        frameId: null,
        postcondition: null,
        timeoutMs: 10_000,
        intent: 'navigate',
        acknowledgeStateRisk: false,
      },
    });
    expect(blocked.isError).toBe(true);
    const blockedOperationId = (blocked.structuredContent as { operationId?: unknown }).operationId;
    if (typeof blockedOperationId !== 'string') throw new Error('Blocked navigation omitted its operationId.');
    expect(blocked.structuredContent).toMatchObject({
      operationId: blockedOperationId,
      error: {
        code: 'OPERATION_FAILED',
        details: {
          reason: 'unsaved_file_selection_navigation_requires_acknowledgement',
          actionDispatched: false,
          clickDispatched: false,
          stateRisk: {
            kind: 'possible_unsaved_file_selections',
            fileCount: 1,
            acknowledgementRequired: true,
          },
        },
      },
    });

    const acknowledgedSnapshot = await client.callTool({
      name: 'browser_snapshot',
      arguments: { depth: 8, boxes: false, frameId: null, timeoutMs: 10_000 },
    });
    const acknowledgedResult = (acknowledgedSnapshot.structuredContent as {
      result?: { snapshotId?: unknown; snapshot?: unknown };
    } | undefined)?.result;
    const acknowledgedSnapshotId = acknowledgedResult?.snapshotId;
    const acknowledgedText = acknowledgedResult?.snapshot;
    const acknowledgedRef = typeof acknowledgedText === 'string'
      ? acknowledgedText.match(/link "Leave upload" \[ref=([^\]]+)\]/u)?.[1]
      : undefined;
    if (typeof acknowledgedSnapshotId !== 'string' || typeof acknowledgedRef !== 'string') {
      throw new Error('Fresh MCP snapshot did not expose the disposable navigation target.');
    }

    const acknowledged = await client.callTool({
      name: 'browser_click_ref',
      arguments: {
        snapshotId: acknowledgedSnapshotId,
        ref: acknowledgedRef,
        frameId: null,
        postcondition: {
          expectedUrl: { url: `http://127.0.0.1:${port}/elsewhere`, match: 'exact' },
          expectedNewPageUrl: null,
          expectedDownload: false,
          expectedSelected: null,
          expectedVisible: null,
          expectedHidden: null,
          satisfaction: 'all',
          timeoutMs: 2_000,
        },
        timeoutMs: 10_000,
        intent: 'navigate',
        acknowledgeStateRisk: true,
      },
    });
    expect(acknowledged.isError).not.toBe(true);
    const acknowledgedOperationId = (acknowledged.structuredContent as { operationId?: unknown }).operationId;
    if (typeof acknowledgedOperationId !== 'string') throw new Error('Acknowledged navigation omitted its operationId.');
    expect(acknowledged.structuredContent).toMatchObject({
      operationId: acknowledgedOperationId,
      result: {
        actionDispatched: true,
        clickDispatched: true,
        effectConfirmed: true,
        stateRisk: {
          kind: 'possible_unsaved_file_selections',
          fileCount: 1,
          acknowledgementRequired: false,
        },
      },
    });

    for (const [operationId, acknowledgedRisk] of [
      [blockedOperationId, false],
      [acknowledgedOperationId, true],
    ] as const) {
      const telemetry = await client.callTool({
        name: 'browser_execution_traces',
        arguments: { operationId, limit: 5, detail: 'full' },
      });
      expect(telemetry.structuredContent).toMatchObject({
        traces: [{
          operationId,
          declaredIntent: 'navigate',
          stateRiskAcknowledgementRequested: acknowledgedRisk,
          conclusion: {
            unsavedStateRisk: 'possible_unsaved_file_selections',
            stateRiskAcknowledged: acknowledgedRisk,
          },
        }],
      });
    }
  });
});
