#!/usr/bin/env node

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createMcpHostContext } from './mcp/context.js';
import { createServer } from './mcp/server.js';

const context = createMcpHostContext(import.meta.url);
const handle = serveStdio(() => createServer(context), {
  onerror: (error) => {
    process.stderr.write(`Stage5 Browser MCP transport error: ${error.name}\n`);
  },
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await context.lounge.close();
  await context.supervisor.close();
  await handle.close();
}

process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
process.once('beforeExit', () => void context.supervisor.close());
process.stdin.once('end', () => void shutdown());
process.stdin.once('close', () => void shutdown());
