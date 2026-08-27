import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';

import { MCP_HOST_BEHAVIOR_VERSION, STAGE5_BROWSER_VERSION } from '../src/runtime-info.js';

let client: Client | undefined;
let root: string | undefined;

afterEach(async () => {
  await client?.close().catch(() => undefined);
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  client = undefined;
  root = undefined;
});

describe('fresh MCP host native-reattach telemetry', () => {
  it('journals settled exact-target discovery without private target data', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-mcp-reattach-trace-'));
    client = new Client({ name: 'mcp-reattach-trace-test', version: STAGE5_BROWSER_VERSION });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('tests/fixtures/mcp-deadline-server.mjs')],
      cwd: path.resolve('.'),
      stderr: 'pipe',
      env: {
        ...getDefaultEnvironment(),
        STAGE5_BROWSER_ARTIFACTS_DIR: path.join(root, 'artifacts'),
        STAGE5_BROWSER_PROFILE_DIR: path.join(root, 'profile'),
        STAGE5_BROWSER_PROFILES_DIR: path.join(root, 'profiles'),
        STAGE5_BROWSER_TEST_NATIVE_REATTACH_TELEMETRY: '1',
        STAGE5_LOUNGE_DIR: path.join(root, 'lounge'),
      },
    }));
    expect((await client.callTool({
      name: 'lounge_join',
      arguments: {
        agentId: 'mcp-reattach-trace-test',
        displayName: 'MCP Reattach Trace Test',
        provider: 'test',
        room: 'stage5-lounge',
      },
    })).isError).not.toBe(true);

    const started = await client.callTool({
      name: 'browser_start',
      arguments: { browser: 'chromium' },
    });
    expect(started.isError).not.toBe(true);
    const operationId = (started.structuredContent as { operationId?: unknown }).operationId;
    if (typeof operationId !== 'string') throw new Error('Start result omitted its operationId.');

    const telemetry = await client.callTool({
      name: 'browser_execution_traces',
      arguments: { operationId, limit: 10 },
    });
    expect(telemetry.structuredContent).toMatchObject({
      traces: [{
        operationId,
        host: {
          version: STAGE5_BROWSER_VERSION,
          behaviorVersion: MCP_HOST_BEHAVIOR_VERSION,
        },
        conclusion: {
          nativeReattach: {
            selectedTargetRecorded: true,
            initialPageCount: 6,
            finalPageCount: 6,
            selectedTargetInitiallyObserved: false,
            selectedTargetObserved: true,
            discoveryWaitAttempted: true,
            discoveryWaitMs: 50,
            resolution: 'settled_exact',
          },
        },
      }],
    });
    const serialized = JSON.stringify(telemetry.structuredContent);
    expect(serialized).not.toContain('private.invalid');
    expect(serialized).not.toContain('never-retain-target-id');
  });
});
