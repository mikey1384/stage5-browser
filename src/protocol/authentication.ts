import type { BrowserProduct } from '../browser-provider.js';
import type { AuthenticationStorageContinuity, BrowserLaunchIdentity, BrowserProfileBinding, RuntimeProfileObservation } from '../profile-binding.js';
import type { PageSummary } from './browser-state.js';

export type AuthenticationHandoffState =
  | 'browser_stopped'
  | 'profile_ready'
  | 'releasing_control'
  | 'awaiting_user'
  | 'ready_for_agent_verification';

export type HandoffReleaseStrategy = 'native_same_process' | 'process_relaunch';

export interface HandoffReleaseStatus {
  strategy: HandoffReleaseStrategy;
  phase: 'close_requested' | 'process_exited' | 'profile_unlocked' | 'human_input';
  closeRequestCompleted: boolean | null;
  processReused: boolean | null;
  ownershipRetained: true;
}

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
  handoffRelease: HandoffReleaseStatus | null;
  humanBootstrap: HumanBootstrapStatus | null;
  lastHandoffOutcome: AuthenticationBoundaryOutcome | null;
}
