import type { FillRefEvidence } from '../protocol.js';

export type ConsoleDiagnosticCategory =
  | 'automation_rejection'
  | 'content_security_policy'
  | 'network'
  | 'other'
  | 'uncaught_exception';

export type NetworkFailureCategory =
  | 'aborted'
  | 'blocked'
  | 'connection'
  | 'dns'
  | 'other'
  | 'timeout'
  | 'tls';

export type ActionFailureReason =
  | 'ambiguous_target'
  | 'detached'
  | 'not_enabled'
  | 'not_visible'
  | 'page_not_active'
  | 'pointer_intercepted'
  | 'target_missing'
  | 'timeout'
  | 'unknown';

export interface SanitizedConsoleDiagnostic {
  severity: 'error' | 'warning';
  category: ConsoleDiagnosticCategory;
  sourceUrl: string | null;
  fingerprint: string;
  occurredAt: string;
}

export interface SanitizedNetworkDiagnostic {
  kind: 'http_error' | 'http_response' | 'request_failed';
  method: string;
  resourceType: string;
  url: string | null;
  status: number | null;
  failureCategory: NetworkFailureCategory | null;
  occurredAt: string;
}

export interface SafeTargetState {
  visible: boolean;
  enabled: boolean;
  inViewport: boolean;
  receivesPointerEvents: boolean | null;
  pointerHitPoint: 'center' | 'alternate' | null;
  tagName: string;
  role: string | null;
  coveredBy: { tagName: string; role: string | null; pointerEvents: string } | null;
}

export type SanitizedNativeWindowActivationResult =
  | 'activated'
  | 'application_activation_failed'
  | 'application_activation_unverified'
  | 'headless_not_applicable'
  | 'native_activation_unsupported'
  | 'not_required'
  | 'owned_process_not_running'
  | 'owned_process_unavailable'
  | 'target_window_unavailable'
  | 'visibility_unchanged'
  | 'window_normalization_failed';

export interface SanitizedNativeWindowActivationEvidence {
  required: boolean;
  attempted: boolean;
  supported: boolean;
  ownedProcessAvailable: boolean;
  ownedProcessRunning: boolean | null;
  targetWindowResolved: boolean | null;
  windowStateBefore: 'fullscreen' | 'maximized' | 'minimized' | 'normal' | 'unknown';
  normalizationAttempted: boolean;
  normalizationSucceeded: boolean | null;
  applicationActivationAttempted: boolean;
  applicationActivationSucceeded: boolean | null;
  applicationHiddenBefore: boolean | null;
  unhideAttempted: boolean;
  unhideSucceeded: boolean | null;
  activationRequestAccepted: boolean | null;
  frontProcessFallbackAttempted: boolean;
  frontProcessFallbackProcessResolved: boolean | null;
  frontProcessFallbackRequestSucceeded: boolean | null;
  applicationFrontmostAfter: boolean | null;
  applicationHiddenAfter: boolean | null;
  result: SanitizedNativeWindowActivationResult;
}

export interface SanitizedPageActivationEvidence {
  attemptCount: number;
  controllerSelected: boolean;
  bringToFrontAttempted: boolean;
  bringToFrontSucceeded: boolean;
  visibilityBefore: 'hidden' | 'prerender' | 'unknown' | 'visible';
  visibilityAfter: 'hidden' | 'prerender' | 'unknown' | 'visible';
  documentFocusedBefore: boolean | null;
  documentFocusedAfter: boolean | null;
  nativeWindow: SanitizedNativeWindowActivationEvidence;
}

export interface SanitizedClickDispatchEvidence {
  strategy: 'guarded_exact_handle';
  forcedFallbackUsed: boolean;
  pageMouseFallbackUsed: boolean;
  pageActivation: SanitizedPageActivationEvidence;
  guardExpired: boolean;
  targetConnectedBefore: boolean;
  targetConnectedAtFirstEvent: boolean | null;
  targetConnectedAfter: boolean;
  geometryChangedBeforeFirstEvent: boolean | null;
  trustedEventObserved: boolean;
  keyDownOnTarget: boolean;
  keyUpOnTarget: boolean;
  pointerDownOnTarget: boolean;
  mouseDownOnTarget: boolean;
  pointerUpOnTarget: boolean;
  mouseUpOnTarget: boolean;
  clickOnTarget: boolean;
  misdirectedEventBlocked: boolean;
  targetStateChangeBlocked: boolean;
}

export interface SanitizedActionDiagnostic {
  action: 'click_by_ref' | 'click_by_role' | 'context_click' | 'dismiss_popup' | 'double_click' | 'drag' | 'fill_by_role' | 'fill_ref' | 'focus' | 'hover' | 'press' | 'scroll' | 'select_option' | 'set_checked';
  outcome: 'blocked' | 'failed' | 'postcondition_failed' | 'succeeded';
  reason: ActionFailureReason | 'postcondition_not_met' | null;
  actionDispatched: boolean | 'unknown';
  clickDispatched: boolean | 'unknown' | null;
  targetState: SafeTargetState | null;
  dispatchEvidence?: SanitizedClickDispatchEvidence;
  fillPhase?: 'completed' | 'event_verification' | 'fill_dispatch' | 'page_activation' | 'target_preparation' | 'value_matching';
  fillPreparationStep?: 'completed' | 'editor_capability' | 'editor_validation' | 'reference_validation' | 'scope_validation' | 'target_state' | 'viewport_preparation';
  inputEvidence?: FillRefEvidence;
  pageUrl: string | null;
  startedAt: string;
  occurredAt: string;
}

export interface PageRuntimeDiagnostics {
  pageUrl: string | null;
  totals: {
    consoleErrors: number;
    consoleWarnings: number;
    pageErrors: number;
    failedRequests: number;
    httpErrors: number;
    httpRedirects: number;
    httpSuccesses: number;
  };
  consoleEvents: SanitizedConsoleDiagnostic[];
  networkEvents: SanitizedNetworkDiagnostic[];
  lastAction: SanitizedActionDiagnostic | null;
  lastActionNetworkEvents: SanitizedNetworkDiagnostic[];
  privacy:
    'Raw console messages, exception text, request bodies, headers, query strings, fragments, click coordinates, and event payloads are excluded.';
}

export interface PageDiagnosticRecord {
  totals: PageRuntimeDiagnostics['totals'];
  consoleEvents: SanitizedConsoleDiagnostic[];
  networkEvents: SanitizedNetworkDiagnostic[];
  lastAction: SanitizedActionDiagnostic | null;
  lastActionNetworkEvents: SanitizedNetworkDiagnostic[];
  activeActionStartedAt: string | null;
  activeActionNetworkEndAtMs: number | null;
}
