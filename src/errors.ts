export type Stage5BrowserErrorCode =
  | 'AMBIGUOUS_TARGET'
  | 'BROWSER_NOT_READY'
  | 'INVALID_URL'
  | 'MCP_RESTART_REQUIRED'
  | 'NO_ACTIVE_PAGE'
  | 'OPERATION_FAILED'
  | 'OPERATION_TIMEOUT'
  | 'TARGET_NOT_FOUND'
  | 'WORKER_DISCONNECTED'
  | 'WORKER_START_FAILED';

export interface SerializedStage5BrowserError {
  code: Stage5BrowserErrorCode;
  message: string;
  recoverable: boolean;
  details?: Record<string, unknown>;
}

export class Stage5BrowserError extends Error {
  readonly code: Stage5BrowserErrorCode;
  readonly recoverable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: Stage5BrowserErrorCode,
    message: string,
    options: { recoverable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'Stage5BrowserError';
    this.code = code;
    this.recoverable = options.recoverable ?? false;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }

  serialize(): SerializedStage5BrowserError {
    return {
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function serializeUnknownError(error: unknown): SerializedStage5BrowserError {
  if (error instanceof Stage5BrowserError) {
    return error.serialize();
  }

  if (error instanceof Error && error.name === 'TimeoutError') {
    return {
      code: 'OPERATION_TIMEOUT',
      message: 'The browser operation exceeded its Playwright deadline.',
      recoverable: true,
    };
  }

  return {
    code: 'OPERATION_FAILED',
    message: error instanceof Error ? `Browser operation failed (${error.name}).` : 'Browser operation failed.',
    recoverable: false,
  };
}
