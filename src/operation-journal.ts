import { appendFile, chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';

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
      ...(record.diagnosticCause === undefined ? {} : { diagnosticCause: record.diagnosticCause }),
      ...(record.browser === undefined ? {} : { browser: record.browser }),
      ...(record.browserState === undefined ? {} : { browserState: record.browserState }),
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
