import type { BrowserTabSummary, FrameSummary, PageStateRisk, PageSummary } from './browser-state.js';
import type { ClickPostcondition, PostconditionResult, SupportedAriaRole } from './controls.js';
import type { DownloadObservation } from './downloads.js';
import type { BrowserDialogActionResult, BrowserDialogExpectation } from './dialogs.js';

export const BROWSER_MOTION_KINDS = ['context_click', 'double_click', 'drag', 'focus', 'hover', 'press'] as const;
export type BrowserMotionKind = (typeof BROWSER_MOTION_KINDS)[number];

export const SUPPORTED_BROWSER_KEYS = [
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'Backspace',
  'Delete',
  'End',
  'Enter',
  'Escape',
  'Home',
  'PageDown',
  'PageUp',
  'Shift+Tab',
  'Space',
  'Tab',
] as const;

export type SupportedBrowserKey = (typeof SUPPORTED_BROWSER_KEYS)[number];

export type BrowserMotionTarget =
  | {
      kind: 'ref';
      snapshotId: string;
      ref: string;
    }
  | {
      kind: 'role';
      role: SupportedAriaRole;
      name: string;
      exact: boolean;
    };

export type BrowserMotion =
  | { kind: 'drag'; source: BrowserMotionTarget; destination: BrowserMotionTarget }
  | { kind: 'context_click' | 'double_click' | 'focus' | 'hover'; target: BrowserMotionTarget }
  | { kind: 'press'; target: BrowserMotionTarget; key: SupportedBrowserKey };

export interface BrowserMotionDispatchEvidence {
  actionDispatched: boolean | 'unknown';
  kind: BrowserMotionKind;
  focusObserved: boolean;
  hoverObserved: boolean;
  keyDownObserved: boolean;
  keyUpObserved: boolean;
  pointerDownObserved: boolean;
  clickObserved: boolean;
  contextMenuObserved: boolean;
  doubleClickObserved: boolean;
  dragStartObserved: boolean;
  dropObserved: boolean;
}

export interface BrowserMotionInput {
  motion: BrowserMotion;
  frameId: string | null;
  postcondition: ClickPostcondition | null;
  timeoutMs: number;
  acknowledgeStateRisk?: boolean;
  dialogResponse?: BrowserDialogExpectation | null;
}

export interface BrowserMotionOutput {
  page: PageSummary;
  stateRisk: PageStateRisk | null;
  frame: FrameSummary;
  motion: BrowserMotionKind;
  dispatch: BrowserMotionDispatchEvidence;
  postcondition: PostconditionResult | null;
  newPage: BrowserTabSummary | null;
  newPageCount: number;
  newDownload: DownloadObservation | null;
  newDownloadCount: number;
  dialog?: BrowserDialogActionResult;
}
