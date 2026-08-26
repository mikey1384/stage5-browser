import type { Stage5BrowserConfig } from './config.js';
import type { BrowserDiagnostics } from './diagnostics.js';
import type { BrowserAvailability, BrowserProduct } from './browser-provider.js';
import type { ProfileOwnerEvidence } from './chromium-profile-owner.js';
import type { SerializedStage5BrowserError } from './errors.js';
import type { RuntimeProcessInfo } from './runtime-info.js';
import type { SanitizedPageActivationEvidence } from './page-diagnostics.js';
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

export interface FileInputObservation {
  ref: string;
  accept: string | null;
  multiple: boolean;
  disabled: boolean;
  visible: boolean;
  label: string | null;
}

export interface FileProcessingExpectation {
  expectedComplete: VisibleElementExpectation | null;
  expectedError: VisibleElementExpectation | null;
  timeoutMs: number;
}

export interface FileSelectionWarning {
  code:
    | 'attachment_preview_unavailable'
    | 'file_input_list_truncated'
    | 'processing_completion_unverified'
    | 'processing_error_observed'
    | 'processing_marker_preexisting'
    | 'progress_disappeared_unverified';
  message: string;
  suggestedAction: string;
}

export interface ClickPostcondition {
  expectedUrl: UrlExpectation | null;
  expectedSelected: boolean | null;
  expectedVisible: VisibleElementExpectation | null;
  expectedHidden?: VisibleElementExpectation | null;
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

export interface FillRefEvidence {
  actionDispatched: boolean | 'unknown';
  inputEventObserved: boolean;
  changeEventObserved: boolean;
  valueMatchedBefore: boolean;
  valueMatches: boolean;
  targetConnectedAfter: boolean;
  targetKind: 'contenteditable' | 'input' | 'textarea';
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

export interface ScrollContainerObservation {
  ref: string;
  label: string | null;
  role: string | null;
  inViewport: boolean;
  position: ScrollPosition;
}

export interface ScrollContentObservation {
  articleCount: number;
  loadingIndicatorCount: number;
}

export type ScrollWaitCondition =
  | 'article_count_growth'
  | 'loading_indicators_disappear'
  | 'either';

export interface ScrollWaitResult {
  requested: boolean;
  condition: ScrollWaitCondition | null;
  satisfied: boolean;
  evidence:
    | 'article_count_growth'
    | 'loading_indicators_disappeared'
    | 'not_requested'
    | 'timeout';
  waitedMs: number;
  before: ScrollContentObservation;
  after: ScrollContentObservation;
}

export type ScrollEndState =
  | 'confirmed_by_marker'
  | 'confirmed_document_start'
  | 'confirmed_container_start'
  | 'dynamic_content_stalled'
  | 'geometric_boundary_unconfirmed'
  | 'not_at_boundary';

export type AuthenticationHandoffState =
  | 'browser_stopped'
  | 'profile_ready'
  | 'releasing_control'
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

export interface BrowserTabSummary extends PageSummary {
  /** Session-scoped opaque capability; never a browser/CDP target identifier. */
  tabId: string;
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
  profileLockState: 'none' | 'owned_browser_running' | 'possible_external_owner';
  profileLockFiles: string[];
  profileOwner: ProfileOwnerEvidence;
}

export interface AvailableBrowsers {
  defaultBrowser: BrowserProduct;
  currentBrowser: BrowserProduct;
  browsers: BrowserOperationalAvailability[];
}

export type BrowserProfileAvailabilityState =
  | 'startable'
  | 'owned_active'
  | 'owned_orphaned'
  | 'busy_other_stage5_session'
  | 'external_owner'
  | 'unavailable';

export interface BrowserOperationalAvailability extends BrowserAvailability {
  /** Executable/runtime discovery only; profile ownership is reported separately below. */
  installed: boolean;
  /** True only when this Stage5 session can safely use or start the backend now. */
  profileState: BrowserProfileAvailabilityState;
  startable: boolean;
  recoverable: boolean;
  suggestedAction: string | null;
}

export interface BrowserCommandMap {
  initialize: {
    input: {
      config: Stage5BrowserConfig;
      browser: BrowserProduct;
      protocolVersion: number;
      mcpVersion: string;
      mcpBuildFingerprint: string | null;
      buildFingerprintPolicy?: 'diagnostic_only';
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
      fileInputCount: number;
      fileInputs: FileInputObservation[];
      scrollContainerCount: number;
      scrollContainers: ScrollContainerObservation[];
      scope: 'document' | 'modal';
      visibleModalCount: number;
      warnings: Array<{
        code:
          | 'ambiguous_visible_modals'
          | 'file_input_list_truncated'
          | 'scroll_container_list_truncated';
        message: string;
        suggestedAction: string;
      }>;
      snapshot: string;
    };
  };
  screenshot: {
    input: { fullPage: boolean; timeoutMs: number };
    output: {
      page: PageSummary;
      path: string;
      mimeType: 'image/png';
      dataBase64: string;
      captureEvidence: {
        pageActivation: SanitizedPageActivationEvidence;
        pngBytes: number;
        artifactClassification: 'contentful' | 'possibly_uniform';
        semanticContentPresent: boolean;
        retryUsed: boolean;
      };
    };
  };
  tabs: {
    input: Record<string, never>;
    output: { pages: BrowserTabSummary[]; activePageIndex: number | null };
  };
  selectTab: {
    input: { tabId: string };
    output: { page: BrowserTabSummary; authenticationTargetUpdated: boolean };
  };
  inspectTab: {
    input: {
      tabId: string;
      depth: number;
      temporaryActivation: boolean;
      waitFor: { condition: ScrollWaitCondition; timeoutMs: number } | null;
      timeoutMs: number;
    };
    output: {
      page: BrowserTabSummary;
      snapshot: string;
      scope: 'document';
      refCount: 0;
      elementActionsAvailable: false;
      activationAttempted: boolean;
      activationRestored: boolean | null;
      rendererVisibility: 'visible' | 'hidden' | 'unknown';
      rendererVisibilityAfterRestore: 'visible' | 'hidden' | 'unknown';
      loadingWait: ScrollWaitResult | null;
      visibleModalCount: number;
      controllerSelectionUnchanged: boolean;
      warnings: Array<{
        code:
          | 'visible_modal_in_document'
          | 'controller_selection_changed_externally'
          | 'loading_expectation_not_satisfied';
        message: string;
        suggestedAction: string;
      }>;
    };
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
  setInputFiles: {
    input: {
      snapshotId: string;
      ref: string;
      paths: string[];
      frameId: string | null;
      completion: FileProcessingExpectation | null;
      observationMs: number;
      previewDepth: number;
      timeoutMs: number;
    };
    output: {
      page: PageSummary;
      frame: FrameSummary;
      selection: {
        dispatched: true;
        confirmedByInput: true;
        fileCount: number;
        totalBytes: number;
        files: Array<{ name: string; sizeBytes: number }>;
      };
      attachmentPreview: {
        observation: 'bounded_semantic_preview';
        available: boolean;
        depth: number;
        snapshotId: string | null;
        snapshot: string | null;
      };
      processing: {
        state: 'completion_observed' | 'error_observed' | 'in_progress' | 'unverified';
        evidence:
          | 'expected_completion_visible'
          | 'expected_error_visible'
          | 'network_error_observed'
          | 'progress_active'
          | 'progress_complete'
          | 'progress_disappeared'
          | 'none';
        progress: {
          observed: boolean;
          activeAtReturn: boolean;
          completionValueObserved: boolean;
          disappearedAfterObservation: boolean;
          maxPercentObserved: number | null;
        };
        pageActivity: {
          attribution: 'temporal_only';
          observationMs: number;
          successfulResponses: number;
          redirects: number;
          httpErrors: number;
          failedRequests: number;
        };
      };
      warnings: FileSelectionWarning[];
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
  fillRef: {
    input: {
      snapshotId: string;
      ref: string;
      frameId: string | null;
      value: string;
      timeoutMs: number;
    };
    output: {
      page: PageSummary;
      frame: FrameSummary;
      input: FillRefEvidence;
    };
  };
  scroll: {
    input: {
      direction: 'up' | 'down';
      amount: 'half_viewport' | 'viewport' | 'document_start' | 'document_end';
      count: number;
      settleMs: number;
      frameId: string | null;
      endMarker: VisibleElementExpectation | null;
      target: { snapshotId: string; ref: string } | null;
      waitFor: { condition: ScrollWaitCondition; timeoutMs: number } | null;
      timeoutMs: number;
    };
    output: {
      page: PageSummary;
      frame: FrameSummary;
      target: { kind: 'document'; ref: null } | { kind: 'container'; ref: string };
      before: ScrollPosition;
      after: ScrollPosition;
      wait: ScrollWaitResult;
      stepsCompleted: number;
      moved: boolean;
      contentGrew: boolean;
      targetBoundaryReached: boolean;
      documentBoundaryReached: boolean;
      nestedScrollContainerCandidateCount: number;
      endReached: boolean;
      endState: ScrollEndState;
      warnings: Array<{
        code:
          | 'content_wait_timed_out'
          | 'dynamic_content_stalled'
          | 'nested_scroll_containers_available'
          | 'scroll_end_unconfirmed'
          | 'scroll_position_unchanged';
        message: string;
        suggestedAction: string;
      }>;
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
