import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';

import { STAGE5_BROWSER_VERSION } from '../src/runtime-info.js';

interface Connection {
  client: Client;
}

const connections: Connection[] = [];
let temporaryRoot: string | undefined;

afterEach(async () => {
  await Promise.all(connections.splice(0).map(async ({ client }) => client.close().catch(() => undefined)));
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

async function connect(agentName: string, managerAgentIds: string[] = []): Promise<Connection> {
  if (temporaryRoot === undefined) throw new Error('The MCP work-note fixture is not initialized.');
  const projectRoot = path.resolve('.');
  const client = new Client({ name: `work-note-${agentName}`, version: STAGE5_BROWSER_VERSION });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, 'dist', 'launcher.js')],
    cwd: projectRoot,
    stderr: 'pipe',
    env: {
      ...getDefaultEnvironment(),
      PLAYWRIGHT_BROWSERS_PATH: path.join(projectRoot, '.playwright-browsers'),
      STAGE5_LOUNGE_DIR: path.join(temporaryRoot, 'lounge'),
      STAGE5_BROWSER_PROFILES_DIR: path.join(temporaryRoot, agentName, 'profiles'),
      STAGE5_BROWSER_PROFILE_DIR: path.join(temporaryRoot, agentName, 'profile'),
      STAGE5_BROWSER_ARTIFACTS_DIR: path.join(temporaryRoot, agentName, 'artifacts'),
      STAGE5_BROWSER_HEADLESS: '1',
      ...(managerAgentIds.length === 0
        ? {}
        : { STAGE5_LOUNGE_MANAGER_AGENT_IDS: managerAgentIds.join(',') }),
    },
  }));
  const connection = { client };
  connections.push(connection);
  return connection;
}

function structured(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  return result.structuredContent as Record<string, unknown>;
}

const note = {
  role: 'Finance Agent',
  currentState: 'Frozen after one possible input.',
  lastCompleted: 'Validated the latest compatible worker.',
  blocker: 'Exact popup ownership remains unknown.',
  nextSafeAction: 'Wait for a validated release and begin passively.',
};

describe('MCP Lounge durable work-note handoff', () => {
  it('returns the note on replacement join and exposes all current notes only to managers', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-mcp-work-note-'));
    const first = await connect('finance-first');
    const manager = await connect('browser-manager', ['browser_developer']);

    const tools = await first.client.listTools();
    expect(tools.tools.find(({ name }) => name === 'lounge_set_work_note')?.inputSchema)
      .toMatchObject({
        required: ['note', 'expectedRevision', 'idempotencyKey'],
        properties: {
          note: expect.objectContaining({ type: 'object' }),
          expectedRevision: expect.objectContaining({ type: 'integer', minimum: 0 }),
        },
      });
    await expect(first.client.callTool({
      name: 'lounge_join',
      arguments: { agentId: 'finance-agent', provider: 'codex', room: 'stage5-lounge' },
    }).then(structured)).resolves.toMatchObject({
      agentId: 'finance-agent',
      workNoteRevision: 0,
      workNote: null,
    });
    await expect(first.client.callTool({
      name: 'lounge_set_work_note',
      arguments: {
        note,
        expectedRevision: 0,
        idempotencyKey: 'finance-note-initial',
      },
    }).then(structured)).resolves.toMatchObject({
      agentId: 'finance-agent',
      workNoteRevision: 1,
      workNote: { revision: 1, ...note },
      duplicate: false,
      authority: 'coordination_only',
    });

    const replacement = await connect('finance-replacement');
    await expect(replacement.client.callTool({
      name: 'lounge_join',
      arguments: { agentId: 'finance-agent', provider: 'codex', room: 'stage5-lounge' },
    }).then(structured)).resolves.toMatchObject({
      agentId: 'finance-agent',
      supersededSessionCount: 1,
      workNoteRevision: 1,
      workNote: { revision: 1, ...note },
    });
    const superseded = await first.client.callTool({
      name: 'lounge_set_work_note',
      arguments: {
        note: { ...note, currentState: 'A stale writer attempted an update.' },
        expectedRevision: 1,
        idempotencyKey: 'stale-writer',
      },
    });
    expect(superseded.isError).toBe(true);
    expect(superseded.structuredContent).toMatchObject({
      error: { details: { reason: 'SESSION_CLOSED' } },
    });
    await expect(replacement.client.callTool({ name: 'lounge_status', arguments: { detail: 'full' } })
      .then(structured)).resolves.toMatchObject({
        workNoteRevision: 1,
        workNote: { revision: 1, ...note },
        memberWorkNotes: null,
      });

    await manager.client.callTool({
      name: 'lounge_join',
      arguments: {
        agentId: 'browser_developer',
        displayName: 'Browser Developer',
        provider: 'codex',
        room: 'stage5-lounge',
      },
    });
    const managerStatus = structured(await manager.client.callTool({
      name: 'lounge_status',
      arguments: { detail: 'full' },
    }));
    expect(managerStatus.managerAccess).toBe(true);
    expect(managerStatus.memberWorkNotes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId: 'finance-agent',
        workNoteRevision: 1,
        workNote: expect.objectContaining({ revision: 1, ...note }),
      }),
    ]));
  }, 20_000);
});
