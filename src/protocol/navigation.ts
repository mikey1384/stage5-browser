import type { BrowserTabSummary, PageStateRisk, PageSummary } from './browser-state.js';
import type { NavigationWarning, UrlExpectation } from './controls.js';
import type { BrowserDialogActionResult, BrowserDialogExpectation } from './dialogs.js';

export const BROWSER_HISTORY_ACTIONS = ['back', 'forward', 'reload'] as const;
export type BrowserHistoryAction = (typeof BROWSER_HISTORY_ACTIONS)[number];

export interface NavigateHistoryInput {
  action: BrowserHistoryAction;
  expectedUrl: UrlExpectation | null;
  stabilizationMs: number;
  acknowledgeStateRisk?: boolean;
  timeoutMs: number;
  dialogResponse?: BrowserDialogExpectation | null;
}

export interface NavigateHistoryOutput {
  page: PageSummary;
  stateRisk: PageStateRisk | null;
  action: BrowserHistoryAction;
  actionDispatched: boolean | 'unknown';
  beforeUrl: string;
  finalUrl: string;
  moved: boolean;
  readiness: 'commit' | 'domcontentloaded';
  responseStatus: number | null;
  stabilizationMs: number;
  warnings: NavigationWarning[];
  dialog?: BrowserDialogActionResult;
}

export interface CloseTabOutput {
  closedTabId: string;
  wasSelected: boolean;
  actionDispatched: true;
  pages: BrowserTabSummary[];
  selectedTabId: string | null;
  stateRisk: PageStateRisk | null;
}
