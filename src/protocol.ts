import type { Stage5BrowserConfig } from './config.js';
import type { BrowserDiagnostics } from './diagnostics.js';
import type { BrowserAvailability, BrowserProduct } from './browser-provider.js';
import type { SerializedStage5BrowserError } from './errors.js';
import type { RuntimeProcessInfo } from './runtime-info.js';
import type {
  AuthenticationStorageContinuity,
  BrowserLaunchIdentity,
  BrowserProfileBinding,
  RuntimeProfileObservation,
} from './profile-binding.js';

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

export const URL_MATCH_MODES = ['exact', 'prefix', 'contains'] as const;
export type UrlMatchMode = (typeof URL_MATCH_MODES)[number];

export interface UrlExpectation {
  url: string;
  match: UrlMatchMode;
}

export interface VisibleElementExpectation {
  role: SupportedAriaRole;
  name: string;
  exact: boolean;
  frameId: string | null;
}

export interface ClickPostcondition {
  expectedUrl: UrlExpectation | null;
  expectedSelected: boolean | null;
  expectedVisible: VisibleElementExpectation | null;
  timeoutMs: number;
}

export interface PostconditionCheck {
  kind: 'url' | 'selected' | 'visible';
  passed: boolean;
  expected: string | boolean;
  observed: string | boolean | null;
}

export interface PostconditionResult {
  passed: true;
  checks: PostconditionCheck[];
}

export type NavigationWarningCode =
  | 'dom_readiness_timeout'
  | 'http_authentication_required'
  | 'http_client_error'
  | 'http_forbidden'
  | 'http_rate_limited'
  | 'http_server_error';

export interface NavigationWarning {
  code: NavigationWarningCode;
  message: string;
  status: number | null;
  suggestedAction: string;
}

export interface RedirectHop {
  kind: 'server';
  from: string;
  to: string;
  status: number | null;
}

export interface ScrollPosition {
  x: number;
  y: number;
  maxX: number;
  maxY: number;
  viewportWidth: number;
  viewportHeight: number;
  contentWidth: number;
  contentHeight: number;
}

export type AuthenticationHandoffState =
  | 'browser_stopped'
  | 'profile_ready'
  | 'awaiting_user'
  | 'ready_for_agent_verification';

export interface HumanBootstrapStatus {
  running: boolean;
  processId: number | null;
  launchedAt: string;
  controlledByPlaywright: boolean;
  automationFlagsPresent: false;
  exactUserInteractionsObserved: false;
  launchIdentity: BrowserLaunchIdentity;
  handoffLabel: string;
  profileShutdown: {
    state: 'clean' | 'unclean' | 'unknown';
    exitType: 'crashed' | 'normal' | 'session_ended' | 'unknown' | null;
    exitedCleanly: boolean | null;
    exitedCleanlySource: 'preferences_flag' | 'exit_type' | 'profile_lock' | 'process_exit' | 'insufficient_evidence';
    profileDirectory: string | null;
    profileLocks: string[];
    preferencesModifiedAt: string | null;
    exitTypeComparison: 'unchanged_from_before_handoff' | 'rewritten_with_same_value' | 'changed_during_handoff' | 'unavailable';
    currentSessionEvidence: 'clean_process_exit' | 'abnormal_process_exit' | 'process_exit_unknown';
    reattachmentDecision: 'allowed' | 'override_available' | 'explicit_unlocked_profile_override';
  } | null;
}

export interface AuthenticationBoundaryOutcome {
  observation: 'sanitized_before_after_boundary';
  exactUserInteractionsObserved: false;
  beforeUrl: string | null;
  afterUrl: string | null;
  routeChanged: boolean | null;
  semanticStructureChanged: boolean | null;
  launchIdentityMatched: boolean;
  runtimeProfile: RuntimeProfileObservation | null;
  storageContinuity: AuthenticationStorageContinuity;
  comparedAt: string;
}

export interface AuthenticationStatus {
  browser: BrowserProduct;
  browserConnected: boolean;
  state: AuthenticationHandoffState;
  authenticated: 'unknown';
  persistentProfile: true;
  profileBinding: BrowserProfileBinding;
  targetOrigin: string | null;
  requestedAt: string | null;
  resumedAt: string | null;
  targetPageIndex: number | null;
  targetPageAvailable: boolean;
  page: PageSummary | null;
  verificationRequired: boolean;
  controlMode: 'human_bootstrap' | 'none' | 'playwright';
  humanBootstrap: HumanBootstrapStatus | null;
  lastHandoffOutcome: AuthenticationBoundaryOutcome | null;
}

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
  launchIdentity: BrowserLaunchIdentity | null;
  runtimeProfile: RuntimeProfileObservation | null;
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
    input: { url: string; newTab: boolean; stabilizationMs?: number; timeoutMs: number };
    output: {
      page: PageSummary;
      requestedUrl: string;
      finalUrl: string;
      responseStatus: number | null;
      readiness: 'commit' | 'domcontentloaded';
      redirected: boolean;
      redirectChain: RedirectHop[];
      observedUrls: string[];
      stabilizationMs: number;
      warnings: NavigationWarning[];
    };
  };
  snapshot: {
    input: { depth: number; boxes: boolean; frameId: string | null; timeoutMs: number };
    output: {
      page: PageSummary;
      frame: FrameSummary;
      snapshotId: string;
      refCount: number;
      scope: 'document' | 'modal';
      visibleModalCount: number;
      warnings: Array<{
        code: 'ambiguous_visible_modals';
        message: string;
        suggestedAction: string;
      }>;
      snapshot: string;
    };
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
    output: { page: PageSummary; authenticationTargetUpdated: boolean };
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
      postcondition: ClickPostcondition | null;
      timeoutMs: number;
    };
    output: {
      page: PageSummary;
      frame: FrameSummary;
      postcondition: PostconditionResult | null;
    };
  };
  clickRef: {
    input: {
      snapshotId: string;
      ref: string;
      frameId: string | null;
      postcondition: ClickPostcondition | null;
      timeoutMs: number;
    };
    output: {
      page: PageSummary;
      frame: FrameSummary;
      postcondition: PostconditionResult | null;
    };
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
  scroll: {
    input: {
      direction: 'up' | 'down';
      amount: 'half_viewport' | 'viewport' | 'document_start' | 'document_end';
      count: number;
      settleMs: number;
      frameId: string | null;
      timeoutMs: number;
    };
    output: {
      page: PageSummary;
      frame: FrameSummary;
      before: ScrollPosition;
      after: ScrollPosition;
      stepsCompleted: number;
      moved: boolean;
      contentGrew: boolean;
      endReached: boolean;
      warnings: Array<{ code: 'scroll_position_unchanged'; message: string; suggestedAction: string }>;
    };
  };
  findText: {
    input: {
      query: string;
      mode: 'contains' | 'exact_line';
      caseSensitive: boolean;
      maxResults: number;
      frameId: string | null;
      timeoutMs: number;
    };
    output: {
      page: PageSummary;
      frame: FrameSummary;
      query: string;
      matchCount: number;
      returnedCount: number;
      truncated: boolean;
      textTruncated: boolean;
      matches: Array<{ line: number; snippet: string }>;
    };
  };
  waitForUrl: {
    input: { expected: UrlExpectation; timeoutMs: number };
    output: { page: PageSummary; matched: true; expected: UrlExpectation };
  };
  authStatus: {
    input: Record<string, never>;
    output: AuthenticationStatus;
  };
  requestLoginHandoff: {
    input: { url: string | null; timeoutMs: number };
    output: AuthenticationStatus & {
      userActionRequired: true;
      instructions: string;
    };
  };
  resumeAfterLogin: {
    input: { expected: UrlExpectation | null; timeoutMs: number };
    output: AuthenticationStatus & {
      userActionRequired: false;
      instructions: string;
      verificationPreview: {
        observation: 'bounded_semantic_preview';
        available: boolean;
        depth: number;
        snapshot: string | null;
      };
    };
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
