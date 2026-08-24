import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MCP_TOOL_COUNT, STAGE5_BROWSER_VERSION, WORKER_PROTOCOL_VERSION } from '../src/runtime-info.js';

describe('release metadata', () => {
  it('keeps package and plugin versions aligned with the runtime protocol', async () => {
    const packageJson = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as { version: string };
    const pluginJson = JSON.parse(
      await readFile(path.resolve('.codex-plugin', 'plugin.json'), 'utf8'),
    ) as { version: string };
    expect(packageJson.version).toBe(STAGE5_BROWSER_VERSION);
    expect(pluginJson.version).toBe(STAGE5_BROWSER_VERSION);
    expect(WORKER_PROTOCOL_VERSION).toBeGreaterThan(1);
    expect(MCP_TOOL_COUNT).toBe(15);
  });
});
