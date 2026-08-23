import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

function assertToolSuccess(result: unknown, name: string): void {
  const candidate = result as { isError?: boolean; structuredContent?: Record<string, unknown> };
  if (candidate.isError === true) {
    throw new Error(`${name} returned an MCP tool error: ${JSON.stringify(candidate.structuredContent)}`);
  }
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-smoke-'));
const client = new Client({ name: 'stage5-browser-smoke', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, 'dist', 'mcp-server.js')],
  cwd: projectRoot,
  stderr: 'pipe',
  env: {
    ...getDefaultEnvironment(),
    PLAYWRIGHT_BROWSERS_PATH: path.join(projectRoot, '.playwright-browsers'),
    STAGE5_BROWSER_PROFILE_DIR: path.join(temporaryRoot, 'profile'),
    STAGE5_BROWSER_ARTIFACTS_DIR: path.join(temporaryRoot, 'artifacts'),
    STAGE5_BROWSER_HEADLESS: '1',
    STAGE5_BROWSER_OPERATION_TIMEOUT_MS: '20000',
    STAGE5_BROWSER_NAVIGATION_TIMEOUT_MS: '30000',
  },
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const required of ['browser_open', 'browser_snapshot', 'browser_screenshot', 'browser_recover']) {
    if (!names.has(required)) {
      throw new Error(`Required MCP tool is missing: ${required}`);
    }
  }

  const opened = await client.callTool({
    name: 'browser_open',
    arguments: { url: 'https://translator.tools', newTab: false, timeoutMs: 30_000 },
  });
  assertToolSuccess(opened, 'browser_open');

  const snapshot = await client.callTool({
    name: 'browser_snapshot',
    arguments: { depth: 8, boxes: false, timeoutMs: 20_000 },
  });
  assertToolSuccess(snapshot, 'browser_snapshot');

  const screenshot = await client.callTool({
    name: 'browser_screenshot',
    arguments: { fullPage: false, timeoutMs: 20_000 },
  });
  assertToolSuccess(screenshot, 'browser_screenshot');

  const snapshotText = snapshot.content.find((item) => item.type === 'text')?.text ?? '';
  if (!snapshotText.toLowerCase().includes('translator')) {
    throw new Error('The production semantic snapshot did not identify translator.tools.');
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      target: 'https://translator.tools',
      toolCount: tools.tools.length,
      snapshotCharacters: snapshotText.length,
      screenshotReturned: screenshot.content.some((item) => item.type === 'image'),
    })}\n`,
  );
} finally {
  try {
    await client.callTool({ name: 'browser_stop', arguments: {} });
  } catch {
    // The transport or worker may already be gone; cleanup continues below.
  }
  await client.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}
