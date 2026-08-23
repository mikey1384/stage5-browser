import { appendFile, chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';

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
  currentUrl?: string;
}

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

    const safeRecord = {
      operationId: record.operationId,
      command: record.command,
      startedAt: record.startedAt,
      durationMs: record.durationMs,
      outcome: record.outcome,
      recovery: record.recovery,
      ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
      ...(sanitizeUrlForJournal(record.currentUrl) === undefined
        ? {}
        : { currentUrl: sanitizeUrlForJournal(record.currentUrl) }),
    };

    await appendFile(this.journalPath, `${JSON.stringify(safeRecord)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(this.journalPath, 0o600);
  }
}
