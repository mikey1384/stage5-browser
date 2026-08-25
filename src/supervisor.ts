import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_BROWSER_PRODUCTS, type BrowserProduct } from './browser-provider.js';
import { profileDirForBrowser, type Stage5BrowserConfig } from './config.js';
import { isLaunchFailureReason } from './diagnostics.js';
import {
  Stage5BrowserError,
  serializeUnknownError,
  type SerializedStage5BrowserError,
} from './errors.js';
import { OperationJournal, type OperationOutcome } from './operation-journal.js';
import { readNativeControlRecord } from './native-control-channel.js';
import type {
  BrowserCommandInput,
  BrowserCommandName,
  BrowserCommandOutput,
  BrowserStatus,
  BrowserWorkerRequest,
  BrowserWorkerResponse,
} from './protocol.js';
import { SerialQueue } from './serial-queue.js';
import {
  STAGE5_BROWSER_VERSION,
  WORKER_PROTOCOL_VERSION,
  type RuntimeProcessInfo,
} from './runtime-info.js';

export type RecoveryOutcome = 'not_needed' | 'succeeded' | 'failed';

export interface SupervisedResult<T> {
  operationId: string;
  result: T;
  recovery: RecoveryOutcome;
}

export interface RecoveryResult {
  operationId: string;
  recovery: Exclude<RecoveryOutcome, 'not_needed'>;
  outcome: 'worker_recovered_browser_running' | 'worker_recovered_browser_stopped';
  workerRecovered: true;
  browserRecovered: boolean;
  reopenedUrl: string | null;
  status: BrowserStatus;
}

interface PendingRequest {
  child: ChildProcess;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (reason: Stage5BrowserError) => void;
}

export interface BrowserSupervisorOptions {
  workerUrl?: URL;
  environment?: NodeJS.ProcessEnv;
  expectedBuildFingerprint?: string;
  runtimeInfoProvider?: () => RuntimeProcessInfo;
}

export class SupervisedOperationError extends Stage5BrowserError {
  readonly operationId: string;
  readonly recovery: RecoveryOutcome;

  constructor(error: SerializedStage5BrowserError, operationId: string, recovery: RecoveryOutcome) {
    super(error.code, error.message, {
      recoverable: error.recoverable,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
    this.name = 'SupervisedOperationError';
    this.operationId = operationId;
    this.recovery = recovery;
  }
}

export class BrowserSupervisor {
  private readonly queue = new SerialQueue();
  private readonly journal: OperationJournal;
  private readonly workerUrl: URL;
  private readonly environment: NodeJS.ProcessEnv;
  private expectedBuildFingerprint: string | null;
  private readonly runtimeInfoProvider: (() => RuntimeProcessInfo) | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private child: ChildProcess | undefined;
  private workerRuntime: RuntimeProcessInfo | null = null;
  private selectedBrowser: BrowserProduct;
  private lastKnownUrl: string | null = null;
  private browserWasConnected = false;
  private humanAuthenticationInProgress = false;
  private closing = false;

  constructor(
    private readonly config: Stage5BrowserConfig,
    options: BrowserSupervisorOptions = {},
  ) {
    this.workerUrl = options.workerUrl ?? new URL('./browser-worker.js', import.meta.url);
    this.environment = options.environment ?? process.env;
    this.expectedBuildFingerprint = options.expectedBuildFingerprint ?? null;
    this.runtimeInfoProvider = options.runtimeInfoProvider;
    this.journal = new OperationJournal(config.artifactsDir);
    this.selectedBrowser = config.browser;
  }

  get pendingOperationCount(): number {
    return this.queue.pendingCount;
  }

  get workerRuntimeInfo(): RuntimeProcessInfo | null {
    return this.workerRuntime;
  }

  async execute<Name extends BrowserCommandName>(
    command: Name,
    payload: BrowserCommandInput<Name>,
    hardTimeoutMs = this.deadlineFor(command, payload),
  ): Promise<SupervisedResult<BrowserCommandOutput<Name>>> {
    if (command === 'initialize') {
      throw new Stage5BrowserError('OPERATION_FAILED', 'Worker initialization is supervisor-owned.');
    }

    return this.queue.run(async () => {
      const operationId = randomUUID();
      const startedAtMs = Date.now();
      const startedAt = new Date(startedAtMs).toISOString();

      try {
        await this.reloadCompatibleRuntimeIfNeeded();
        await this.ensureWorker();
        const result = await this.request(command, payload, hardTimeoutMs);
        this.captureSelectedBrowser(result);
        this.captureLastKnownUrl(result);
        this.captureBrowserConnection(result);
        this.captureAuthenticationState(result);
        await this.appendJournal({
          operationId,
          command,
          startedAt,
          durationMs: Date.now() - startedAtMs,
          outcome: 'succeeded',
          recovery: 'not_needed',
          ...(this.lastKnownUrl === null ? {} : { currentUrl: this.lastKnownUrl }),
        });
        return { operationId, result, recovery: 'not_needed' };
      } catch (error) {
        const serialized = serializeUnknownError(error);
        let recovery: RecoveryOutcome = 'not_needed';

        if (this.requiresHardRecovery(serialized.code)) {
          try {
            await this.replaceWorker();
            recovery = 'succeeded';
          } catch {
            recovery = 'failed';
          }
        }

        const outcome: OperationOutcome = serialized.code === 'OPERATION_TIMEOUT' ? 'timed_out' : 'failed';
        await this.appendJournal({
          operationId,
          command,
          startedAt,
          durationMs: Date.now() - startedAtMs,
          outcome,
          recovery,
          errorCode: serialized.code,
          ...this.safeJournalDiagnostic(serialized),
          ...(this.lastKnownUrl === null ? {} : { currentUrl: this.lastKnownUrl }),
        });
        throw new SupervisedOperationError(serialized, operationId, recovery);
      }
    });
  }

  async forceRecover(reopenLastUrl: boolean): Promise<RecoveryResult> {
    return this.queue.run(async () => {
      const operationId = randomUUID();
      const startedAtMs = Date.now();
      const startedAt = new Date(startedAtMs).toISOString();
      const candidateUrl = reopenLastUrl ? this.lastKnownUrl : null;

      if (this.humanAuthenticationInProgress) {
        const serialized = new Stage5BrowserError(
          'AUTH_HANDOFF_REQUIRED',
          'Worker recovery is disabled while the private human authentication browser owns the profile.',
          {
            recoverable: true,
            details: {
              reason: 'human_authentication_in_progress',
              suggestedAction: 'Finish authentication and follow the exact backend-specific instruction returned by browser_request_login_handoff, then call browser_resume_after_login. Chromium-family browsers stay open for same-process attachment; Firefox exits normally. Do not recover or force-close the browser.',
            },
          },
        ).serialize();
        await this.appendJournal({
          operationId,
          command: 'recover',
          startedAt,
          durationMs: Date.now() - startedAtMs,
          outcome: 'failed',
          recovery: 'not_needed',
          errorCode: serialized.code,
          browser: this.selectedBrowser,
          ...(this.lastKnownUrl === null ? {} : { currentUrl: this.lastKnownUrl }),
        });
        throw new SupervisedOperationError(serialized, operationId, 'not_needed');
      }

      try {
        await this.replaceWorker();
        let reopenedUrl: string | null = null;
        if (candidateUrl !== null && candidateUrl !== 'about:blank') {
          const opened = await this.request(
            'open',
            { url: candidateUrl, newTab: false, timeoutMs: this.config.navigationTimeoutMs },
            this.config.navigationTimeoutMs + 2_000,
          );
          reopenedUrl = opened.page.url;
          this.lastKnownUrl = reopenedUrl;
        }
        const status = await this.request('status', {}, this.config.operationTimeoutMs);
        const browserRecovered = status.browserConnected;
        const outcome = browserRecovered
          ? 'worker_recovered_browser_running'
          : 'worker_recovered_browser_stopped';
        await this.appendJournal({
          operationId,
          command: 'recover',
          startedAt,
          durationMs: Date.now() - startedAtMs,
          outcome: 'succeeded',
          recovery: 'succeeded',
          browser: status.browser,
          browserState: status.state,
          ...(this.lastKnownUrl === null ? {} : { currentUrl: this.lastKnownUrl }),
        });
        return {
          operationId,
          recovery: 'succeeded',
          outcome,
          workerRecovered: true,
          browserRecovered,
          reopenedUrl,
          status,
        };
      } catch (error) {
        const serialized = serializeUnknownError(error);
        await this.terminateWorker();
        await this.appendJournal({
          operationId,
          command: 'recover',
          startedAt,
          durationMs: Date.now() - startedAtMs,
          outcome: 'failed',
          recovery: 'failed',
          errorCode: serialized.code,
          ...this.safeJournalDiagnostic(serialized),
          ...(this.lastKnownUrl === null ? {} : { currentUrl: this.lastKnownUrl }),
        });
        throw new SupervisedOperationError(serialized, operationId, 'failed');
      }
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.queue.run(async () => this.terminateWorker(undefined, 'graceful'));
  }

  private async ensureWorker(): Promise<void> {
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
  }

  private async replaceWorker(): Promise<void> {
    await this.terminateWorker();
    this.adoptCompatibleRuntimeFingerprint();
    await this.ensureWorker();
  }

  private adoptCompatibleRuntimeFingerprint(): void {
    const runtime = this.runtimeInfoProvider?.();
    if (
      runtime !== undefined &&
      !runtime.restartRequired &&
      runtime.compatibleUpdateAvailable &&
      runtime.currentArtifactFingerprint !== null
    ) {
      this.expectedBuildFingerprint = runtime.currentArtifactFingerprint;
    }
  }

  private async reloadCompatibleRuntimeIfNeeded(): Promise<void> {
    const runtime = this.runtimeInfoProvider?.();
    if (
      runtime === undefined ||
      runtime.restartRequired ||
      !runtime.compatibleUpdateAvailable ||
      runtime.currentArtifactFingerprint === null ||
      runtime.currentArtifactFingerprint === this.expectedBuildFingerprint
    ) {
      return;
    }

    if (this.humanAuthenticationInProgress) {
      return;
    }

    // A normal Playwright context cannot be reattached after shutdown. Reopening
    // only its last URL loses unsaved DOM/form state and exact tab identity, so a
    // compatible update is deferred until explicit stop. A proven native-CDP
    // browser is the sole safe exception: the browser process stays alive while
    // the worker reconnects to its exact persistent context.
    const nativeControl = this.browserWasConnected
      ? await readNativeControlRecord(
        profileDirForBrowser(this.config, this.selectedBrowser),
        this.selectedBrowser,
      )
      : null;
    if (this.browserWasConnected && nativeControl?.state !== 'controlled') return;

    await this.terminateWorker(undefined, 'graceful');
    this.expectedBuildFingerprint = runtime.currentArtifactFingerprint;
    await this.ensureWorker();
    if (nativeControl !== null) {
      const status = await this.request('start', {}, this.config.workerStartupTimeoutMs);
      this.captureLastKnownUrl(status);
      this.captureBrowserConnection(status);
    }
  }

  private request<Name extends BrowserCommandName>(
    command: Name,
    payload: BrowserCommandInput<Name>,
    timeoutMs: number,
  ): Promise<BrowserCommandOutput<Name>> {
    const child = this.child;
    if (child === undefined || !child.connected || child.exitCode !== null) {
      return Promise.reject(
        new Stage5BrowserError('WORKER_DISCONNECTED', 'The browser worker is not connected.', {
          recoverable: true,
        }),
      );
    }

    const id = randomUUID();
    const message = { kind: 'request', id, command, payload } as BrowserWorkerRequest<Name>;

    return new Promise<BrowserCommandOutput<Name>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (entry === undefined) {
          return;
        }
        this.pending.delete(id);
        reject(
          new Stage5BrowserError('OPERATION_TIMEOUT', `The ${command} operation exceeded its hard deadline.`, {
            recoverable: true,
            details: { timeoutMs },
          }),
        );
      }, timeoutMs);

      this.pending.set(id, {
        child,
        timer,
        resolve: (value) => resolve(value as BrowserCommandOutput<Name>),
        reject,
      });

      child.send(message, (error) => {
        if (error === null) {
          return;
        }
        const entry = this.pending.get(id);
        if (entry === undefined) {
          return;
        }
        this.pending.delete(id);
        clearTimeout(entry.timer);
        reject(
          new Stage5BrowserError('WORKER_DISCONNECTED', 'The operation could not be sent to the browser worker.', {
            recoverable: true,
            cause: error,
          }),
        );
      });
    });
  }

  private handleResponse(child: ChildProcess, message: unknown): void {
    if (!isWorkerResponse(message)) {
      return;
    }
    const entry = this.pending.get(message.id);
    if (entry === undefined || entry.child !== child) {
      return;
    }

    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve(message.result);
      return;
    }
    entry.reject(
      new Stage5BrowserError(message.error.code, message.error.message, {
        recoverable: message.error.recoverable,
        ...(message.error.details === undefined ? {} : { details: message.error.details }),
      }),
    );
  }

  private handleWorkerFailure(child: ChildProcess, cause?: unknown): void {
    if (this.child === child) {
      this.child = undefined;
      this.workerRuntime = null;
    }

    for (const [id, entry] of this.pending) {
      if (entry.child !== child) {
        continue;
      }
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(
        new Stage5BrowserError('WORKER_DISCONNECTED', 'The browser worker exited during an operation.', {
          recoverable: true,
          cause,
        }),
      );
    }
  }

  private async terminateWorker(
    specificChild?: ChildProcess,
    mode: 'graceful' | 'hard' = 'hard',
  ): Promise<void> {
    const child = specificChild ?? this.child;
    if (child === undefined) {
      return;
    }
    if (this.child === child) {
      this.child = undefined;
      this.workerRuntime = null;
    }
    this.handleWorkerFailure(child);

    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    this.signalProcessTree(child, 'SIGTERM');
    const gracefulDeadlineMs = mode === 'graceful'
      ? Math.max(this.config.workerShutdownGraceMs, 10_000)
      : this.config.workerShutdownGraceMs;
    const exitedGracefully = await this.waitForExit(child, gracefulDeadlineMs);
    if (!exitedGracefully) {
      this.signalProcessTree(child, 'SIGKILL');
      await this.waitForExit(child, this.config.workerShutdownGraceMs);
    }
  }

  private signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== 'win32' && child.pid !== undefined) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error;
      }
    }
  }

  private async waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.off('exit', onExit);
        resolve(false);
      }, timeoutMs);
      child.once('exit', onExit);
    });
  }

  private workerEnvironment(): NodeJS.ProcessEnv {
    const allowed = [
      'DISPLAY',
      'HOME',
      'LANG',
      'LC_ALL',
      'LOCALAPPDATA',
      'PATH',
      'PLAYWRIGHT_BROWSERS_PATH',
      'STAGE5_BROWSER_TEST_BUILD_FINGERPRINT',
      'STAGE5_BROWSER_TEST_DISCONNECT_ON_RESUME_PATH',
      'STAGE5_BROWSER_TEST_SHUTDOWN_DELAY_MS',
      'STAGE5_BROWSER_TEST_MODE',
      'TMPDIR',
      'USERPROFILE',
      'WAYLAND_DISPLAY',
      'XAUTHORITY',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_RUNTIME_DIR',
    ] as const;
    return Object.fromEntries(
      allowed.flatMap((key) => {
        const value = this.environment[key];
        return value === undefined ? [] : [[key, value]];
      }),
    );
  }

  private deadlineFor<Name extends BrowserCommandName>(
    command: Name,
    payload: BrowserCommandInput<Name>,
  ): number {
    if (command === 'initialize') {
      return this.config.workerStartupTimeoutMs;
    }
    if ('timeoutMs' in payload && typeof payload.timeoutMs === 'number') {
      return payload.timeoutMs + 2_000;
    }
    return this.config.operationTimeoutMs;
  }

  private requiresHardRecovery(code: SerializedStage5BrowserError['code']): boolean {
    return code === 'OPERATION_TIMEOUT' || code === 'WORKER_DISCONNECTED' || code === 'WORKER_START_FAILED';
  }

  private captureLastKnownUrl(result: unknown): void {
    if (typeof result !== 'object' || result === null) {
      return;
    }
    const candidate = result as {
      lastKnownUrl?: unknown;
      page?: { url?: unknown };
      pages?: Array<{ url?: unknown }>;
    };
    if (typeof candidate.page?.url === 'string') {
      this.lastKnownUrl = candidate.page.url;
      return;
    }
    if (candidate.lastKnownUrl === null || typeof candidate.lastKnownUrl === 'string') {
      this.lastKnownUrl = candidate.lastKnownUrl;
      return;
    }
    const finalPage = candidate.pages?.at(-1);
    if (typeof finalPage?.url === 'string') {
      this.lastKnownUrl = finalPage.url;
    }
  }

  private captureSelectedBrowser(result: unknown): void {
    if (typeof result !== 'object' || result === null) {
      return;
    }
    const browser = (result as { browser?: unknown }).browser;
    if (typeof browser === 'string' && this.isBrowserProduct(browser)) {
      this.selectedBrowser = browser;
    }
  }

  private captureBrowserConnection(result: unknown): void {
    if (typeof result !== 'object' || result === null) {
      return;
    }
    const connected = (result as { browserConnected?: unknown }).browserConnected;
    if (typeof connected === 'boolean') {
      this.browserWasConnected = connected;
      return;
    }
    if ('page' in result) {
      this.browserWasConnected = true;
    }
  }

  private captureAuthenticationState(result: unknown): void {
    if (typeof result !== 'object' || result === null) {
      return;
    }
    const candidate = result as { controlMode?: unknown; state?: unknown };
    if (typeof candidate.controlMode !== 'string' || typeof candidate.state !== 'string') {
      return;
    }
    this.humanAuthenticationInProgress =
      candidate.controlMode === 'human_bootstrap' && candidate.state === 'awaiting_user';
  }

  private isBrowserProduct(value: string): value is BrowserProduct {
    return (SUPPORTED_BROWSER_PRODUCTS as readonly string[]).includes(value);
  }

  private safeJournalDiagnostic(
    error: SerializedStage5BrowserError,
  ): { diagnosticCause?: import('./diagnostics.js').LaunchFailureReason; browser?: BrowserProduct } {
    const reason = error.details?.reason;
    const browser = error.details?.browser;
    return {
      ...(isLaunchFailureReason(reason) ? { diagnosticCause: reason } : {}),
      ...(typeof browser === 'string' && this.isBrowserProduct(browser) ? { browser } : {}),
    };
  }

  private async appendJournal(record: Parameters<OperationJournal['append']>[0]): Promise<void> {
    try {
      await this.journal.append(record);
    } catch {
      // Diagnostics must never change the terminal outcome of a browser command.
    }
  }
}

function isWorkerResponse(message: unknown): message is BrowserWorkerResponse {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  const candidate = message as Partial<BrowserWorkerResponse>;
  return candidate.kind === 'response' && typeof candidate.id === 'string' && typeof candidate.ok === 'boolean';
}
