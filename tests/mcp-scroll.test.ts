import { mkdtemp, rm } from 'node:fs/promises';
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
    throw new Error('Scroll fixture did not bind to TCP.');
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

describe('MCP nested scrolling', () => {
  it('carries a snapshot-bound container and semantic content wait through the worker boundary', async () => {
    server = createServer((request, response) => {
      if (request.url === '/feed') {
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>MCP nested feed</title><style>
        body { margin: 0; overflow: hidden; }
        #feed { height: 160px; overflow-y: auto; }
        #spacer { height: 600px; }
        #funding, #covered, #funding-options { position: fixed; left: 320px; width: 200px; box-sizing: border-box; }
        #funding, #covered { height: 40px; }
        #funding { top: 20px; }
        #funding-options { top: 60px; height: 160px; z-index: 2; border: 1px solid black; }
        #covered { top: 100px; }
      </style></head><body>
        <button id="mode" aria-pressed="false" onclick="this.setAttribute('aria-pressed', 'true')">Enable mode</button>
        <button id="funding">Funding source</button>
        <div id="funding-options"><div role="option">Company capital</div></div>
        <button id="covered">Covered sibling</button>
        <section id="feed" role="feed" aria-label="Other posts">
          <article>Initial post</article><div id="spacer"></div>
        </section>
        <script>
          let loaded = false;
          const feed = document.querySelector('#feed');
          feed.addEventListener('scroll', () => {
            if (loaded) return;
            loaded = true;
            const loader = document.createElement('div');
            loader.setAttribute('role', 'progressbar');
            feed.append(loader);
            fetch('/feed').then(() => {
              const article = document.createElement('article');
              article.textContent = 'Loaded post';
              feed.append(article);
              loader.remove();
            });
          });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-mcp-scroll-'));

    client = new Client({ name: 'stage5-browser-scroll-test', version: STAGE5_BROWSER_VERSION });
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
        STAGE5_LOUNGE_DIR: path.join(temporaryRoot, 'lounge'),
        STAGE5_BROWSER_HEADLESS: '1',
        STAGE5_BROWSER_OPERATION_TIMEOUT_MS: '10000',
        STAGE5_BROWSER_NAVIGATION_TIMEOUT_MS: '10000',
      },
    });
    await client.connect(transport);
    const joined = await client.callTool({
      name: 'lounge_join',
      arguments: {
        agentId: 'mcp-scroll-test',
        displayName: 'MCP Scroll Test',
        provider: 'test',
        room: 'stage5-lounge',
      },
    });
    expect(joined.isError).not.toBe(true);

    const tools = await client.listTools();
    const scrollTool = tools.tools.find((tool) => tool.name === 'browser_scroll');
    expect(scrollTool?.inputSchema).toMatchObject({
      properties: {
        target: expect.any(Object),
        waitFor: expect.any(Object),
      },
    });
    expect(tools.tools.find((tool) => tool.name === 'browser_execution_traces')?.inputSchema)
      .toMatchObject({ properties: { operationId: expect.any(Object), limit: expect.any(Object) } });
    for (const name of ['browser_click_by_role', 'browser_click_ref']) {
      const clickTool = tools.tools.find((tool) => tool.name === name);
      expect(clickTool, `${name} should be exposed`).toBeDefined();
      expect(JSON.stringify(clickTool?.inputSchema)).toContain('"expectedHidden"');
    }

    const opened = await client.callTool({
      name: 'browser_open',
      arguments: {
        url: `http://127.0.0.1:${port}/nested`,
        newTab: false,
        stabilizationMs: 0,
        timeoutMs: 10_000,
      },
    });
    expect(opened.isError).not.toBe(true);
    const inspected = await client.callTool({
      name: 'browser_inspect_control',
      arguments: {
        control: { role: 'button', name: 'Funding source', exact: true },
        frameId: null,
        revealOptions: false,
        maxOptions: 20,
        timeoutMs: 10_000,
      },
    });
    expect(inspected.isError).not.toBe(true);
    expect(inspected.structuredContent).toMatchObject({
      result: {
        inspection: {
          reveal: {
            popupOpened: true,
            associationProof: 'spatial',
            surfaceProof: 'positioned_option_group',
            renderedPopupCount: 1,
            popupOwnership: {
              proofTier: 'spatial',
              decision: 'covered_siblings_excluded',
            },
          },
        },
      },
    });
    const inspectOperationId = (inspected.structuredContent as { operationId?: unknown }).operationId;
    expect(typeof inspectOperationId).toBe('string');
    if (typeof inspectOperationId !== 'string') throw new Error('Control inspection did not expose its operationId.');
    const inspectTelemetry = await client.callTool({
      name: 'browser_execution_traces',
      arguments: { operationId: inspectOperationId, limit: 10 },
    });
    expect(inspectTelemetry.structuredContent).toMatchObject({
      traces: [{
        command: 'inspectControl',
        actions: [],
        conclusion: {
          popupAssociationProof: 'spatial',
          popupSurfaceProof: 'positioned_option_group',
          renderedPopupCount: 1,
          popupOwnership: {
            proofTier: 'spatial',
            decision: 'covered_siblings_excluded',
          },
        },
      }],
    });
    const snapshot = await client.callTool({
      name: 'browser_snapshot',
      arguments: { depth: 8, boxes: false, frameId: null, timeoutMs: 10_000 },
    });
    expect(snapshot.isError).not.toBe(true);
    const result = (snapshot.structuredContent as {
      result?: { snapshotId?: unknown; scrollContainers?: Array<{ ref?: unknown }> };
    } | undefined)?.result;
    const snapshotId = result?.snapshotId;
    const ref = result?.scrollContainers?.[0]?.ref;
    expect(typeof snapshotId).toBe('string');
    expect(typeof ref).toBe('string');
    if (typeof snapshotId !== 'string' || typeof ref !== 'string') {
      throw new Error('MCP snapshot did not expose a nested scroll-container capability.');
    }

    const scrolled = await client.callTool({
      name: 'browser_scroll',
      arguments: {
        direction: 'down',
        amount: 'viewport',
        count: 1,
        settleMs: 0,
        frameId: null,
        endMarker: null,
        target: { snapshotId, ref },
        waitFor: { condition: 'either', timeoutMs: 2_000 },
        timeoutMs: 10_000,
      },
    });
    expect(scrolled.isError).not.toBe(true);
    expect(scrolled.structuredContent).toMatchObject({
      result: {
        target: { kind: 'container', ref },
        moved: true,
        wait: {
          requested: true,
          satisfied: true,
          evidence: 'article_count_growth',
        },
      },
    });
    const operationId = (scrolled.structuredContent as { operationId?: unknown }).operationId;
    expect(typeof operationId).toBe('string');
    if (typeof operationId !== 'string') throw new Error('Scroll result did not expose its operationId.');
    const telemetry = await client.callTool({
      name: 'browser_execution_traces',
      arguments: { operationId, limit: 10 },
    });
    expect(telemetry.isError).not.toBe(true);
    expect(telemetry.structuredContent).toMatchObject({
      operationId,
      traces: [{
        operationId,
        agentId: 'mcp-scroll-test',
        command: 'scroll',
        manager: 'interaction_manager',
        phaseSystem: 'bounded_reversible_loop',
        dispatchBoundary: 'reversible_view_state',
        privacy: { urls: 'omitted', selectors: 'omitted', names: 'omitted', values: 'omitted', pageContent: 'omitted' },
      }],
    });
    expect(JSON.stringify(telemetry.structuredContent)).not.toContain(`127.0.0.1:${port}`);

    const clicked = await client.callTool({
      name: 'browser_click_by_role',
      arguments: {
        role: 'button', name: 'Enable mode', exact: true, frameId: null,
        postcondition: {
          expectedUrl: null, expectedNewPageUrl: null, expectedDownload: false,
          expectedSelected: true, expectedVisible: null, expectedHidden: null,
          satisfaction: 'all', timeoutMs: 2_000,
        },
        timeoutMs: 10_000,
      },
    });
    expect(clicked.isError).not.toBe(true);
    const clickOperationId = (clicked.structuredContent as { operationId?: unknown }).operationId;
    if (typeof clickOperationId !== 'string') throw new Error('Click result did not expose its operationId.');
    const clickTelemetry = await client.callTool({
      name: 'browser_execution_traces',
      arguments: { operationId: clickOperationId, limit: 10 },
    });
    expect(clickTelemetry.structuredContent).toMatchObject({
      traces: [{
        agentId: 'mcp-scroll-test',
        command: 'clickByRole',
        actions: [{
          action: 'click_by_role',
          dispatchState: 'dispatched',
          phases: expect.arrayContaining([
            expect.objectContaining({ phase: 'observe' }),
            expect.objectContaining({ phase: 'dispatch' }),
            expect.objectContaining({ phase: 'reconcile' }),
          ]),
        }],
        conclusion: { actionDispatched: true, clickDispatched: true, postconditionPassed: true },
      }],
    });
  });
});
