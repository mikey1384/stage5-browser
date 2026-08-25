import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import {
  LoungeStoreError,
  type LoungeAckInput,
  type LoungeAckResult,
  type LoungeClaimInboxInput,
  type LoungeClaimInboxResult,
  type LoungeCloseSessionInput,
  type LoungeCloseSessionResult,
  type LoungeHeartbeatInput,
  type LoungeHeartbeatResult,
  type LoungeJoinInput,
  type LoungeJoinResult,
  type LoungeSendInput,
  type LoungeSendResult,
  type LoungeStatusInput,
  type LoungeStatusResult,
  type LoungeStoreOperation,
  type LoungeStoreRequest,
  type LoungeStoreResponse,
} from './lounge-types.js';

export interface LoungeStoreClientOptions {
  databasePath: string;
  workerUrl?: URL;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_STORE_REQUEST_TIMEOUT_MS = 7_000;

function defaultWorkerUrl(): URL {
  const adjacentBuild = new URL('./lounge-store-worker.js', import.meta.url);
  if (existsSync(fileURLToPath(adjacentBuild))) {
    return adjacentBuild;
  }
  return new URL('../dist/lounge-store-worker.js', import.meta.url);
}

export class LoungeStoreClient {
  private readonly worker: Worker;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly exited: Promise<number>;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: LoungeStoreClientOptions) {
    if (!path.isAbsolute(options.databasePath)) {
      throw new LoungeStoreError(
        'INVALID_ARGUMENT',
        'The Lounge database path must be absolute.',
      );
    }
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_STORE_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 100) {
      throw new LoungeStoreError(
        'INVALID_ARGUMENT',
        'The Lounge store request timeout must be an integer of at least 100 ms.',
      );
    }
    this.worker = new Worker(options.workerUrl ?? defaultWorkerUrl(), {
      workerData: {
        stage5LoungeStoreWorker: true,
        databasePath: options.databasePath,
      },
    });
    this.exited = new Promise<number>((resolve) => {
      this.worker.once('exit', (code) => {
        this.closed = true;
        const error = new LoungeStoreError(
          'LOUNGE_STORE_DISCONNECTED',
          'The Lounge store worker disconnected.',
          { exitCode: code },
        );
        this.rejectAllPending(error);
        resolve(code);
      });
    });
    this.worker.on('message', (response: LoungeStoreResponse) => {
      const pending = this.pending.get(response.id);
      if (pending === undefined) {
        return;
      }
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.ok) {
        pending.resolve(response.result);
      } else {
        pending.reject(
          new LoungeStoreError(
            response.error.code,
            response.error.message,
            response.error.details,
          ),
        );
      }
    });
    this.worker.once('error', (error: unknown) => {
      const wrapped = new LoungeStoreError(
        'LOUNGE_STORE_DISCONNECTED',
        'The Lounge store worker failed.',
        { causeName: error instanceof Error ? error.name : 'Error' },
      );
      this.closed = true;
      this.rejectAllPending(wrapped);
    });
  }

  join(input: LoungeJoinInput): Promise<LoungeJoinResult> {
    return this.request('join', input);
  }

  heartbeat(input: LoungeHeartbeatInput): Promise<LoungeHeartbeatResult> {
    return this.request('heartbeat', input);
  }

  send(input: LoungeSendInput): Promise<LoungeSendResult> {
    return this.request('send', input);
  }

  claimInbox(input: LoungeClaimInboxInput): Promise<LoungeClaimInboxResult> {
    return this.request('claimInbox', input);
  }

  ack(input: LoungeAckInput): Promise<LoungeAckResult> {
    return this.request('ack', input);
  }

  status(input: LoungeStatusInput): Promise<LoungeStatusResult> {
    return this.request('status', input);
  }

  closeSession(input: LoungeCloseSessionInput): Promise<LoungeCloseSessionResult> {
    return this.request('closeSession', input);
  }

  close(): Promise<void> {
    if (this.closePromise !== null) {
      return this.closePromise;
    }
    if (this.closed) {
      return this.exited.then(() => undefined);
    }
    this.closePromise = (async () => {
      try {
        await this.request<{ closed: boolean }>('close', {});
        await this.exited;
      } finally {
        this.closed = true;
      }
    })();
    return this.closePromise;
  }

  private request<T>(
    operation: LoungeStoreOperation,
    input: LoungeStoreRequest['input'],
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new LoungeStoreError(
          'LOUNGE_STORE_DISCONNECTED',
          'The Lounge store worker is closed.',
        ),
      );
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        this.closed = true;
        const timeout = new LoungeStoreError(
          'LOUNGE_STORE_TIMEOUT',
          'The Lounge store did not complete its bounded operation in time.',
          { operation },
        );
        pending.reject(timeout);
        this.rejectAllPending(timeout);
        void this.worker.terminate();
      }, this.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
        timer,
      });
      const request = { id, operation, input } as LoungeStoreRequest;
      try {
        this.worker.postMessage(request);
      } catch (error) {
        const pending = this.pending.get(id);
        if (pending !== undefined) clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error('Failed to contact Lounge store worker.'));
      }
    });
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
