import type { OperationJournalRecord, OperationOutcome } from '../operation-journal.js';
import type { SerializedStage5BrowserError } from '../errors.js';

export const OPERATION_PHASES = [
  'reserved',
  'queued',
  'worker_preflight',
  'worker_request_sent',
  'worker_result_received',
  'terminal_result_created',
  'persistence_complete',
  'response_created',
] as const;

export type OperationPhase = (typeof OPERATION_PHASES)[number];

export const RESERVABLE_OPERATION_COMMANDS = [
  'clickByRole',
  'clickRef',
  'applyFormPlan',
  'fillByRole',
  'fillRef',
  'inspectControl',
  'motion',
  'navigateHistory',
  'open',
  'recover',
  'requestLoginHandoff',
  'requestPrivateFieldHandoff',
  'resumeAfterLogin',
  'resumePrivateFieldHandoff',
  'scroll',
  'selectOption',
  'selectOptions',
  'setChecked',
  'closeTab',
  'setInputFiles',
] as const;

export interface OperationTiming {
  queuedAtMs: number;
  workerRequestAtMs: number | null;
  workerResponseAtMs: number | null;
  terminalAtMs: number | null;
  persistedAtMs: number | null;
  responseCreatedAtMs: number | null;
}

export interface LiveOperationRecord {
  operationId: string;
  command: string;
  phase: OperationPhase;
  startedAt: string;
  updatedAtMs: number;
  timing: OperationTiming;
  outcome: OperationOutcome | null;
  recovery: OperationJournalRecord['recovery'] | null;
  error: SerializedStage5BrowserError | null;
  result: unknown;
  hasResult: boolean;
}

export interface OperationStatusResult {
  operationId: string;
  command: string;
  phase: OperationPhase | 'durable_terminal';
  source: 'durable' | 'memory';
  startedAt: string;
  updatedAtMs: number | null;
  timing: OperationTiming;
  terminal: boolean;
  outcome: OperationOutcome | null;
  recovery: OperationJournalRecord['recovery'] | null;
  error: SerializedStage5BrowserError | null;
  resultAvailable: boolean;
  result?: unknown;
}
