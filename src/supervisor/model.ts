import { type BrowserStatus, type BrowserWorkerResponse, type ChildProcess, type RuntimeProcessInfo, type SerializedStage5BrowserError, Stage5BrowserError } from './dependencies.js';

export type RecoveryOutcome = 'not_needed' | 'succeeded' | 'failed';

export interface RuntimeTransition {
  kind: 'compatible_worker_replaced';
  allReferencesInvalid: true;
  pageStatePreserved: boolean;
  suggestedAction: string;
}

export interface SupervisedResult<T> {
  operationId: string;
  result: T;
  recovery: RecoveryOutcome;
  runtimeTransition: RuntimeTransition | null;
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

export interface PendingRequest {
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
  readonly runtimeTransition: RuntimeTransition | null;

  constructor(error: SerializedStage5BrowserError, operationId: string, recovery: RecoveryOutcome, runtimeTransition: RuntimeTransition | null = null) {
    super(error.code, error.message, {
      recoverable: error.recoverable,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
    this.name = 'SupervisedOperationError';
    this.operationId = operationId;
    this.recovery = recovery;
    this.runtimeTransition = runtimeTransition;
  }
}

export function isWorkerResponse(message: unknown): message is BrowserWorkerResponse {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  const candidate = message as Partial<BrowserWorkerResponse>;
  return candidate.kind === 'response' && typeof candidate.id === 'string' && typeof candidate.ok === 'boolean';
}
