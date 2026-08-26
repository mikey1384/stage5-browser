import { type BrowserCommandInput, type BrowserCommandName, type BrowserCommandOutput, type BrowserWorkerRequest, type ChildProcess, Stage5BrowserError, randomUUID } from './dependencies.js';
import { isWorkerResponse } from './model.js';
import type { BrowserSupervisorContext } from './runtime.js';

export const transportOperations = {
  request<Name extends BrowserCommandName>(
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
  },

  handleResponse(child: ChildProcess, message: unknown): void {
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
  },

  handleWorkerFailure(child: ChildProcess, cause?: unknown): void {
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
  },

  async terminateWorker(
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
  },

  signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
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
  },

  async waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
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
  },

  workerEnvironment(): NodeJS.ProcessEnv {
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
      'STAGE5_BROWSER_TEST_FORM_STATE',
      'STAGE5_BROWSER_TEST_HANG_COMMAND',
      'STAGE5_BROWSER_TEST_HANG_STATUS',
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
  },
} satisfies Record<string, unknown> & ThisType<BrowserSupervisorContext>;

export type TransportOperations = typeof transportOperations;
