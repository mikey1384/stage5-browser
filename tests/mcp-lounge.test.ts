import { mkdtemp, rm } from 'node:fs/promises';
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

async function connectAgent(root: string, agentName: string): Promise<ConnectedClient> {
  const projectRoot = path.resolve('.');
  const client = new Client({ name: `stage5-lounge-${agentName}-test`, version: STAGE5_BROWSER_VERSION });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, 'dist', 'launcher.js')],
    cwd: projectRoot,
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
});
