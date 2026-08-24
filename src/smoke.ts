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
const configuredBrowser = process.env.STAGE5_BROWSER_BROWSER?.trim().toLowerCase() ?? 'chromium';
const switchTarget = process.env.STAGE5_BROWSER_SWITCH_TO?.trim().toLowerCase();
const expectedBrowser = switchTarget ?? configuredBrowser;
const smokeCwd = process.env.STAGE5_BROWSER_SMOKE_CWD ?? projectRoot;
const smokePlaywrightPath =
  process.env.STAGE5_BROWSER_SMOKE_PLAYWRIGHT_PATH ?? path.join(projectRoot, '.playwright-browsers');
const usePersistentProfile = process.env.STAGE5_BROWSER_SMOKE_PERSISTENT === '1';
const client = new Client({ name: 'stage5-browser-smoke', version: '0.2.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, 'dist', 'launcher.js')],
  cwd: smokeCwd,
  stderr: 'pipe',
  env: {
    ...getDefaultEnvironment(),
    PLAYWRIGHT_BROWSERS_PATH: smokePlaywrightPath,
    ...(usePersistentProfile
      ? {}
      : {
          STAGE5_BROWSER_PROFILES_DIR: path.join(temporaryRoot, 'profiles'),
          STAGE5_BROWSER_PROFILE_DIR: path.join(temporaryRoot, 'profile'),
          STAGE5_BROWSER_ARTIFACTS_DIR: path.join(temporaryRoot, 'artifacts'),
        }),
    STAGE5_BROWSER_HEADLESS: '1',
    STAGE5_BROWSER_OPERATION_TIMEOUT_MS: '20000',
    STAGE5_BROWSER_NAVIGATION_TIMEOUT_MS: '30000',
    ...(process.env.STAGE5_BROWSER_BROWSER === undefined
      ? {}
      : { STAGE5_BROWSER_BROWSER: process.env.STAGE5_BROWSER_BROWSER }),
    ...(process.env.STAGE5_BROWSER_EXECUTABLE_PATH === undefined
      ? {}
      : { STAGE5_BROWSER_EXECUTABLE_PATH: process.env.STAGE5_BROWSER_EXECUTABLE_PATH }),
  },
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const required of [
    'browser_available',
    'browser_diagnostics',
    'browser_start',
    'browser_switch',
    'browser_open',
    'browser_frames',
    'browser_snapshot',
    'browser_screenshot',
    'browser_recover',
  ]) {
    if (!names.has(required)) {
      throw new Error(`Required MCP tool is missing: ${required}`);
    }
  }

  const available = await client.callTool({ name: 'browser_available', arguments: {} });
  assertToolSuccess(available, 'browser_available');
  const availability = (available.structuredContent as {
    result?: { browsers?: Array<{ browser?: unknown; available?: unknown }> };
  } | undefined)?.result?.browsers?.find((entry) => entry.browser === expectedBrowser);
  if (availability?.available !== true) {
    throw new Error(`The ${expectedBrowser} backend did not pass browser_available preflight.`);
  }

  const started = await client.callTool({
    name: 'browser_start',
    arguments: { browser: configuredBrowser },
  });
  assertToolSuccess(started, 'browser_start');

  if (switchTarget !== undefined) {
    const switched = await client.callTool({
      name: 'browser_switch',
      arguments: { browser: switchTarget },
    });
    assertToolSuccess(switched, 'browser_switch');
  }

  const opened = await client.callTool({
    name: 'browser_open',
    arguments: { url: 'https://translator.tools', newTab: false, timeoutMs: 30_000 },
  });
  assertToolSuccess(opened, 'browser_open');

  const status = await client.callTool({ name: 'browser_status', arguments: {} });
  assertToolSuccess(status, 'browser_status');
  const statusPayload = status.structuredContent as {
    result?: { browser?: unknown };
    mcp?: { version?: unknown; restartRequired?: unknown };
  } | undefined;
  const selectedBrowser = statusPayload?.result?.browser;
  if (selectedBrowser !== expectedBrowser) {
    throw new Error(`Expected ${expectedBrowser}, but browser_status reported ${String(selectedBrowser)}.`);
  }
  if (statusPayload?.mcp?.version !== '0.2.0' || statusPayload.mcp.restartRequired !== false) {
    throw new Error('browser_status did not report the current non-stale MCP build.');
  }

  const diagnostics = await client.callTool({ name: 'browser_diagnostics', arguments: {} });
  assertToolSuccess(diagnostics, 'browser_diagnostics');
  const diagnosticResult = (diagnostics.structuredContent as {
    result?: { browser?: { availability?: { available?: unknown }; profile?: { writable?: unknown } } };
  } | undefined)?.result?.browser;
  if (diagnosticResult?.availability?.available !== true || diagnosticResult.profile?.writable !== true) {
    throw new Error('browser_diagnostics did not confirm executable availability and profile writability.');
  }

  const frames = await client.callTool({ name: 'browser_frames', arguments: {} });
  assertToolSuccess(frames, 'browser_frames');
  const observedFrames = (frames.structuredContent as {
    result?: { frames?: Array<{ id?: unknown; isMainFrame?: unknown }> };
  } | undefined)?.result?.frames;
  if (!observedFrames?.some((frame) => typeof frame.id === 'string' && frame.isMainFrame === true)) {
    throw new Error('browser_frames did not return the active page main frame.');
  }

  const snapshot = await client.callTool({
    name: 'browser_snapshot',
    arguments: { frameId: null, depth: 8, boxes: false, timeoutMs: 20_000 },
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
      browser: selectedBrowser,
      toolCount: tools.tools.length,
      mcpVersion: statusPayload.mcp.version,
      frameCount: observedFrames.length,
      diagnosticsPassed: true,
      persistentProfile: usePersistentProfile,
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
