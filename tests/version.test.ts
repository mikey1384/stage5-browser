import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MCP_TOOL_COUNT,
  MCP_HOST_BEHAVIOR_VERSION,
  STAGE5_BROWSER_VERSION,
  TOOL_CATALOG_VERSION,
  WORKER_PROTOCOL_VERSION,
} from '../src/runtime-info.js';

describe('release metadata', () => {
  it('keeps package and plugin versions aligned with the runtime protocol', async () => {
    const packageJson = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as {
      version: string;
      stage5Browser: {
        workerProtocolVersion: number;
        hostBehaviorVersion: number;
        toolCatalogVersion: number;
        toolCount: number;
      };
    };
    const pluginJson = JSON.parse(
      await readFile(path.resolve('.codex-plugin', 'plugin.json'), 'utf8'),
    ) as { version: string };
    expect(packageJson.version).toBe(STAGE5_BROWSER_VERSION);
    expect(pluginJson.version).toBe(STAGE5_BROWSER_VERSION);
    expect(WORKER_PROTOCOL_VERSION).toBe(packageJson.stage5Browser.workerProtocolVersion);
    expect(MCP_HOST_BEHAVIOR_VERSION).toBe(packageJson.stage5Browser.hostBehaviorVersion);
    expect(TOOL_CATALOG_VERSION).toBe(packageJson.stage5Browser.toolCatalogVersion);
    expect(MCP_TOOL_COUNT).toBe(packageJson.stage5Browser.toolCount);
  });
});
