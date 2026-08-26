import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  negotiateWorkerInitialization,
  RuntimeArtifactMonitor,
  WORKER_PROTOCOL_VERSION,
  type RuntimeBuildStamp,
  type RuntimeProcessInfo,
} from '../src/runtime-info.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('RuntimeArtifactMonitor', () => {
  const stamp = (overrides: Partial<RuntimeBuildStamp> = {}): RuntimeBuildStamp => ({
    version: '0.6.2',
    buildId: 'build-1',
    builtAt: '2026-08-24T01:00:00.000Z',
    workerProtocolVersion: 5,
    hostBehaviorVersion: 1,
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

    await writeFile(artifact, JSON.stringify(stamp({ version: '0.6.4', buildId: 'build-2' })));
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

  it('requires an MCP restart when host lifecycle behavior changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-host-behavior-'));
    temporaryRoots.push(root);
    const artifact = path.join(root, 'build-stamp.json');
    await writeFile(artifact, JSON.stringify(stamp()));
    const monitor = new RuntimeArtifactMonitor('mcp', pathToFileURL(artifact));

    await writeFile(
      artifact,
      JSON.stringify(stamp({ buildId: 'build-2', hostBehaviorVersion: 2 })),
    );
    expect(monitor.inspect()).toMatchObject({
      compatibleUpdateAvailable: false,
      restartRequired: true,
      restartReason: 'mcp_host_behavior_changed',
    });
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

describe('worker initialization compatibility', () => {
  const workerRuntime = (overrides: Partial<RuntimeProcessInfo> = {}): RuntimeProcessInfo => ({
    component: 'worker',
    version: '0.6.8',
    protocolVersion: WORKER_PROTOCOL_VERSION,
    hostBehaviorVersion: 1,
    processId: 456,
    startedAt: '2026-08-25T01:00:00.000Z',
    buildModifiedAt: '2026-08-25T01:00:00.000Z',
    artifactFingerprint: 'worker-build-2',
    currentArtifactFingerprint: 'worker-build-2',
    currentVersion: '0.6.8',
    currentProtocolVersion: WORKER_PROTOCOL_VERSION,
    currentHostBehaviorVersion: 1,
    currentToolCatalogVersion: 6,
    compatibleUpdateAvailable: false,
    restartRequired: false,
    restartReason: null,
    suggestedAction: null,
    ...overrides,
  });

  it('treats a build fingerprint as diagnostic identity for a current supervisor', () => {
    const runtime = negotiateWorkerInitialization(
      {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        mcpVersion: '0.6.7',
        mcpBuildFingerprint: 'mcp-build-1',
        buildFingerprintPolicy: 'diagnostic_only',
      },
      workerRuntime(),
    );

    expect(runtime).toMatchObject({
      artifactFingerprint: 'worker-build-2',
      currentArtifactFingerprint: 'worker-build-2',
      compatibleUpdateAvailable: false,
    });
    expect(runtime.initializationCompatibility).toBeUndefined();
  });

  it('bridges the legacy fingerprint gate without hiding the loaded worker identity', () => {
    const runtime = negotiateWorkerInitialization(
      {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        mcpVersion: '0.6.6',
        mcpBuildFingerprint: 'mcp-build-1',
      },
      workerRuntime(),
    );

    expect(runtime).toMatchObject({
      artifactFingerprint: 'mcp-build-1',
      currentArtifactFingerprint: 'worker-build-2',
      compatibleUpdateAvailable: true,
      initializationCompatibility: {
        mode: 'legacy_fingerprint_gate',
        loadedArtifactFingerprint: 'worker-build-2',
      },
    });
  });

  it('still rejects a real worker protocol mismatch', () => {
    expect(() =>
      negotiateWorkerInitialization(
        {
          protocolVersion: 4,
          mcpVersion: '0.5.1',
          mcpBuildFingerprint: 'mcp-build-1',
        },
        workerRuntime(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'MCP_RESTART_REQUIRED' }));
  });
});
