import type { BrowserEngine, BrowserExecutableSource, BrowserProduct } from '../browser-provider.js';

export interface BrowserProfileBinding {
  storageKind: 'chromium_user_data' | 'firefox_profile' | 'webkit_profile';
  userDataDir: string | null;
  profileDirectory: string | null;
  profilePath: string;
}

export interface BrowserLaunchIdentity {
  browser: BrowserProduct;
  engine: BrowserEngine;
  applicationName: string;
  executablePath: string;
  executableSource: BrowserExecutableSource;
  profile: BrowserProfileBinding;
}

export interface RuntimeProfileObservation {
  observedAt: string;
  source: 'chromium_command_line' | 'chromium_version_page' | 'unavailable';
  userDataDir: string | null;
  profileDirectory: string | null;
  profilePath: string | null;
  configuredProfilePath: string;
  matchesConfigured: boolean | null;
}

export type CookieDatabaseKind = 'chromium_legacy' | 'chromium_network' | 'firefox' | 'missing';

export interface CookieDatabaseFileMetadata {
  databaseKind: Exclude<CookieDatabaseKind, 'missing'>;
  relativePath: 'Cookies' | 'Network/Cookies' | 'cookies.sqlite';
  modifiedAt: string;
  journalModifiedAt: string | null;
  inspection: 'aggregate_metadata' | 'database_unavailable' | 'live_process_metadata_only';
}

export interface CookieDatabaseMetadata {
  supported: boolean;
  databaseKind: CookieDatabaseKind;
  relativePath: 'Cookies' | 'Network/Cookies' | 'cookies.sqlite' | null;
  exists: boolean;
  modifiedAt: string | null;
  journalModifiedAt: string | null;
  locations: CookieDatabaseFileMetadata[];
  targetOriginCookiePresent: boolean | null;
  sessionCookiePresent: boolean | null;
  persistentCookiePresent: boolean | null;
  inspection:
    | 'aggregate_metadata'
    | 'database_missing'
    | 'database_unavailable'
    | 'live_context_metadata'
    | 'live_process_metadata_only'
    | 'unsupported';
}

export interface ProfileStorageInspection {
  observedAt: string;
  targetOrigin: string | null;
  cookieDatabase: CookieDatabaseMetadata;
  /** Internal-only, privacy-minimized identifiers derived from cookie keys, never values. */
  keyTokens: ReadonlySet<string> | null;
}

export interface PublicProfileStorageObservation {
  observedAt: string;
  targetOrigin: string | null;
  cookieDatabase: CookieDatabaseMetadata;
}

export interface AuthenticationStorageContinuity {
  beforeHandoff: PublicProfileStorageObservation;
  afterHumanBrowser: PublicProfileStorageObservation;
  afterControlledStart: PublicProfileStorageObservation;
  afterTargetLoad: PublicProfileStorageObservation;
  /** Backward-compatible alias for afterTargetLoad. */
  afterReattachment: PublicProfileStorageObservation;
  humanStorageChanged: boolean | null;
  controlledStartPreservedHumanStorage: boolean | null;
  targetLoadPreservedControlledStorage: boolean | null;
  reattachmentPreservedHumanStorage: boolean | null;
  humanSessionEvidenceObserved: boolean | null;
  targetOriginLoadedAtControlledStart: boolean;
  navigatorWebdriverAtControlledStart: boolean | null;
  lossBoundary:
    | 'none'
    | 'playwright_start'
    | 'playwright_start_or_restored_target_load'
    | 'target_load'
    | 'unverified';
  automationCorrelation: 'loss_after_automation_exposure' | 'not_observed' | 'unverified';
  state: 'preserved' | 'lost' | 'unverified';
}

export interface CookieKeyRow {
  host: string;
  name: string;
  persistent: boolean;
}

export interface LiveCookieKeyMetadata {
  domain: string;
  name: string;
  expires: number;
}

export interface FileMetadata {
  modifiedAt: string;
}
