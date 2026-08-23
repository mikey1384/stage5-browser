import type { Stage5BrowserConfig } from './config.js';
import type { SerializedStage5BrowserError } from './errors.js';

export const SUPPORTED_ARIA_ROLES = [
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'option',
  'radio',
  'searchbox',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
] as const;

export type SupportedAriaRole = (typeof SUPPORTED_ARIA_ROLES)[number];

export type BrowserLifecycleState = 'stopped' | 'starting' | 'running' | 'recovering' | 'failed';

export interface PageSummary {
  index: number;
  url: string;
  title: string;
  readyState: string;
}

export interface BrowserStatus {
  state: BrowserLifecycleState;
  workerPid: number;
  browserConnected: boolean;
  pages: PageSummary[];
  activePageIndex: number | null;
  lastKnownUrl: string | null;
}

export interface BrowserCommandMap {
  initialize: {
    input: { config: Stage5BrowserConfig };
    output: { ready: true; workerPid: number };
  };
  status: {
    input: Record<string, never>;
    output: BrowserStatus;
  };
  start: {
    input: Record<string, never>;
    output: BrowserStatus;
  };
  stop: {
    input: Record<string, never>;
    output: BrowserStatus;
  };
  open: {
    input: { url: string; newTab: boolean; timeoutMs: number };
    output: {
      page: PageSummary;
      responseStatus: number | null;
      readiness: 'commit' | 'domcontentloaded';
      warnings: string[];
    };
  };
  snapshot: {
    input: { depth: number; boxes: boolean; timeoutMs: number };
    output: { page: PageSummary; snapshot: string };
  };
  screenshot: {
    input: { fullPage: boolean; timeoutMs: number };
    output: { page: PageSummary; path: string; mimeType: 'image/png'; dataBase64: string };
  };
  tabs: {
    input: Record<string, never>;
    output: { pages: PageSummary[]; activePageIndex: number | null };
  };
  selectTab: {
    input: { index: number };
    output: { page: PageSummary };
  };
  clickByRole: {
    input: {
      role: SupportedAriaRole;
      name: string;
      exact: boolean;
      timeoutMs: number;
    };
    output: { page: PageSummary };
  };
  fillByRole: {
    input: {
      role: SupportedAriaRole;
      name: string;
      exact: boolean;
      value: string;
      timeoutMs: number;
    };
    output: { page: PageSummary };
  };
  testHang: {
    input: Record<string, never>;
    output: never;
  };
}

export type BrowserCommandName = keyof BrowserCommandMap;
export type BrowserCommandInput<Name extends BrowserCommandName> = BrowserCommandMap[Name]['input'];
export type BrowserCommandOutput<Name extends BrowserCommandName> = BrowserCommandMap[Name]['output'];

export type BrowserWorkerRequest<Name extends BrowserCommandName = BrowserCommandName> = {
  [Command in Name]: {
    kind: 'request';
    id: string;
    command: Command;
    payload: BrowserCommandInput<Command>;
  };
}[Name];

export type BrowserWorkerResponse =
  | {
      kind: 'response';
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      kind: 'response';
      id: string;
      ok: false;
      error: SerializedStage5BrowserError;
    };
