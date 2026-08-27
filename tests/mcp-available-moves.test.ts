import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';

import { STAGE5_BROWSER_VERSION } from '../src/runtime-info.js';

let client: Client | undefined;
let temporaryRoot: string | undefined;

afterEach(async () => {
  await client?.callTool({ name: 'browser_stop', arguments: {} }).catch(() => undefined);
  await client?.close().catch(() => undefined);
  client = undefined;
  if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

describe('MCP browser available moves', () => {
  it('maps canonical worker techniques to public tools without exposing page semantics', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-mcp-moves-'));
    client = new Client({ name: 'stage5-browser-moves-test', version: STAGE5_BROWSER_VERSION });
    const projectRoot = path.resolve('.');
    await client.connect(new StdioClientTransport({
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
      },
    }));
    await client.callTool({
      name: 'lounge_join',
      arguments: { agentId: 'moves-test', displayName: 'Moves Test', provider: 'test', room: 'stage5-lounge' },
    });

    const tools = await client.listTools();
    expect(tools.tools.find(({ name }) => name === 'browser_available_moves')?.inputSchema).toMatchObject({
      properties: {
        includeBlocked: expect.any(Object),
        manager: expect.any(Object),
        availability: expect.any(Object),
        maxMoves: expect.any(Object),
      },
    });

    const stoppedOpen = await client.callTool({
      name: 'browser_open',
      arguments: {
        url: 'https://example.invalid/',
        newTab: false,
        stabilizationMs: 0,
        timeoutMs: 2_000,
      },
    });
    expect(stoppedOpen.isError).toBe(true);
    expect(stoppedOpen.structuredContent).toMatchObject({
      error: { code: 'BROWSER_NOT_READY', details: { reason: 'browser_stopped', actionDispatched: false } },
    });
    const statusAfterBlockedOpen = await client.callTool({ name: 'browser_status', arguments: {} });
    expect(statusAfterBlockedOpen.structuredContent).toMatchObject({
      result: { state: 'stopped', browserConnected: false, pages: [] },
    });

    const response = await client.callTool({
      name: 'browser_available_moves',
      arguments: { includeBlocked: true, maxMoves: 24 },
    });
    expect(response.isError).not.toBe(true);
    const structured = response.structuredContent as {
      operationId?: string;
      result?: { moves?: Array<Record<string, unknown>>; context?: Record<string, unknown> };
    };
    const moves = structured.result?.moves ?? [];
    expect(moves.find(({ moveId }) => moveId === 'start:start_profile')).toMatchObject({
      availability: 'available',
      manager: 'lifecycle_manager',
      tools: ['browser_start'],
      enablingTools: [],
    });
    expect(moves.find(({ moveId }) => moveId === 'open:open_url')).toMatchObject({
      availability: 'needs_preparation',
      tools: ['browser_open'],
      enablingTools: ['browser_available', 'browser_start'],
    });
    expect(moves.every((move) => !('command' in move) && !('enablingCommands' in move))).toBe(true);
    expect(JSON.stringify(structured.result)).not.toMatch(/https?:|selector|accessibleName|fieldValue/u);

    expect(typeof structured.operationId).toBe('string');
    const telemetry = await client.callTool({
      name: 'browser_execution_traces',
      arguments: { operationId: structured.operationId, limit: 10, detail: 'full' },
    });
    expect(telemetry.structuredContent).toMatchObject({
      traces: [{
        command: 'availableMoves',
        manager: 'planning_manager',
        phaseSystem: 'read_only_observation',
        dispatchBoundary: 'none',
        replayPolicy: 'idempotent_observation',
        conclusion: { actionDispatched: null },
      }],
    });
  });
});
