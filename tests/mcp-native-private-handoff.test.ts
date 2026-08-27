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
  if (client !== undefined) {
    await client.callTool({
      name: 'browser_resume_after_login',
      arguments: { expected: null, timeoutMs: 1_000 },
    }).catch(() => undefined);
    await client.close().catch(() => undefined);
  }
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  client = undefined;
  root = undefined;
});

describe('fresh MCP host private-handoff telemetry', () => {
  it('journals only the categorical same-process release transition', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-mcp-handoff-trace-'));
    client = new Client({ name: 'mcp-handoff-trace-test', version: STAGE5_BROWSER_VERSION });
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
        STAGE5_BROWSER_TEST_HANDOFF_RELEASE_TELEMETRY: '1',
        STAGE5_LOUNGE_DIR: path.join(root, 'lounge'),
      },
    }));
    expect((await client.callTool({
      name: 'lounge_join',
      arguments: {
        agentId: 'mcp-handoff-trace-test',
        displayName: 'MCP Handoff Trace Test',
        provider: 'test',
        room: 'stage5-lounge',
      },
    })).isError).not.toBe(true);

    const reservation = await client.callTool({
      name: 'browser_reserve_operation',
      arguments: { command: 'requestLoginHandoff' },
    });
    const operationId = (reservation.structuredContent as { operationId?: unknown }).operationId;
    if (typeof operationId !== 'string') throw new Error('Handoff reservation omitted its operationId.');
    const handoff = await client.callTool({
      name: 'browser_request_login_handoff',
      arguments: { operationId, url: null, timeoutMs: 1_000 },
    });
    expect(handoff.isError).not.toBe(true);
    expect(handoff.structuredContent).toMatchObject({
      operationId,
      result: {
        state: 'awaiting_user',
        handoffRelease: {
          strategy: 'native_same_process',
          phase: 'human_input',
          closeRequestCompleted: true,
          processReused: true,
          ownershipRetained: true,
        },
      },
    });

    const telemetry = await client.callTool({
      name: 'browser_execution_traces',
      arguments: { operationId, limit: 10, detail: 'full' },
    });
    expect(telemetry.structuredContent).toMatchObject({
      traces: [
        {
          schemaVersion: 2,
          operationId,
          host: {
            version: STAGE5_BROWSER_VERSION,
            behaviorVersion: MCP_HOST_BEHAVIOR_VERSION,
          },
          outcome: 'succeeded',
          conclusion: {
            handoffRelease: {
              strategy: 'native_same_process',
              phase: 'human_input',
              closeRequestCompleted: true,
              processReused: true,
              ownershipRetained: true,
            },
          },
          privacy: {
            urls: 'omitted',
            selectors: 'omitted',
            names: 'omitted',
            values: 'omitted',
            pageContent: 'omitted',
          },
        },
      ],
    });
    const serialized = JSON.stringify(telemetry.structuredContent);
    expect(serialized).not.toContain('private.invalid');
    expect(serialized).not.toContain('never retain this value');
  });
});
