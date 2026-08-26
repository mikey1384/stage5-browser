import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';

import { MCP_TOOL_CONTRACTS } from '../src/mcp/tool-contracts.js';
import { MCP_TOOL_COUNT, STAGE5_BROWSER_VERSION } from '../src/runtime-info.js';

interface ConnectedClient {
  client: Client;
  transport: StdioClientTransport;
}

const connections: ConnectedClient[] = [];
let temporaryRoot: string | undefined;

afterEach(async () => {
  await Promise.all(connections.splice(0).map(async ({ client }) => client.close().catch(() => undefined)));
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

async function connectAgent(
  root: string,
  agentName: string,
  runtimeRoot = path.resolve('.'),
  managerAgentIds: string[] = [],
): Promise<ConnectedClient> {
  const projectRoot = path.resolve('.');
  const client = new Client({ name: `stage5-lounge-${agentName}-test`, version: STAGE5_BROWSER_VERSION });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(runtimeRoot, 'dist', 'launcher.js')],
    cwd: runtimeRoot,
    stderr: 'pipe',
    env: {
      ...getDefaultEnvironment(),
      PLAYWRIGHT_BROWSERS_PATH: path.join(projectRoot, '.playwright-browsers'),
      STAGE5_LOUNGE_DIR: path.join(root, 'lounge'),
      STAGE5_BROWSER_PROFILES_DIR: path.join(root, agentName, 'profiles'),
      STAGE5_BROWSER_PROFILE_DIR: path.join(root, agentName, 'profile'),
      STAGE5_BROWSER_ARTIFACTS_DIR: path.join(root, agentName, 'artifacts'),
      STAGE5_BROWSER_HEADLESS: '1',
      STAGE5_BROWSER_OPERATION_TIMEOUT_MS: '5000',
      ...(managerAgentIds.length === 0
        ? {}
        : { STAGE5_LOUNGE_MANAGER_AGENT_IDS: managerAgentIds.join(',') }),
    },
  });
  await client.connect(transport);
  const connected = { client, transport };
  connections.push(connected);
  return connected;
}

function structured(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

describe('MCP Agent Lounge', () => {
  it('wakes independent YouTube and Finance agents, records acknowledgements, and leaves browser work unblocked', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-agent-lounge-mcp-'));
    const browser = await connectAgent(temporaryRoot, 'browser-agent');
    const youtube = await connectAgent(temporaryRoot, 'youtube-agent');
    const finance = await connectAgent(temporaryRoot, 'finance-agent');

    const tools = await browser.client.listTools();
    expect(tools.tools).toHaveLength(MCP_TOOL_COUNT);
    expect(tools.tools.map(({ name }) => name).sort()).toEqual(
      Object.keys(MCP_TOOL_CONTRACTS).sort(),
    );
    for (const name of [
      'lounge_join',
      'lounge_send',
      'lounge_wait',
      'lounge_ack',
      'lounge_status',
      'lounge_pin',
      'lounge_history',
      'browser_inspect_tab',
    ]) {
      expect(tools.tools.some((tool) => tool.name === name), `${name} should be exposed`).toBe(true);
    }
    const selectTabTool = tools.tools.find((tool) => tool.name === 'browser_select_tab');
    expect(selectTabTool?.inputSchema).toMatchObject({
      required: ['tabId'],
      properties: {
        tabId: expect.objectContaining({ type: 'string' }),
      },
    });
    expect((selectTabTool?.inputSchema as { properties?: Record<string, unknown> } | undefined)
      ?.properties).not.toHaveProperty('index');
    const inspectTabTool = tools.tools.find((tool) => tool.name === 'browser_inspect_tab');
    expect(inspectTabTool?.inputSchema).toMatchObject({
      required: ['tabId'],
      properties: {
        tabId: expect.objectContaining({ type: 'string' }),
        temporaryActivation: expect.objectContaining({ type: 'boolean', default: false }),
        waitFor: expect.any(Object),
      },
    });

    for (const [connection, agentId, displayName, provider] of [
      [browser, 'browser-agent', 'Browser Agent', 'codex'],
      [youtube, 'youtube-agent', 'YouTube Agent', 'claude'],
      [finance, 'finance-agent', 'Finance Agent', 'codex'],
    ] as const) {
      expect(structured(await connection.client.callTool({
        name: 'lounge_join',
        arguments: { agentId, displayName, provider, room: 'stage5-lounge' },
      }))).toMatchObject({ agentId, loungeId: 'stage5-lounge', authority: 'coordination_only' });
    }

    const youtubeWait = youtube.client.callTool({
      name: 'lounge_wait',
      arguments: { timeoutMs: 5_000, limit: 20 },
    });
    const financeWait = finance.client.callTool({
      name: 'lounge_wait',
      arguments: { timeoutMs: 5_000, limit: 20 },
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    const waitingPresence = structured(await browser.client.callTool({
      name: 'lounge_status',
      arguments: {},
    }));
    expect(waitingPresence).toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({ agentId: 'youtube-agent', presence: 'listening' }),
        expect.objectContaining({ agentId: 'finance-agent', presence: 'listening' }),
      ]),
    });
    const browserStatusWhileWaiting = await Promise.race([
      youtube.client.callTool({ name: 'browser_status', arguments: {} }),
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error('A Lounge wait blocked an independent browser-status request.')),
        3_000,
      )),
    ]);
    expect(browserStatusWhileWaiting.isError).not.toBe(true);

    const sent = structured(await browser.client.callTool({
      name: 'lounge_send',
      arguments: {
        to: ['youtube-agent', 'finance-agent'],
        kind: 'dependency_resolved',
        body: 'Stage5 Browser 0.8.0 is ready. Resume from one fresh observation and report the result here.',
        replyTo: null,
        taskKey: 'stage5-browser-lounge-acceptance',
        idempotencyKey: 'browser-0.8.0-ready',
      },
    }));
    expect(sent).toMatchObject({
      duplicate: false,
      recipientAgentIds: ['finance-agent', 'youtube-agent'],
      authority: 'coordination_only',
    });
    const messageId = sent.messageId;
    expect(typeof messageId).toBe('string');
    if (typeof messageId !== 'string') throw new Error('Lounge send did not return a message ID.');

    for (const result of await Promise.all([youtubeWait, financeWait])) {
      expect(structured(result)).toMatchObject({
        timedOut: false,
        online: true,
        authority: 'coordination_only',
        messages: [{
          messageId,
          senderAgentId: 'browser-agent',
          kind: 'dependency_resolved',
          authority: 'coordination_only',
        }],
      });
    }

    for (const connection of [youtube, finance]) {
      structured(await connection.client.callTool({
        name: 'lounge_ack',
        arguments: { messageIds: [messageId], state: 'seen' },
      }));
      structured(await connection.client.callTool({
        name: 'lounge_ack',
        arguments: { messageIds: [messageId], state: 'acted' },
      }));
    }

    const duplicate = structured(await browser.client.callTool({
      name: 'lounge_send',
      arguments: {
        to: ['youtube-agent', 'finance-agent'],
        kind: 'dependency_resolved',
        body: 'Stage5 Browser 0.8.0 is ready. Resume from one fresh observation and report the result here.',
        replyTo: null,
        taskKey: 'stage5-browser-lounge-acceptance',
        idempotencyKey: 'browser-0.8.0-ready',
      },
    }));
    expect(duplicate).toMatchObject({ messageId, duplicate: true });

    const status = structured(await browser.client.callTool({ name: 'lounge_status', arguments: {} }));
    expect(status).toMatchObject({
      requestingAgentId: 'browser-agent',
      members: expect.arrayContaining([
        expect.objectContaining({ agentId: 'youtube-agent' }),
        expect.objectContaining({ agentId: 'finance-agent' }),
      ]),
      recentSentMessages: [expect.objectContaining({
        messageId,
        recipients: expect.arrayContaining([
          expect.objectContaining({ agentId: 'youtube-agent', state: 'acted' }),
          expect.objectContaining({ agentId: 'finance-agent', state: 'acted' }),
        ]),
      })],
    });
  }, 20_000);

  it('wakes listeners for manager-pinned notices and audits room-wide history reads', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-agent-lounge-manager-mcp-'));
    const manager = await connectAgent(
      temporaryRoot,
      'ghostty-codex',
      path.resolve('.'),
      ['ghostty-codex'],
    );
    const youtube = await connectAgent(temporaryRoot, 'youtube-agent');
    const finance = await connectAgent(temporaryRoot, 'finance-agent');

    await expect(manager.client.callTool({
      name: 'lounge_join',
      arguments: {
        agentId: 'ghostty-codex',
        displayName: 'Ghostty Codex',
        provider: 'codex',
        room: 'stage5-lounge',
      },
    }).then(structured)).resolves.toMatchObject({
      agentId: 'ghostty-codex',
      managerAccess: true,
      noticeRevision: 0,
      pinnedNotice: null,
    });
    for (const [connection, agentId, provider] of [
      [youtube, 'youtube-agent', 'claude'],
      [finance, 'finance-agent', 'codex'],
    ] as const) {
      await expect(connection.client.callTool({
        name: 'lounge_join',
        arguments: { agentId, provider, room: 'stage5-lounge' },
      }).then(structured)).resolves.toMatchObject({
        agentId,
        managerAccess: false,
        noticeRevision: 0,
      });
    }

    const noticeWait = youtube.client.callTool({
      name: 'lounge_wait',
      arguments: { timeoutMs: 5_000, limit: 20 },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pinned = structured(await manager.client.callTool({
      name: 'lounge_pin',
      arguments: {
        body: 'Route sanitized Stage5 Browser defects to ghostty-codex.',
        expectedRevision: 0,
        idempotencyKey: 'mcp-manager-routing-notice',
      },
    }));
    expect(pinned).toMatchObject({
      managerAccess: true,
      noticeRevision: 1,
      duplicate: false,
      pinnedNotice: {
        revision: 1,
        body: 'Route sanitized Stage5 Browser defects to ghostty-codex.',
        pinnedByAgentId: 'ghostty-codex',
      },
    });
    expect(structured(await noticeWait)).toMatchObject({
      messages: [],
      noticeChanged: true,
      noticeRevision: 1,
      timedOut: false,
      pinnedNotice: { body: 'Route sanitized Stage5 Browser defects to ghostty-codex.' },
    });

    const direct = structured(await youtube.client.callTool({
      name: 'lounge_send',
      arguments: {
        to: ['finance-agent'],
        kind: 'finding',
        body: 'A sanitized direct dogfooding finding.',
        replyTo: null,
        taskKey: 'manager-history-acceptance',
        idempotencyKey: 'mcp-manager-history-direct',
      },
    }));
    const directMessageId = direct.messageId;
    expect(typeof directMessageId).toBe('string');
    if (typeof directMessageId !== 'string') throw new Error('Direct history fixture returned no message ID.');

    const history = structured(await manager.client.callTool({
      name: 'lounge_history',
      arguments: { limit: 10, beforeSequence: null, afterSequence: null },
    }));
    expect(history).toMatchObject({
      requestingAgentId: 'ghostty-codex',
      managerAccess: true,
      messages: [expect.objectContaining({
        messageId: directMessageId,
        senderAgentId: 'youtube-agent',
        body: 'A sanitized direct dogfooding finding.',
        recipients: [expect.objectContaining({ agentId: 'finance-agent', state: 'pending' })],
        authority: 'coordination_only',
      })],
      page: { limit: 10, hasOlder: false, hasNewer: false },
    });
    expect(typeof history.auditId).toBe('string');

    const denied = await youtube.client.callTool({
      name: 'lounge_history',
      arguments: { limit: 10, beforeSequence: null, afterSequence: null },
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      error: {
        code: 'OPERATION_FAILED',
        recoverable: false,
        details: { reason: 'MANAGER_ACCESS_REQUIRED' },
      },
    });

    const delivered = structured(await finance.client.callTool({
      name: 'lounge_wait',
      arguments: { timeoutMs: 2_000, limit: 20 },
    }));
    expect(delivered).toMatchObject({
      messages: [expect.objectContaining({ messageId: directMessageId, deliveryAttempt: 1 })],
      timedOut: false,
    });
    structured(await finance.client.callTool({
      name: 'lounge_ack',
      arguments: { messageIds: [directMessageId], state: 'seen' },
    }));
    structured(await finance.client.callTool({
      name: 'lounge_ack',
      arguments: { messageIds: [directMessageId], state: 'acted' },
    }));
    expect(structured(await manager.client.callTool({
      name: 'lounge_history',
      arguments: { limit: 10, beforeSequence: null, afterSequence: null },
    }))).toMatchObject({
      messages: [expect.objectContaining({
        messageId: directMessageId,
        recipients: [expect.objectContaining({ agentId: 'finance-agent', state: 'acted' })],
      })],
    });
  }, 20_000);

  it('keeps Lounge coordination available while an unrelated browser contract awaits host reconnect', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-agent-lounge-stale-mcp-'));
    const runtimeRoot = path.join(temporaryRoot, 'runtime');
    await mkdir(runtimeRoot, { recursive: true });
    await cp(path.resolve('dist'), path.join(runtimeRoot, 'dist'), { recursive: true });
    await symlink(path.resolve('node_modules'), path.join(runtimeRoot, 'node_modules'), 'dir');

    const coordinator = await connectAgent(temporaryRoot, 'coordinator-agent', runtimeRoot);
    const reporter = await connectAgent(temporaryRoot, 'reporter-agent', runtimeRoot);
    for (const [connection, agentId] of [
      [coordinator, 'coordinator-agent'],
      [reporter, 'reporter-agent'],
    ] as const) {
      expect(structured(await connection.client.callTool({
        name: 'lounge_join',
        arguments: { agentId, room: 'stage5-lounge' },
      }))).toMatchObject({ agentId, authority: 'coordination_only' });
    }

    const stampPath = path.join(runtimeRoot, 'dist', 'build-stamp.json');
    const stamp = JSON.parse(await readFile(stampPath, 'utf8')) as {
      buildId: string;
      toolCatalogVersion: number;
    };
    await writeFile(stampPath, JSON.stringify({
      ...stamp,
      buildId: `${stamp.buildId}-contract-change`,
      toolCatalogVersion: stamp.toolCatalogVersion + 1,
    }));

    expect(structured(await coordinator.client.callTool({
      name: 'browser_status',
      arguments: {},
    }))).toMatchObject({
      result: null,
      mcp: { restartRequired: true, restartReason: 'tool_catalog_changed' },
    });

    const sent = structured(await coordinator.client.callTool({
      name: 'lounge_send',
      arguments: {
        to: ['reporter-agent'],
        kind: 'message',
        body: 'Coordination remains available while browser actions wait for reconnect.',
        replyTo: null,
        taskKey: 'stale-browser-contract',
        idempotencyKey: 'stale-browser-contract-message',
      },
    }));
    expect(typeof sent.messageId).toBe('string');
    const messageId = sent.messageId;
    if (typeof messageId !== 'string') throw new Error('Stale-contract Lounge send returned no message ID.');

    expect(structured(await reporter.client.callTool({
      name: 'lounge_wait',
      arguments: { timeoutMs: 2_000, limit: 20 },
    }))).toMatchObject({
      timedOut: false,
      messages: [{ messageId, senderAgentId: 'coordinator-agent' }],
    });
    structured(await reporter.client.callTool({
      name: 'lounge_ack',
      arguments: { messageIds: [messageId], state: 'seen' },
    }));
    structured(await reporter.client.callTool({
      name: 'lounge_ack',
      arguments: { messageIds: [messageId], state: 'acted' },
    }));
    expect(structured(await coordinator.client.callTool({
      name: 'lounge_status',
      arguments: {},
    }))).toMatchObject({
      recentSentMessages: [expect.objectContaining({
        messageId,
        recipients: [expect.objectContaining({ agentId: 'reporter-agent', state: 'acted' })],
      })],
    });
  }, 20_000);

  it('preserves the joined Lounge binding across a compatible browser-worker replacement', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-agent-lounge-worker-reload-'));
    const runtimeRoot = path.join(temporaryRoot, 'runtime');
    await mkdir(runtimeRoot, { recursive: true });
    await cp(path.resolve('dist'), path.join(runtimeRoot, 'dist'), { recursive: true });
    await symlink(path.resolve('node_modules'), path.join(runtimeRoot, 'node_modules'), 'dir');

    const coordinator = await connectAgent(temporaryRoot, 'coordinator-agent', runtimeRoot);
    const reporter = await connectAgent(temporaryRoot, 'reporter-agent', runtimeRoot);
    for (const [connection, agentId] of [
      [coordinator, 'coordinator-agent'],
      [reporter, 'reporter-agent'],
    ] as const) {
      expect(structured(await connection.client.callTool({
        name: 'lounge_join',
        arguments: { agentId, room: 'stage5-lounge' },
      }))).toMatchObject({ agentId, authority: 'coordination_only' });
    }

    const before = structured(await coordinator.client.callTool({
      name: 'browser_status',
      arguments: {},
    })) as {
      result?: { workerPid?: unknown };
      mcp?: { processId?: unknown };
    };
    expect(typeof before.result?.workerPid).toBe('number');
    expect(typeof before.mcp?.processId).toBe('number');

    const mcpArtifactPath = path.join(runtimeRoot, 'dist', 'mcp-server.js');
    const mcpArtifact = await readFile(mcpArtifactPath, 'utf8');
    await writeFile(mcpArtifactPath, `${mcpArtifact}\n// compatible worker replacement fixture\n`);
    const stampPath = path.join(runtimeRoot, 'dist', 'build-stamp.json');
    const stamp = JSON.parse(await readFile(stampPath, 'utf8')) as {
      buildId: string;
      toolCatalogVersion: number;
      workerProtocolVersion: number;
    };
    await writeFile(stampPath, JSON.stringify({
      ...stamp,
      buildId: `${stamp.buildId}-compatible-worker-reload`,
    }));

    const after = structured(await coordinator.client.callTool({
      name: 'browser_status',
      arguments: {},
    })) as {
      result?: { workerPid?: unknown };
      mcp?: {
        processId?: unknown;
        compatibleUpdateAvailable?: unknown;
        restartRequired?: unknown;
      };
    };
    expect(after.mcp).toMatchObject({
      processId: before.mcp?.processId,
      compatibleUpdateAvailable: true,
      restartRequired: false,
    });
    expect(typeof after.result?.workerPid).toBe('number');
    expect(after.result?.workerPid).not.toBe(before.result?.workerPid);

    const sent = structured(await coordinator.client.callTool({
      name: 'lounge_send',
      arguments: {
        to: ['reporter-agent'],
        kind: 'finding',
        body: 'The same joined MCP connection survived its compatible browser-worker replacement.',
        replyTo: null,
        taskKey: 'lounge-worker-replacement-regression',
        idempotencyKey: 'lounge-worker-replacement-regression-message',
      },
    }));
    expect(typeof sent.messageId).toBe('string');
    expect(structured(await reporter.client.callTool({
      name: 'lounge_wait',
      arguments: { timeoutMs: 2_000, limit: 20 },
    }))).toMatchObject({
      timedOut: false,
      messages: [{ messageId: sent.messageId, senderAgentId: 'coordinator-agent' }],
    });

    const unjoined = await connectAgent(temporaryRoot, 'unjoined-agent', runtimeRoot);
    const rejected = await unjoined.client.callTool({
      name: 'lounge_send',
      arguments: {
        kind: 'message',
        body: 'This connection has not joined.',
        replyTo: null,
        taskKey: null,
        idempotencyKey: 'unjoined-connection-regression',
      },
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent).toMatchObject({
      error: {
        details: {
          reason: 'lounge_not_joined',
          boundary: 'mcp_connection',
          browserWorkerReplacementPreservesMembership: true,
        },
      },
    });
  }, 20_000);
});
