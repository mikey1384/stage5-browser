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
  await client?.close().catch(() => undefined);
  client = undefined;
  if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

describe('MCP terminal response delivery', () => {
  it('returns a reserved action deadline through stdio promptly and makes the terminal result queryable without replay', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-mcp-deadline-'));
    client = new Client({ name: 'stage5-browser-deadline-test', version: STAGE5_BROWSER_VERSION });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('tests/fixtures/mcp-deadline-server.mjs')],
      cwd: path.resolve('.'),
      stderr: 'pipe',
      env: {
        ...getDefaultEnvironment(),
        STAGE5_BROWSER_ARTIFACTS_DIR: path.join(temporaryRoot, 'artifacts'),
        STAGE5_BROWSER_PROFILE_DIR: path.join(temporaryRoot, 'profile'),
        STAGE5_BROWSER_PROFILES_DIR: path.join(temporaryRoot, 'profiles'),
        STAGE5_BROWSER_OPERATION_TIMEOUT_MS: '1000',
        STAGE5_BROWSER_TEST_HANG_COMMAND: 'clickByRole',
        STAGE5_LOUNGE_DIR: path.join(temporaryRoot, 'lounge'),
      },
    });
    await client.connect(transport);

    const reservation = await client.callTool({
      name: 'browser_reserve_operation',
      arguments: { command: 'clickByRole' },
    });
    expect(reservation.isError).not.toBe(true);
    const operationId = (reservation.structuredContent as { operationId?: unknown }).operationId;
    if (typeof operationId !== 'string') throw new Error('The action reservation omitted its operationId.');

    const startedAt = performance.now();
    const failed = await client.callTool({
      name: 'browser_click_by_role',
      arguments: {
        operationId,
        role: 'button',
        name: 'Disposable action target',
        exact: true,
        frameId: null,
        postcondition: null,
        timeoutMs: 1_000,
        intent: 'local_validation',
        dialogResponse: null,
      },
    });
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeLessThan(5_000);
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({
      error: { code: 'OPERATION_TIMEOUT' },
      operationId,
      recovery: 'succeeded',
    });

    const recovered = await client.callTool({
      name: 'browser_operation_status',
      arguments: { operationId, includeResult: true },
    });
    expect(recovered.isError).not.toBe(true);
    expect(recovered.structuredContent).toMatchObject({
      found: true,
      operation: {
        operationId,
        command: 'clickByRole',
        phase: 'response_created',
        terminal: true,
        outcome: 'timed_out',
        recovery: 'succeeded',
        timing: {
          terminalAtMs: expect.any(Number),
          persistedAtMs: expect.any(Number),
          responseCreatedAtMs: expect.any(Number),
        },
      },
    });

    const traces = await client.callTool({
      name: 'browser_execution_traces',
      arguments: { operationId, limit: 10 },
    });
    expect(traces.isError).not.toBe(true);
    expect(traces.structuredContent).toMatchObject({
      operationId,
      traces: [{
        operationId,
        command: 'clickByRole',
        outcome: 'timed_out',
        actions: [{
          action: 'click_by_role',
          dispatchState: 'possibly_dispatched',
          terminalOutcome: null,
          phases: expect.arrayContaining([
            expect.objectContaining({ phase: 'dispatch', attempt: 1 }),
          ]),
        }],
        conclusion: { actionDispatched: 'unknown' },
      }],
    });
  }, 15_000);
});
