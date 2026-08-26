import type { BrowserAvailability, BrowserProduct } from '../browser-provider.js';
import type { ProfileOwnerEvidence } from '../chromium-profile-owner.js';
import type { BrowserLaunchIdentity, RuntimeProfileObservation } from '../profile-binding.js';

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
  /** Opaque opener relationship when the opener remains in this controlled context. */
  openerTabId: string | null;
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
