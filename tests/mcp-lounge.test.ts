import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';

import { STAGE5_BROWSER_VERSION } from '../src/runtime-info.js';

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
    for (const name of ['lounge_join', 'lounge_send', 'lounge_wait', 'lounge_ack', 'lounge_status']) {
      expect(tools.tools.some((tool) => tool.name === name), `${name} should be exposed`).toBe(true);
    }

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
});
