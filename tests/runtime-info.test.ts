import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { RuntimeArtifactMonitor, type RuntimeBuildStamp } from '../src/runtime-info.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('RuntimeArtifactMonitor', () => {
  const stamp = (overrides: Partial<RuntimeBuildStamp> = {}): RuntimeBuildStamp => ({
    version: '0.6.0',
    buildId: 'build-1',
    builtAt: '2026-08-24T01:00:00.000Z',
    workerProtocolVersion: 5,
    toolCatalogVersion: 5,
    toolCount: 23,
    ...overrides,
  });

  it('allows a compatible runtime rebuild without an MCP restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-runtime-'));
    temporaryRoots.push(root);
    const artifact = path.join(root, 'build-stamp.json');
    await writeFile(artifact, JSON.stringify(stamp()));
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

    await writeFile(artifact, JSON.stringify(stamp({ version: '0.6.0', buildId: 'build-2' })));
    expect(monitor.inspect()).toMatchObject({
      compatibleUpdateAvailable: true,
      restartRequired: false,
      restartReason: null,
    });
    expect(() => monitor.assertCurrent()).not.toThrow();
  });

  it('requires an MCP restart when the tool catalog changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-contract-'));
    temporaryRoots.push(root);
    const artifact = path.join(root, 'build-stamp.json');
    await writeFile(artifact, JSON.stringify(stamp()));
    const monitor = new RuntimeArtifactMonitor('mcp', pathToFileURL(artifact));

    await writeFile(
      artifact,
      JSON.stringify(stamp({ buildId: 'build-2', toolCatalogVersion: 6, toolCount: 24 })),
    );
    expect(monitor.inspect()).toMatchObject({
      compatibleUpdateAvailable: false,
      restartRequired: true,
      restartReason: 'tool_catalog_changed',
    });
    expect(() => monitor.assertCurrent()).toThrowError(expect.objectContaining({ code: 'MCP_RESTART_REQUIRED' }));
  });

  it('marks a rebuilt worker for bounded supervisor replacement', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-worker-runtime-'));
    temporaryRoots.push(root);
    const artifact = path.join(root, 'build-stamp.json');
    await writeFile(artifact, JSON.stringify(stamp()));
    const monitor = new RuntimeArtifactMonitor('worker', pathToFileURL(artifact));

    await writeFile(artifact, JSON.stringify(stamp({ buildId: 'build-2' })));
    expect(monitor.inspect()).toMatchObject({
      restartRequired: true,
      restartReason: 'runtime_artifact_changed',
    });
    expect(() => monitor.assertCurrent()).toThrowError(expect.objectContaining({ code: 'WORKER_DISCONNECTED' }));
  });
});
