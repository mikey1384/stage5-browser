import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MCP_TOOL_COUNT,
  MCP_HOST_BEHAVIOR_VERSION,
  STAGE5_BROWSER_VERSION,
  STAGE5_MCP_TOOLS_VERSION,
  TOOL_CATALOG_VERSION,
  WORKER_PROTOCOL_VERSION,
} from '../src/runtime-info.js';
import {
  STAGE5_BROWSER_CAPABILITY_NAME,
  STAGE5_BROWSER_REGISTRATION_ALIAS,
  STAGE5_MCP_SERVER_NAME,
  STAGE5_MCP_TOOLS_PRODUCT_NAME,
} from '../src/product-info.js';

describe('release metadata', () => {
  it('keeps package and plugin versions aligned with the runtime protocol', async () => {
    const packageJson = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as {
      name: string;
      version: string;
      bin: Record<string, string>;
      stage5Browser: {
        workerProtocolVersion: number;
        hostBehaviorVersion: number;
        toolCatalogVersion: number;
        toolCount: number;
      };
    };
    const pluginJson = JSON.parse(
      await readFile(path.resolve('.codex-plugin', 'plugin.json'), 'utf8'),
    ) as { name: string; version: string; interface: { displayName: string } };
    const mcpJson = JSON.parse(await readFile(path.resolve('.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(packageJson.name).toBe('@stage5/mcp-tools');
    expect(packageJson.bin).toMatchObject({
      'stage5-mcp-tools': './dist/launcher.js',
      'stage5-browser': './dist/launcher.js',
    });
    expect(STAGE5_MCP_TOOLS_PRODUCT_NAME).toBe('Stage5 MCP Tools');
    expect(STAGE5_MCP_SERVER_NAME).toBe('stage5-mcp-tools');
    expect(STAGE5_BROWSER_CAPABILITY_NAME).toBe('Stage5 Browser');
    expect(pluginJson.name).toBe('stage5-browser');
    expect(pluginJson.interface.displayName).toBe(STAGE5_MCP_TOOLS_PRODUCT_NAME);
    expect(mcpJson.mcpServers).toHaveProperty(STAGE5_BROWSER_REGISTRATION_ALIAS);
    expect(packageJson.version).toBe(STAGE5_BROWSER_VERSION);
    expect(packageJson.version).toBe(STAGE5_MCP_TOOLS_VERSION);
    expect(pluginJson.version).toBe(STAGE5_BROWSER_VERSION);
    expect(WORKER_PROTOCOL_VERSION).toBe(packageJson.stage5Browser.workerProtocolVersion);
    expect(MCP_HOST_BEHAVIOR_VERSION).toBe(packageJson.stage5Browser.hostBehaviorVersion);
    expect(TOOL_CATALOG_VERSION).toBe(packageJson.stage5Browser.toolCatalogVersion);
    expect(MCP_TOOL_COUNT).toBe(packageJson.stage5Browser.toolCount);
  });
});
