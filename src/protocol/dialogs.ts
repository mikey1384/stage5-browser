import type { BrowserCommandName } from './commands.js';

export const BROWSER_DIALOG_TYPES = ['alert', 'beforeunload', 'confirm', 'prompt'] as const;
export type BrowserDialogType = (typeof BROWSER_DIALOG_TYPES)[number];

export const BROWSER_DIALOG_RESPONSES = ['accept', 'dismiss'] as const;
export type BrowserDialogResponse = (typeof BROWSER_DIALOG_RESPONSES)[number];

export interface BrowserDialogExpectation {
  type: BrowserDialogType;
  response: BrowserDialogResponse;
  promptText?: string | undefined;
}

export interface BrowserDialogObservation {
  dialogId: string;
  sequence: number;
  type: BrowserDialogType;
  response: BrowserDialogResponse | 'response_failed';
  expected: boolean;
  command: BrowserCommandName | null;
  occurredAt: string;
}

export interface BrowserDialogActionResult {
  expected: boolean;
  observed: boolean;
  satisfied: boolean;
  dialogs: BrowserDialogObservation[];
}

export interface BrowserDialogStatus {
  cursor: number;
  dialogs: BrowserDialogObservation[];
  defaultUnexpectedResponse: 'dismiss';
  privacy: 'message_and_prompt_text_never_retained';
  persistence: 'durable_sanitized_manifest';
}

export function dialogExpectationFromPayload(payload: unknown): BrowserDialogExpectation | null {
  if (typeof payload !== 'object' || payload === null || !('dialogResponse' in payload)) return null;
  const expectation = payload.dialogResponse;
  if (typeof expectation !== 'object' || expectation === null) return null;
  const candidate = expectation as Partial<BrowserDialogExpectation>;
  if (
    !BROWSER_DIALOG_TYPES.includes(candidate.type as BrowserDialogType)
    || !BROWSER_DIALOG_RESPONSES.includes(candidate.response as BrowserDialogResponse)
  ) return null;
  return {
    type: candidate.type as BrowserDialogType,
    response: candidate.response as BrowserDialogResponse,
    ...(typeof candidate.promptText === 'string' ? { promptText: candidate.promptText } : {}),
  };
}
