import { randomUUID } from 'node:crypto';

import { Stage5BrowserError, type SerializedStage5BrowserError } from '../errors.js';
import { OperationJournal, type OperationJournalRecord } from '../operation-journal.js';
import type { LiveOperationRecord, OperationPhase, OperationStatusResult } from './types.js';

const MAX_MEMORY_RECORDS = 200;
const TERMINAL_RETENTION_MS = 15 * 60_000;
const RESERVATION_RETENTION_MS = 5 * 60_000;

function emptyTiming(queuedAtMs: number) {
  return {
    queuedAtMs,
    workerRequestAtMs: null,
    workerResponseAtMs: null,
    terminalAtMs: null,
    persistedAtMs: null,
    responseCreatedAtMs: null,
  };
}

export class OperationRegistry {
  private readonly records = new Map<string, LiveOperationRecord>();
  private readonly durableRecords = new Map<string, OperationJournalRecord>();
  private readonly journal: OperationJournal;

  constructor(artifactsDir: string, private readonly now: () => number = Date.now) {
    this.journal = new OperationJournal(artifactsDir);
  }

  reserve(command: string): OperationStatusResult {
    this.prune();
    const operationId = randomUUID();
    const nowMs = this.now();
    const record: LiveOperationRecord = {
      operationId,
      command,
      phase: 'reserved',
      startedAt: new Date(nowMs).toISOString(),
      updatedAtMs: nowMs,
      timing: emptyTiming(nowMs),
      outcome: null,
      recovery: null,
      error: null,
      result: undefined,
      hasResult: false,
    };
    this.records.set(operationId, record);
    return this.publicStatus(record, false);
  }

  begin(command: string, requestedOperationId?: string): LiveOperationRecord {
    this.prune();
    const nowMs = this.now();
    if (requestedOperationId !== undefined) {
      const reserved = this.records.get(requestedOperationId);
      if (reserved === undefined || reserved.phase !== 'reserved' || reserved.command !== command) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The requested operation reservation is unavailable.', {
          recoverable: true,
          details: {
            reason: 'operation_reservation_unavailable',
            operationId: requestedOperationId,
            suggestedAction: 'Reserve one fresh operation ID for the exact command before dispatch. Do not reuse a terminal or mismatched reservation.',
          },
        });
      }
      reserved.phase = 'queued';
      reserved.updatedAtMs = nowMs;
      reserved.timing.queuedAtMs = nowMs;
      return reserved;
    }

    const operationId = randomUUID();
    const record: LiveOperationRecord = {
      operationId,
      command,
      phase: 'queued',
      startedAt: new Date(nowMs).toISOString(),
      updatedAtMs: nowMs,
      timing: emptyTiming(nowMs),
      outcome: null,
      recovery: null,
      error: null,
      result: undefined,
      hasResult: false,
    };
    this.records.set(operationId, record);
    return record;
  }

  transition(operationId: string, phase: OperationPhase): void {
    const record = this.require(operationId);
    const nowMs = this.now();
    record.phase = phase;
    record.updatedAtMs = nowMs;
    if (phase === 'worker_request_sent') record.timing.workerRequestAtMs = nowMs;
    if (phase === 'worker_result_received') record.timing.workerResponseAtMs = nowMs;
    if (phase === 'persistence_complete') record.timing.persistedAtMs = nowMs;
    if (phase === 'response_created') record.timing.responseCreatedAtMs = nowMs;
  }

  succeed(operationId: string, result: unknown, recovery: OperationJournalRecord['recovery']): void {
    const record = this.require(operationId);
    const nowMs = this.now();
    record.phase = 'terminal_result_created';
    record.updatedAtMs = nowMs;
    record.timing.terminalAtMs = nowMs;
    record.outcome = 'succeeded';
    record.recovery = recovery;
    record.result = result;
    record.hasResult = true;
  }

  fail(
    operationId: string,
    error: SerializedStage5BrowserError,
    recovery: OperationJournalRecord['recovery'],
  ): void {
    const record = this.require(operationId);
    const nowMs = this.now();
    record.phase = 'terminal_result_created';
    record.updatedAtMs = nowMs;
    record.timing.terminalAtMs = nowMs;
    record.outcome = error.code === 'OPERATION_TIMEOUT' ? 'timed_out' : 'failed';
    record.recovery = recovery;
    record.error = error;
  }

  async markResponseCreated(operationId: string): Promise<void> {
    const record = this.records.get(operationId);
    if (record === undefined || record.outcome === null) return;
    this.transition(operationId, 'response_created');
    const durable = this.durableRecords.get(operationId);
    if (durable === undefined || durable.timing === undefined) return;
    const updated: OperationJournalRecord = {
      ...durable,
      timing: {
        ...durable.timing,
        responseCreatedAtMs: record.timing.responseCreatedAtMs,
      },
    };
    await this.journal.append(updated);
    this.durableRecords.set(operationId, updated);
  }

  phase(operationId: string): OperationPhase | null {
    return this.records.get(operationId)?.phase ?? null;
  }

  timing(operationId: string) {
    const record = this.require(operationId);
    return { ...record.timing };
  }

  async persist(record: OperationJournalRecord): Promise<void> {
    const live = this.records.get(record.operationId);
    const persistedAtMs = this.now();
    const durable: OperationJournalRecord = record.timing === undefined
      ? record
      : {
        ...record,
        timing: { ...record.timing, persistedAtMs },
      };
    await this.journal.append(durable);
    this.durableRecords.set(record.operationId, durable);
    if (live !== undefined) {
      live.timing.persistedAtMs = persistedAtMs;
      live.phase = 'persistence_complete';
      live.updatedAtMs = this.now();
    }
  }

  async status(operationId: string, includeResult = false): Promise<OperationStatusResult | null> {
    this.prune();
    const live = this.records.get(operationId);
    if (live !== undefined) return this.publicStatus(live, includeResult);
    const durable = await this.journal.find(operationId);
    if (durable === null) return null;
    return {
      operationId: durable.operationId,
      command: durable.command,
      phase: 'durable_terminal',
      source: 'durable',
      startedAt: durable.startedAt,
      updatedAtMs: null,
      timing: {
        queuedAtMs: durable.timing?.queuedAtMs ?? Date.parse(durable.startedAt),
        workerRequestAtMs: durable.timing?.workerRequestAtMs ?? null,
        workerResponseAtMs: durable.timing?.workerResponseAtMs ?? null,
        terminalAtMs: durable.timing?.terminalAtMs ?? null,
        persistedAtMs: durable.timing?.persistedAtMs ?? null,
        responseCreatedAtMs: durable.timing?.responseCreatedAtMs ?? null,
      },
      terminal: true,
      outcome: durable.outcome,
      recovery: durable.recovery,
      error: durable.errorCode === undefined
        ? null
        : { code: durable.errorCode as SerializedStage5BrowserError['code'], message: 'The durable operation failed; full transient details are no longer retained.', recoverable: false },
      resultAvailable: false,
    };
  }

  private publicStatus(record: LiveOperationRecord, includeResult: boolean): OperationStatusResult {
    return {
      operationId: record.operationId,
      command: record.command,
      phase: record.phase,
      source: 'memory',
      startedAt: record.startedAt,
      updatedAtMs: record.updatedAtMs,
      timing: { ...record.timing },
      terminal: record.outcome !== null,
      outcome: record.outcome,
      recovery: record.recovery,
      error: record.error,
      resultAvailable: record.hasResult,
      ...(includeResult && record.hasResult ? { result: record.result } : {}),
    };
  }

  private require(operationId: string): LiveOperationRecord {
    const record = this.records.get(operationId);
    if (record === undefined) {
      throw new Error(`Unknown operation registry entry: ${operationId}`);
    }
    return record;
  }

  private prune(): void {
    const nowMs = this.now();
    for (const [operationId, record] of this.records) {
      const retention = record.phase === 'reserved' ? RESERVATION_RETENTION_MS : TERMINAL_RETENTION_MS;
      if ((record.phase === 'reserved' || record.outcome !== null) && nowMs - record.updatedAtMs > retention) {
        this.records.delete(operationId);
      }
    }
    while (this.records.size > MAX_MEMORY_RECORDS) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }
}
