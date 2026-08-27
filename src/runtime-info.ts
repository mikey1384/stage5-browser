import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Stage5BrowserError } from './errors.js';
import { MCP_TOOL_NAMES } from './mcp/tool-names.js';

export const STAGE5_BROWSER_VERSION = '0.15.13';
export const WORKER_PROTOCOL_VERSION = 12;
export const MCP_HOST_BEHAVIOR_VERSION = 4;
export const TOOL_CATALOG_VERSION = 13;
export const MCP_TOOL_COUNT = Object.keys(MCP_TOOL_NAMES).length;

export type RuntimeComponent = 'mcp' | 'worker';
export type RuntimeRestartReason =
  | 'runtime_artifact_changed'
  | 'runtime_artifact_unreadable'
  | 'mcp_host_behavior_changed'
  | 'tool_catalog_changed'
  | 'worker_protocol_changed';

export interface RuntimeBuildStamp {
  version: string;
  buildId: string;
  builtAt: string;
  workerProtocolVersion: number;
  hostBehaviorVersion: number;
  toolCatalogVersion: number;
  toolCount: number;
}

export interface RuntimeProcessInfo {
  component: RuntimeComponent;
  version: string;
  protocolVersion: number;
  hostBehaviorVersion: number;
  processId: number;
  startedAt: string;
  buildModifiedAt: string;
  artifactFingerprint: string;
  currentArtifactFingerprint: string | null;
  currentVersion: string | null;
  currentProtocolVersion: number | null;
  currentHostBehaviorVersion: number | null;
  currentToolCatalogVersion: number | null;
  compatibleUpdateAvailable: boolean;
  restartRequired: boolean;
  restartReason: RuntimeRestartReason | null;
  suggestedAction: string | null;
  initializationCompatibility?: {
    mode: 'legacy_fingerprint_gate';
    loadedArtifactFingerprint: string;
  };
}

export interface WorkerInitializationContract {
  protocolVersion: number;
  mcpVersion: string;
  mcpBuildFingerprint: string | null;
  buildFingerprintPolicy?: 'diagnostic_only';
}

/**
 * Build fingerprints identify exact artifacts; they do not define MCP/worker
 * compatibility. Older MCP hosts incorrectly gated initialization on fingerprint
 * equality. Echo their expected fingerprint for one initialization response so a
 * compatible worker can finish an in-progress private handoff, while retaining the
 * worker's true loaded fingerprint as explicit diagnostic evidence.
 */
export function negotiateWorkerInitialization(
  contract: WorkerInitializationContract,
  workerRuntime: RuntimeProcessInfo,
): RuntimeProcessInfo {
  if (contract.protocolVersion !== WORKER_PROTOCOL_VERSION) {
    throw new Stage5BrowserError(
      'MCP_RESTART_REQUIRED',
      'The MCP server and browser worker use different worker protocol contracts.',
      {
        details: {
          reason: 'worker_protocol_mismatch',
          expectedProtocolVersion: WORKER_PROTOCOL_VERSION,
          receivedProtocolVersion: contract.protocolVersion,
          mcpVersion: contract.mcpVersion,
          workerVersion: STAGE5_BROWSER_VERSION,
          suggestedAction: 'Reconnect the MCP host so it loads the current Stage5 Browser worker protocol contract.',
        },
      },
    );
  }

  const legacyFingerprint = contract.mcpBuildFingerprint;
  if (
    contract.buildFingerprintPolicy === 'diagnostic_only' ||
    legacyFingerprint === null ||
    legacyFingerprint === workerRuntime.artifactFingerprint
  ) {
    return workerRuntime;
  }

  return {
    ...workerRuntime,
    artifactFingerprint: legacyFingerprint,
    compatibleUpdateAvailable: true,
    suggestedAction:
      'No MCP reconnect is needed. Finish the current operation; the next safe worker boundary will adopt the completed identity without discarding connected page state.',
    initializationCompatibility: {
      mode: 'legacy_fingerprint_gate',
      loadedArtifactFingerprint: workerRuntime.artifactFingerprint,
    },
  };
}

function fingerprint(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex').slice(0, 16);
}

function readBuildStamp(filePath: string): RuntimeBuildStamp {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<RuntimeBuildStamp>;
  if (
    typeof parsed.version !== 'string' ||
    typeof parsed.buildId !== 'string' ||
    typeof parsed.builtAt !== 'string' ||
    typeof parsed.workerProtocolVersion !== 'number' ||
    typeof parsed.hostBehaviorVersion !== 'number' ||
    typeof parsed.toolCatalogVersion !== 'number' ||
    typeof parsed.toolCount !== 'number'
  ) {
    throw new Error('Invalid Stage5 Browser build stamp.');
  }
  return parsed as RuntimeBuildStamp;
}

export function buildStampUrlFor(moduleUrl: string | URL): URL {
  const modulePath = fileURLToPath(moduleUrl);
  const directory = path.dirname(modulePath);
  const stampPath =
    path.basename(directory) === 'src'
      ? path.join(directory, '..', 'dist', 'build-stamp.json')
      : path.join(directory, 'build-stamp.json');
  return pathToFileURL(stampPath);
}

export class RuntimeArtifactMonitor {
  private readonly artifactPath: string;
  private readonly loadedFingerprint: string;
  private readonly loadedBuild: RuntimeBuildStamp;
  private readonly startedAt: string;
  private readonly buildModifiedAt: string;

  constructor(
    private readonly component: RuntimeComponent,
    moduleUrl: string | URL,
    startedAt = new Date(),
    private readonly processId = process.pid,
  ) {
    this.artifactPath = fileURLToPath(moduleUrl);
    this.loadedFingerprint = fingerprint(this.artifactPath);
    this.loadedBuild = readBuildStamp(this.artifactPath);
    this.startedAt = startedAt.toISOString();
    this.buildModifiedAt = statSync(this.artifactPath).mtime.toISOString();
  }

  inspect(): RuntimeProcessInfo {
    let currentFingerprint: string | null = null;
    let currentBuild: RuntimeBuildStamp | null = null;
    let restartReason: RuntimeRestartReason | null = null;
    let compatibleUpdateAvailable = false;
    try {
      currentFingerprint = fingerprint(this.artifactPath);
      currentBuild = readBuildStamp(this.artifactPath);
      if (currentFingerprint !== this.loadedFingerprint) {
        if (this.component === 'worker') {
          restartReason = 'runtime_artifact_changed';
        } else if (currentBuild.toolCatalogVersion !== this.loadedBuild.toolCatalogVersion) {
          restartReason = 'tool_catalog_changed';
        } else if (currentBuild.workerProtocolVersion !== this.loadedBuild.workerProtocolVersion) {
          restartReason = 'worker_protocol_changed';
        } else if (currentBuild.hostBehaviorVersion !== this.loadedBuild.hostBehaviorVersion) {
          restartReason = 'mcp_host_behavior_changed';
        } else {
          compatibleUpdateAvailable = true;
        }
      }
    } catch {
      restartReason = 'runtime_artifact_unreadable';
    }

    const restartRequired = restartReason !== null;
    return {
      component: this.component,
      version: this.loadedBuild.version,
      protocolVersion: this.loadedBuild.workerProtocolVersion,
      hostBehaviorVersion: this.loadedBuild.hostBehaviorVersion,
      processId: this.processId,
      startedAt: this.startedAt,
      buildModifiedAt: this.buildModifiedAt,
      artifactFingerprint: this.loadedFingerprint,
      currentArtifactFingerprint: currentFingerprint,
      currentVersion: currentBuild?.version ?? null,
      currentProtocolVersion: currentBuild?.workerProtocolVersion ?? null,
      currentHostBehaviorVersion: currentBuild?.hostBehaviorVersion ?? null,
      currentToolCatalogVersion: currentBuild?.toolCatalogVersion ?? null,
      compatibleUpdateAvailable,
      restartRequired,
      restartReason,
      suggestedAction: restartRequired
        ? this.component === 'mcp'
          ? 'Reconnect the MCP host so it reloads the changed Stage5 Browser tool, worker protocol, or host lifecycle behavior.'
          : 'The Stage5 Browser supervisor must replace this worker before the next operation.'
        : compatibleUpdateAvailable
          ? 'No host restart is needed. Stage5 Browser will load the compatible runtime automatically.'
          : null,
    };
  }

  assertCurrent(): void {
    const runtime = this.inspect();
    if (!runtime.restartRequired) {
      return;
    }
    throw new Stage5BrowserError(
      this.component === 'mcp' ? 'MCP_RESTART_REQUIRED' : 'WORKER_DISCONNECTED',
      this.component === 'mcp'
        ? 'The Stage5 Browser tool, worker protocol, or host lifecycle behavior changed after this MCP process started.'
        : 'The Stage5 Browser worker build changed and must be replaced.',
      {
        recoverable: this.component === 'worker',
        details: {
          reason: runtime.restartReason,
          version: runtime.version,
          protocolVersion: runtime.protocolVersion,
          startedAt: runtime.startedAt,
          buildModifiedAt: runtime.buildModifiedAt,
          suggestedAction: runtime.suggestedAction,
        },
      },
    );
  }
}
