import { STAGE5_BROWSER_VERSION, Stage5BrowserError, WORKER_PROTOCOL_VERSION, fileURLToPath, fork, profileDirForBrowser, profileOwnershipRetainsPrivateHandoff, readNativeControlRecord, readProfileOwnershipLease, serializeUnknownError } from './dependencies.js';
import type { BrowserSupervisorContext } from './runtime.js';
import type { RuntimeTransition } from './model.js';

export const workerLifecycleOperations = {
  async ensureWorker(): Promise<void> {
    if (this.closing) {
      throw new Stage5BrowserError('WORKER_DISCONNECTED', 'The browser supervisor is shutting down.');
    }

    if (this.child !== undefined && this.child.connected && this.child.exitCode === null) {
      return;
    }

    const child = fork(fileURLToPath(this.workerUrl), [], {
      cwd: process.cwd(),
      detached: process.platform !== 'win32',
      env: this.workerEnvironment(),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.child = child;
    child.on('message', (message: unknown) => this.handleResponse(child, message));
    child.once('error', (error) => this.handleWorkerFailure(child, error));
    child.once('exit', () => this.handleWorkerFailure(child));

    try {
      const initialized = await this.request(
        'initialize',
        {
          config: this.config,
          browser: this.selectedBrowser,
          protocolVersion: WORKER_PROTOCOL_VERSION,
          mcpVersion: STAGE5_BROWSER_VERSION,
          mcpBuildFingerprint: this.expectedBuildFingerprint,
          buildFingerprintPolicy: 'diagnostic_only',
          actionPolicyMode: this.actionPolicyMode,
          contextScope: this.agentContextId === null ? 'connection' : 'durable_agent',
        },
        this.config.workerStartupTimeoutMs,
      );
      if (initialized.runtime.protocolVersion !== WORKER_PROTOCOL_VERSION) {
        throw new Stage5BrowserError(
          'MCP_RESTART_REQUIRED',
          'The browser worker reported an incompatible worker protocol contract.',
          {
            details: {
              reason: 'worker_protocol_mismatch',
              expectedProtocolVersion: WORKER_PROTOCOL_VERSION,
              receivedProtocolVersion: initialized.runtime.protocolVersion,
              mcpVersion: STAGE5_BROWSER_VERSION,
              workerVersion: initialized.runtime.version,
              suggestedAction: 'Reconnect the MCP host so it loads the current Stage5 Browser worker protocol contract.',
            },
          },
        );
      }
      this.expectedBuildFingerprint =
        initialized.runtime.initializationCompatibility?.loadedArtifactFingerprint ??
        initialized.runtime.artifactFingerprint;
      this.workerRuntime = initialized.runtime;
    } catch (error) {
      await this.terminateWorker(child);
      const serialized = serializeUnknownError(error);
      if (serialized.code === 'MCP_RESTART_REQUIRED') {
        throw new Stage5BrowserError(serialized.code, serialized.message, {
          recoverable: serialized.recoverable,
          ...(serialized.details === undefined ? {} : { details: serialized.details }),
        });
      }
      throw new Stage5BrowserError('WORKER_START_FAILED', 'The browser worker did not initialize.', {
        recoverable: true,
        details: { causeCode: serialized.code },
        cause: error,
      });
    }
  },

  async replaceWorker(): Promise<void> {
    await this.terminateWorker();
    this.adoptCompatibleRuntimeFingerprint();
    await this.ensureWorker();
  },

  adoptCompatibleRuntimeFingerprint(): void {
    const runtime = this.runtimeInfoProvider?.();
    if (
      runtime !== undefined &&
      !runtime.restartRequired &&
      runtime.compatibleUpdateAvailable &&
      runtime.currentArtifactFingerprint !== null
    ) {
      this.expectedBuildFingerprint = runtime.currentArtifactFingerprint;
    }
  },

  async reloadCompatibleRuntimeIfNeeded(): Promise<RuntimeTransition | null> {
    const runtime = this.runtimeInfoProvider?.();
    if (
      runtime === undefined ||
      runtime.restartRequired ||
      !runtime.compatibleUpdateAvailable ||
      runtime.currentArtifactFingerprint === null ||
      runtime.currentArtifactFingerprint === this.expectedBuildFingerprint
    ) {
      return null;
    }

    const profileDir = profileDirForBrowser(this.config, this.selectedBrowser);
    const ownershipLease = await readProfileOwnershipLease(profileDir);
    if (
      this.humanAuthenticationInProgress
      || profileOwnershipRetainsPrivateHandoff(ownershipLease)
    ) {
      return null;
    }

    // A normal Playwright context cannot be reattached after shutdown. Reopening
    // only its last URL loses unsaved DOM/form state and exact tab identity, so a
    // compatible update is deferred until explicit stop. A proven native-CDP
    // browser is the sole safe exception: the browser process stays alive while
    // the worker reconnects to its exact persistent context.
    const nativeControl = this.browserWasConnected
      ? await readNativeControlRecord(
        profileDir,
        this.selectedBrowser,
      )
      : null;
    if (this.browserWasConnected && nativeControl?.state !== 'controlled') return null;

    await this.terminateWorker(undefined, 'graceful');
    this.expectedBuildFingerprint = runtime.currentArtifactFingerprint;
    await this.ensureWorker();
    if (nativeControl !== null) {
      const status = await this.request('start', {}, this.config.workerStartupTimeoutMs);
      this.captureLastKnownUrl(status);
      this.captureBrowserConnection(status);
    }
    return {
      kind: 'compatible_worker_replaced',
      allReferencesInvalid: true,
      pageStatePreserved: nativeControl !== null,
      suggestedAction: nativeControl === null
        ? 'Take fresh tab, frame, snapshot, and control observations before the next element action.'
        : 'The exact native browser context was reattached without reloading it; take fresh tab, frame, snapshot, and control observations because worker-owned capabilities were invalidated.',
    };
  },
} satisfies Record<string, unknown> & ThisType<BrowserSupervisorContext>;

export type WorkerLifecycleOperations = typeof workerLifecycleOperations;
