#!/usr/bin/env node

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { loadConfig } from '../../dist/config.js';
import { LoungeService } from '../../dist/lounge-service.js';
import { createMcpSchemas } from '../../dist/mcp/schemas.js';
import { createServer } from '../../dist/mcp/server.js';
import { STAGE5_BROWSER_VERSION, TOOL_CATALOG_VERSION, WORKER_PROTOCOL_VERSION } from '../../dist/runtime-info.js';
import { BrowserSupervisor } from '../../dist/supervisor.js';

const config = loadConfig();
const startedAt = new Date().toISOString();
const runtime = {
  component: 'mcp',
  version: STAGE5_BROWSER_VERSION,
  protocolVersion: WORKER_PROTOCOL_VERSION,
  processId: process.pid,
  startedAt,
  buildModifiedAt: startedAt,
  artifactFingerprint: 'mcp-deadline-fixture',
  currentArtifactFingerprint: 'mcp-deadline-fixture',
  currentVersion: STAGE5_BROWSER_VERSION,
  currentProtocolVersion: WORKER_PROTOCOL_VERSION,
  currentToolCatalogVersion: TOOL_CATALOG_VERSION,
  compatibleUpdateAvailable: false,
  restartRequired: false,
  restartReason: null,
  suggestedAction: null,
};
const runtimeMonitor = {
  inspect: () => ({ ...runtime }),
  assertCurrent: () => undefined,
};
const context = {
  config,
  runtimeMonitor,
  supervisor: new BrowserSupervisor(config, {
    workerUrl: new URL('./fake-worker.mjs', import.meta.url),
    runtimeInfoProvider: runtimeMonitor.inspect,
  }),
  lounge: new LoungeService(),
  schemas: createMcpSchemas(config),
};
const handle = serveStdio(() => createServer(context), {
  onerror: (error) => process.stderr.write(`deadline fixture MCP error: ${error.name}\n`),
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await context.lounge.close();
  await context.supervisor.close();
  await handle.close();
}

process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
process.stdin.once('end', () => void shutdown());
process.stdin.once('close', () => void shutdown());
