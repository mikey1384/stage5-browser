import type { Stage5BrowserConfig } from './config.js';
import type { BrowserDiagnostics } from './diagnostics.js';
import type { BrowserAvailability, BrowserProduct } from './browser-provider.js';
import type { SerializedStage5BrowserError } from './errors.js';
import type { RuntimeProcessInfo } from './runtime-info.js';

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

export interface FrameSummary {
  id: string;
  parentId: string | null;
  name: string;
  url: string;
  isMainFrame: boolean;
}

export interface BrowserStatus {
  browser: BrowserProduct;
  state: BrowserLifecycleState;
  workerPid: number;
  browserConnected: boolean;
  pages: PageSummary[];
  activePageIndex: number | null;
  lastKnownUrl: string | null;
}

export interface AvailableBrowsers {
  defaultBrowser: BrowserProduct;
  currentBrowser: BrowserProduct;
  browsers: BrowserAvailability[];
}

export interface BrowserCommandMap {
  initialize: {
    input: {
      config: Stage5BrowserConfig;
      browser: BrowserProduct;
      protocolVersion: number;
      mcpVersion: string;
      mcpBuildFingerprint: string | null;
    };
    output: { ready: true; workerPid: number; runtime: RuntimeProcessInfo };
  };
  status: {
    input: Record<string, never>;
    output: BrowserStatus;
  };
  start: {
    input: { browser?: BrowserProduct };
    output: BrowserStatus;
  };
  availableBrowsers: {
    input: Record<string, never>;
    output: AvailableBrowsers;
  };
  diagnostics: {
    input: Record<string, never>;
    output: { browser: BrowserDiagnostics; status: BrowserStatus; worker: RuntimeProcessInfo };
  };
  switchBrowser: {
    input: { browser: BrowserProduct };
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
    input: { depth: number; boxes: boolean; frameId: string | null; timeoutMs: number };
    output: { page: PageSummary; frame: FrameSummary; snapshot: string };
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
  frames: {
    input: Record<string, never>;
    output: { page: PageSummary; frames: FrameSummary[] };
  };
  clickByRole: {
    input: {
      role: SupportedAriaRole;
      name: string;
      exact: boolean;
      frameId: string | null;
      timeoutMs: number;
    };
    output: { page: PageSummary; frame: FrameSummary };
  };
  fillByRole: {
    input: {
      role: SupportedAriaRole;
      name: string;
      exact: boolean;
      frameId: string | null;
      value: string;
      timeoutMs: number;
    };
    output: { page: PageSummary; frame: FrameSummary };
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
