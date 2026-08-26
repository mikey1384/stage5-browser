import { appendFile, chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { BrowserProduct } from './browser-provider.js';
import type { LaunchFailureReason } from './diagnostics.js';
import type { BrowserLifecycleState } from './protocol.js';
import { sanitizeUrlForJournal } from './url-policy.js';

export type OperationOutcome = 'succeeded' | 'failed' | 'timed_out';

export interface OperationJournalRecord {
  operationId: string;
  command: string;
  startedAt: string;
  durationMs: number;
  outcome: OperationOutcome;
  recovery: 'not_needed' | 'succeeded' | 'failed';
  errorCode?: string;
  diagnosticCause?: LaunchFailureReason;
  browser?: BrowserProduct;
  browserState?: BrowserLifecycleState;
  currentUrl?: string;
  completedAt?: string;
  timing?: {
    queuedAtMs: number;
    workerRequestAtMs: number | null;
    workerResponseAtMs: number | null;
    terminalAtMs: number;
    persistedAtMs?: number | null;
    responseCreatedAtMs?: number | null;
  };
}

const MAX_JOURNAL_BYTES = 4 * 1_024 * 1_024;
const RETAINED_JOURNAL_BYTES = 2 * 1_024 * 1_024;

export class OperationJournal {
  private readonly journalPath: string;
  private initialized = false;

  constructor(artifactsDir: string) {
    this.journalPath = path.join(artifactsDir, 'operations.jsonl');
  }

  async append(record: OperationJournalRecord): Promise<void> {
    if (!this.initialized) {
      await mkdir(path.dirname(this.journalPath), { recursive: true, mode: 0o700 });
      this.initialized = true;
    }

    await this.compactIfNeeded();
    const safeCurrentUrl = sanitizeUrlForJournal(record.currentUrl);
    const safeRecord: OperationJournalRecord = {
      operationId: record.operationId,
      command: record.command,
      startedAt: record.startedAt,
      durationMs: record.durationMs,
      outcome: record.outcome,
      recovery: record.recovery,
      ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
      ...(record.diagnosticCause === undefined ? {} : { diagnosticCause: record.diagnosticCause }),
      ...(record.browser === undefined ? {} : { browser: record.browser }),
      ...(record.browserState === undefined ? {} : { browserState: record.browserState }),
      ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
      ...(record.timing === undefined ? {} : { timing: { ...record.timing } }),
      ...(safeCurrentUrl === undefined ? {} : { currentUrl: safeCurrentUrl }),
    };

    await appendFile(this.journalPath, `${JSON.stringify(safeRecord)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(this.journalPath, 0o600);
  }

  async find(operationId: string): Promise<OperationJournalRecord | null> {
    let contents: string;
    try {
      contents = await readFile(this.journalPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const lines = contents.trimEnd().split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const record = JSON.parse(lines[index] ?? '') as Partial<OperationJournalRecord>;
        if (
          record.operationId === operationId &&
          typeof record.command === 'string' &&
          typeof record.startedAt === 'string' &&
          typeof record.durationMs === 'number' &&
          (record.outcome === 'succeeded' || record.outcome === 'failed' || record.outcome === 'timed_out')
        ) {
          return record as OperationJournalRecord;
        }
      } catch {
        // Ignore an incomplete or invalid diagnostic line; it is not canonical browser state.
      }
    }
    return null;
  }

  private async compactIfNeeded(): Promise<void> {
    let size: number;
    try {
      size = (await stat(this.journalPath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (size < MAX_JOURNAL_BYTES) return;
    const contents = await readFile(this.journalPath, 'utf8');
    const retainedStart = Math.max(0, contents.length - RETAINED_JOURNAL_BYTES);
    const firstCompleteLine = retainedStart === 0
      ? 0
      : contents.indexOf('\n', retainedStart) + 1;
    const retained = firstCompleteLine <= 0 ? '' : contents.slice(firstCompleteLine);
    const temporaryPath = `${this.journalPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, retained, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.journalPath);
    await chmod(this.journalPath, 0o600);
  }
}
