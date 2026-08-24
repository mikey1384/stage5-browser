import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { RuntimeArtifactMonitor } from '../src/runtime-info.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('RuntimeArtifactMonitor', () => {
  it('requires an MCP restart when the loaded runtime artifact changes on disk', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-runtime-'));
    temporaryRoots.push(root);
    const artifact = path.join(root, 'mcp-server.js');
    await writeFile(artifact, 'export const build = 1;\n');
    const monitor = new RuntimeArtifactMonitor(
      'mcp',
      pathToFileURL(artifact),
      new Date('2026-08-24T01:00:00.000Z'),
      123,
    );

    expect(monitor.inspect()).toMatchObject({
      processId: 123,
      restartRequired: false,
      restartReason: null,
    });

    await writeFile(artifact, 'export const build = 2;\n');
    expect(monitor.inspect()).toMatchObject({
      restartRequired: true,
      restartReason: 'runtime_artifact_changed',
    });
    expect(() => monitor.assertCurrent()).toThrowError(
      expect.objectContaining({ code: 'MCP_RESTART_REQUIRED' }),
    );
  });
});
