import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';

import { STAGE5_MCP_SERVER_NAME } from '../src/product-info.js';
import { STAGE5_MCP_TOOLS_VERSION } from '../src/runtime-info.js';

let client: Client | undefined;
let temporaryRoot: string | undefined;

afterEach(async () => {
  await client?.close();
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

describe('Stage5 MCP Tools product identity', () => {
  it('advertises the Lounge-first server while retaining the browser tool family', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-mcp-tools-identity-'));
    const projectRoot = path.resolve('.');
    client = new Client({ name: 'stage5-mcp-tools-identity-test', version: STAGE5_MCP_TOOLS_VERSION });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [path.join(projectRoot, 'dist', 'launcher.js')],
      cwd: projectRoot,
      stderr: 'pipe',
      env: {
        ...getDefaultEnvironment(),
        STAGE5_LOUNGE_DIR: path.join(temporaryRoot, 'lounge'),
        STAGE5_BROWSER_HEADLESS: '1',
      },
    }));

    expect(client.getServerVersion()).toEqual({
      name: STAGE5_MCP_SERVER_NAME,
      version: STAGE5_MCP_TOOLS_VERSION,
    });
    const tools = await client.listTools();
    expect(tools.tools.slice(0, 8).map(({ name }) => name)).toEqual([
      'lounge_join',
      'lounge_send',
      'lounge_wait',
      'lounge_ack',
      'lounge_status',
      'lounge_set_work_note',
      'lounge_pin',
      'lounge_history',
    ]);
    expect(tools.tools.some(({ name }) => name === 'browser_status')).toBe(true);
  });
});
