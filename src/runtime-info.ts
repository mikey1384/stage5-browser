import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Stage5BrowserError } from './errors.js';

export const STAGE5_BROWSER_VERSION = '0.2.0';
export const WORKER_PROTOCOL_VERSION = 2;
export const TOOL_CATALOG_VERSION = 2;
export const MCP_TOOL_COUNT = 15;

export type RuntimeComponent = 'mcp' | 'worker';
export type RuntimeRestartReason = 'runtime_artifact_changed' | 'runtime_artifact_unreadable';

export interface RuntimeProcessInfo {
  component: RuntimeComponent;
  version: string;
  protocolVersion: number;
  processId: number;
  startedAt: string;
  buildModifiedAt: string;
  artifactFingerprint: string;
  currentArtifactFingerprint: string | null;
  restartRequired: boolean;
  restartReason: RuntimeRestartReason | null;
  suggestedAction: string | null;
}

function fingerprint(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex').slice(0, 16);
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
    this.startedAt = startedAt.toISOString();
    this.buildModifiedAt = statSync(this.artifactPath).mtime.toISOString();
  }

  inspect(): RuntimeProcessInfo {
    let currentFingerprint: string | null = null;
    let restartReason: RuntimeRestartReason | null = null;
    try {
      currentFingerprint = fingerprint(this.artifactPath);
      if (currentFingerprint !== this.loadedFingerprint) {
        restartReason = 'runtime_artifact_changed';
      }
    } catch {
      restartReason = 'runtime_artifact_unreadable';
    }

    const restartRequired = restartReason !== null;
    return {
      component: this.component,
      version: STAGE5_BROWSER_VERSION,
      protocolVersion: WORKER_PROTOCOL_VERSION,
      processId: this.processId,
      startedAt: this.startedAt,
      buildModifiedAt: this.buildModifiedAt,
      artifactFingerprint: this.loadedFingerprint,
      currentArtifactFingerprint: currentFingerprint,
      restartRequired,
      restartReason,
      suggestedAction: restartRequired
        ? 'Restart the MCP host, then resume the agent session so it reloads the current Stage5 Browser build and tool catalog.'
        : null,
    };
  }

  assertCurrent(): void {
    const runtime = this.inspect();
    if (!runtime.restartRequired) {
      return;
    }
    throw new Stage5BrowserError(
      'MCP_RESTART_REQUIRED',
      'The Stage5 Browser files changed after this MCP process started. Worker recovery cannot refresh the MCP tool catalog.',
      {
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
