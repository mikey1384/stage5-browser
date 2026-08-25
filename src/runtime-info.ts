import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Stage5BrowserError } from './errors.js';

export const STAGE5_BROWSER_VERSION = '0.6.3';
export const WORKER_PROTOCOL_VERSION = 5;
export const TOOL_CATALOG_VERSION = 5;
export const MCP_TOOL_COUNT = 23;

export type RuntimeComponent = 'mcp' | 'worker';
export type RuntimeRestartReason =
  | 'runtime_artifact_changed'
  | 'runtime_artifact_unreadable'
  | 'tool_catalog_changed'
  | 'worker_protocol_changed';

export interface RuntimeBuildStamp {
  version: string;
  buildId: string;
  builtAt: string;
  workerProtocolVersion: number;
  toolCatalogVersion: number;
  toolCount: number;
}

export interface RuntimeProcessInfo {
  component: RuntimeComponent;
  version: string;
  protocolVersion: number;
  processId: number;
  startedAt: string;
  buildModifiedAt: string;
  artifactFingerprint: string;
  currentArtifactFingerprint: string | null;
  currentVersion: string | null;
  currentProtocolVersion: number | null;
  currentToolCatalogVersion: number | null;
  compatibleUpdateAvailable: boolean;
  restartRequired: boolean;
  restartReason: RuntimeRestartReason | null;
  suggestedAction: string | null;
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
      processId: this.processId,
      startedAt: this.startedAt,
      buildModifiedAt: this.buildModifiedAt,
      artifactFingerprint: this.loadedFingerprint,
      currentArtifactFingerprint: currentFingerprint,
      currentVersion: currentBuild?.version ?? null,
      currentProtocolVersion: currentBuild?.workerProtocolVersion ?? null,
      currentToolCatalogVersion: currentBuild?.toolCatalogVersion ?? null,
      compatibleUpdateAvailable,
      restartRequired,
      restartReason,
      suggestedAction: restartRequired
        ? this.component === 'mcp'
          ? 'Reconnect the MCP host so it reloads the changed Stage5 Browser tool or worker protocol contract.'
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
        ? 'The Stage5 Browser tool or worker protocol contract changed after this MCP process started.'
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
