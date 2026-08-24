import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_BROWSER_PRODUCTS, type BrowserProduct } from './browser-provider.js';
import type { Stage5BrowserConfig } from './config.js';
import {
  Stage5BrowserError,
  serializeUnknownError,
  type SerializedStage5BrowserError,
} from './errors.js';
import { OperationJournal, type OperationOutcome } from './operation-journal.js';
import type {
  BrowserCommandInput,
  BrowserCommandName,
  BrowserCommandOutput,
  BrowserStatus,
  BrowserWorkerRequest,
  BrowserWorkerResponse,
} from './protocol.js';
import { SerialQueue } from './serial-queue.js';

export type RecoveryOutcome = 'not_needed' | 'succeeded' | 'failed';

export interface SupervisedResult<T> {
  operationId: string;
  result: T;
  recovery: RecoveryOutcome;
}

export interface RecoveryResult {
  operationId: string;
  recovery: Exclude<RecoveryOutcome, 'not_needed'>;
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
  private readonly pending = new Map<string, PendingRequest>();
  private child: ChildProcess | undefined;
  private selectedBrowser: BrowserProduct;
  private lastKnownUrl: string | null = null;
  private closing = false;

  constructor(
    private readonly config: Stage5BrowserConfig,
    options: BrowserSupervisorOptions = {},
  ) {
    this.workerUrl = options.workerUrl ?? new URL('./browser-worker.js', import.meta.url);
    this.environment = options.environment ?? process.env;
    this.journal = new OperationJournal(config.artifactsDir);
    this.selectedBrowser = config.browser;
  }

  get pendingOperationCount(): number {
    return this.queue.pendingCount;
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
        await this.ensureWorker();
        const result = await this.request(command, payload, hardTimeoutMs);
        this.captureSelectedBrowser(result);
        this.captureLastKnownUrl(result);
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
        await this.appendJournal({
          operationId,
          command: 'recover',
          startedAt,
          durationMs: Date.now() - startedAtMs,
          outcome: 'succeeded',
          recovery: 'succeeded',
          ...(this.lastKnownUrl === null ? {} : { currentUrl: this.lastKnownUrl }),
        });
        return { operationId, recovery: 'succeeded', reopenedUrl, status };
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
          ...(this.lastKnownUrl === null ? {} : { currentUrl: this.lastKnownUrl }),
        });
        throw new SupervisedOperationError(serialized, operationId, 'failed');
      }
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.queue.run(async () => this.terminateWorker());
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
      await this.request(
        'initialize',
        { config: this.config, browser: this.selectedBrowser },
        this.config.workerStartupTimeoutMs,
      );
    } catch (error) {
      await this.terminateWorker(child);
      const serialized = serializeUnknownError(error);
      throw new Stage5BrowserError('WORKER_START_FAILED', 'The browser worker did not initialize.', {
        recoverable: true,
        details: { causeCode: serialized.code },
        cause: error,
      });
    }
  }

  private async replaceWorker(): Promise<void> {
    await this.terminateWorker();
    await this.ensureWorker();
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

  private async terminateWorker(specificChild?: ChildProcess): Promise<void> {
    const child = specificChild ?? this.child;
    if (child === undefined) {
      return;
    }
    if (this.child === child) {
      this.child = undefined;
    }
    this.handleWorkerFailure(child);

    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    this.signalProcessTree(child, 'SIGTERM');
    const exitedGracefully = await this.waitForExit(child, this.config.workerShutdownGraceMs);
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

  private isBrowserProduct(value: string): value is BrowserProduct {
    return (SUPPORTED_BROWSER_PRODUCTS as readonly string[]).includes(value);
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
