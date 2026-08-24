import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type {
  BrowserEngine,
  BrowserExecutableSource,
  BrowserLaunchTarget,
  BrowserProduct,
} from './browser-provider.js';
import { playwrightBrowserType } from './browser-provider.js';

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
  afterReattachment: PublicProfileStorageObservation;
  humanStorageChanged: boolean | null;
  reattachmentPreservedHumanStorage: boolean | null;
  humanSessionEvidenceObserved: boolean | null;
  state: 'preserved' | 'lost' | 'unverified';
}

interface CookieKeyRow {
  host: string;
  name: string;
  persistent: boolean;
}

interface FileMetadata {
  modifiedAt: string;
}

const CHROMIUM_PROFILE_DIRECTORY = 'Default';

export function profileBindingForBrowser(profileRoot: string, engine: BrowserEngine): BrowserProfileBinding {
  if (engine === 'chromium') {
    return {
      storageKind: 'chromium_user_data',
      userDataDir: profileRoot,
      profileDirectory: CHROMIUM_PROFILE_DIRECTORY,
      profilePath: path.join(profileRoot, CHROMIUM_PROFILE_DIRECTORY),
    };
  }

  return {
    storageKind: engine === 'firefox' ? 'firefox_profile' : 'webkit_profile',
    userDataDir: null,
    profileDirectory: null,
    profilePath: profileRoot,
  };
}

export function executablePathForTarget(target: BrowserLaunchTarget): string {
  return target.executablePath ?? playwrightBrowserType(target.engine).executablePath();
}

export function applicationNameForTarget(target: BrowserLaunchTarget): string {
  const executablePath = executablePathForTarget(target);
  const appBundle = executablePath
    .split(path.sep)
    .find((segment) => segment.toLocaleLowerCase().endsWith('.app'));
  if (appBundle !== undefined) {
    return appBundle.slice(0, -4);
  }

  const fallback: Record<BrowserProduct, string> = {
    brave: 'Brave Browser',
    chrome: 'Google Chrome',
    chromium: 'Chromium',
    edge: 'Microsoft Edge',
    firefox: 'Firefox',
    webkit: 'WebKit',
  };
  return fallback[target.browser];
}

export function launchIdentityForTarget(
  target: BrowserLaunchTarget,
  profileRoot: string,
): BrowserLaunchIdentity {
  return {
    browser: target.browser,
    engine: target.engine,
    applicationName: applicationNameForTarget(target),
    executablePath: executablePathForTarget(target),
    executableSource: target.source,
    profile: profileBindingForBrowser(profileRoot, target.engine),
  };
}

export function sameLaunchIdentity(left: BrowserLaunchIdentity, right: BrowserLaunchIdentity): boolean {
  return left.browser === right.browser
    && left.engine === right.engine
    && left.executablePath === right.executablePath
    && left.profile.userDataDir === right.profile.userDataDir
    && left.profile.profileDirectory === right.profile.profileDirectory
    && left.profile.profilePath === right.profile.profilePath;
}

export function controlledProfileArguments(binding: BrowserProfileBinding): string[] {
  return binding.profileDirectory === null
    ? []
    : [`--profile-directory=${binding.profileDirectory}`];
}

async function fileMetadata(candidate: string): Promise<FileMetadata | null> {
  try {
    const metadata = await stat(candidate);
    return metadata.isFile() ? { modifiedAt: metadata.mtime.toISOString() } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function targetHostname(targetOrigin: string | null): string | null {
  if (targetOrigin === null) {
    return null;
  }
  try {
    const parsed = new URL(targetOrigin);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.hostname.toLocaleLowerCase()
      : null;
  } catch {
    return null;
  }
}

function cookieKeyToken(row: CookieKeyRow): string {
  return createHash('sha256')
    .update(row.host)
    .update('\0')
    .update(row.name)
    .update('\0')
    .update(row.persistent ? 'persistent' : 'session')
    .digest('hex');
}

async function readCookieKeys(
  databasePath: string,
  engine: BrowserEngine,
  hostname: string,
): Promise<CookieKeyRow[]> {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (engine === 'chromium') {
      const rows = database.prepare(`
        SELECT host_key AS host, name, is_persistent AS persistence
        FROM cookies
        WHERE ltrim(host_key, '.') = ? OR ? LIKE '%.' || ltrim(host_key, '.')
      `).all(hostname, hostname) as Array<Record<string, unknown>>;
      return rows
        .filter((row) => typeof row.host === 'string' && typeof row.name === 'string')
        .map((row) => ({
          host: String(row.host).toLocaleLowerCase(),
          name: String(row.name),
          persistent: Number(row.persistence) !== 0,
        }));
    }

    const rows = database.prepare(`
      SELECT host, name, isSession AS session
      FROM moz_cookies
      WHERE ltrim(host, '.') = ? OR ? LIKE '%.' || ltrim(host, '.')
    `).all(hostname, hostname) as Array<Record<string, unknown>>;
    return rows
      .filter((row) => typeof row.host === 'string' && typeof row.name === 'string')
      .map((row) => ({
        host: String(row.host).toLocaleLowerCase(),
        name: String(row.name),
        persistent: Number(row.session) === 0,
      }));
  } finally {
    database.close();
  }
}

function unsupportedStorage(
  observedAt: string,
  targetOrigin: string | null,
): ProfileStorageInspection {
  return {
    observedAt,
    targetOrigin,
    cookieDatabase: {
      supported: false,
      databaseKind: 'missing',
      relativePath: null,
      exists: false,
      modifiedAt: null,
      journalModifiedAt: null,
      locations: [],
      targetOriginCookiePresent: null,
      sessionCookiePresent: null,
      persistentCookiePresent: null,
      inspection: 'unsupported',
    },
    keyTokens: null,
  };
}

export async function inspectProfileStorage(
  binding: BrowserProfileBinding,
  engine: BrowserEngine,
  targetOrigin: string | null,
  options: { liveBrowser?: boolean } = {},
): Promise<ProfileStorageInspection> {
  const observedAt = new Date().toISOString();
  const hostname = targetHostname(targetOrigin);
  if (engine === 'webkit' || hostname === null) {
    return unsupportedStorage(observedAt, targetOrigin);
  }

  const candidates = engine === 'chromium'
    ? [
        { kind: 'chromium_network' as const, relativePath: 'Network/Cookies' as const },
        { kind: 'chromium_legacy' as const, relativePath: 'Cookies' as const },
      ]
    : [{ kind: 'firefox' as const, relativePath: 'cookies.sqlite' as const }];

  const existing = (await Promise.all(candidates.map(async (candidate) => {
    const databasePath = path.join(binding.profilePath, candidate.relativePath);
    const metadata = await fileMetadata(databasePath);
    if (metadata === null) {
      return null;
    }
    const journalMetadata = await fileMetadata(`${databasePath}-wal`);
    return {
      candidate,
      databasePath,
      metadata,
      journalModifiedAt: journalMetadata?.modifiedAt ?? null,
    };
  }))).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  if (existing.length === 0) {
    return {
      observedAt,
      targetOrigin,
      cookieDatabase: {
        supported: true,
        databaseKind: 'missing',
        relativePath: null,
        exists: false,
        modifiedAt: null,
        journalModifiedAt: null,
        locations: [],
        targetOriginCookiePresent: false,
        sessionCookiePresent: false,
        persistentCookiePresent: false,
        inspection: 'database_missing',
      },
      keyTokens: new Set(),
    };
  }

  if (options.liveBrowser === true) {
    const selected = existing[0]!;
    return {
      observedAt,
      targetOrigin,
      cookieDatabase: {
        supported: true,
        databaseKind: selected.candidate.kind,
        relativePath: selected.candidate.relativePath,
        exists: true,
        modifiedAt: selected.metadata.modifiedAt,
        journalModifiedAt: selected.journalModifiedAt,
        locations: existing.map((entry) => ({
          databaseKind: entry.candidate.kind,
          relativePath: entry.candidate.relativePath,
          modifiedAt: entry.metadata.modifiedAt,
          journalModifiedAt: entry.journalModifiedAt,
          inspection: 'live_process_metadata_only',
        })),
        targetOriginCookiePresent: null,
        sessionCookiePresent: null,
        persistentCookiePresent: null,
        inspection: 'live_process_metadata_only',
      },
      keyTokens: null,
    };
  }

  const inspected = await Promise.all(existing.map(async (entry) => {
    try {
      return { ...entry, keys: await readCookieKeys(entry.databasePath, engine, hostname) };
    } catch {
      return { ...entry, keys: null };
    }
  }));
  const readable = inspected.filter(
    (entry): entry is typeof entry & { keys: CookieKeyRow[] } => entry.keys !== null,
  );
  const locations: CookieDatabaseFileMetadata[] = inspected.map((entry) => ({
    databaseKind: entry.candidate.kind,
    relativePath: entry.candidate.relativePath,
    modifiedAt: entry.metadata.modifiedAt,
    journalModifiedAt: entry.journalModifiedAt,
    inspection: entry.keys === null ? 'database_unavailable' : 'aggregate_metadata',
  }));

  if (readable.length > 0) {
    const selected = readable.find((entry) => entry.keys.length > 0) ?? readable[0]!;
    const keys = readable.flatMap((entry) => entry.keys);
    return {
      observedAt,
      targetOrigin,
      cookieDatabase: {
        supported: true,
        databaseKind: selected.candidate.kind,
        relativePath: selected.candidate.relativePath,
        exists: true,
        modifiedAt: selected.metadata.modifiedAt,
        journalModifiedAt: selected.journalModifiedAt,
        locations,
        targetOriginCookiePresent: keys.length > 0,
        sessionCookiePresent: keys.some((key) => !key.persistent),
        persistentCookiePresent: keys.some((key) => key.persistent),
        inspection: 'aggregate_metadata',
      },
      keyTokens: new Set(keys.map(cookieKeyToken)),
    };
  }

  const selected = inspected[0]!;
  return {
    observedAt,
    targetOrigin,
    cookieDatabase: {
      supported: true,
      databaseKind: selected.candidate.kind,
      relativePath: selected.candidate.relativePath,
      exists: true,
      modifiedAt: selected.metadata.modifiedAt,
      journalModifiedAt: selected.journalModifiedAt,
      locations,
      targetOriginCookiePresent: null,
      sessionCookiePresent: null,
      persistentCookiePresent: null,
      inspection: 'database_unavailable',
    },
    keyTokens: null,
  };
}

export function publicStorageObservation(
  inspection: ProfileStorageInspection,
): PublicProfileStorageObservation {
  return {
    observedAt: inspection.observedAt,
    targetOrigin: inspection.targetOrigin,
    cookieDatabase: inspection.cookieDatabase,
  };
}

function setEquals(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export function compareAuthenticationStorage(
  beforeHandoff: ProfileStorageInspection,
  afterHumanBrowser: ProfileStorageInspection,
  afterReattachment: ProfileStorageInspection,
): { continuity: AuthenticationStorageContinuity; authNotPersisted: boolean } {
  const beforeKeys = beforeHandoff.keyTokens;
  const humanKeys = afterHumanBrowser.keyTokens;
  const reattachedKeys = afterReattachment.keyTokens;
  const comparable = beforeKeys !== null && humanKeys !== null && reattachedKeys !== null;
  const humanStorageChanged = beforeKeys === null || humanKeys === null
    ? null
    : !setEquals(beforeKeys, humanKeys);
  const reattachmentPreservedHumanStorage = humanKeys === null || reattachedKeys === null
    ? null
    : [...humanKeys].every((value) => reattachedKeys.has(value));
  const humanAddedKeys = beforeKeys === null || humanKeys === null
    ? null
    : [...humanKeys].filter((value) => !beforeKeys.has(value));
  const humanSessionEvidenceObserved = humanAddedKeys === null
    ? null
    : humanAddedKeys.length > 0;
  const addedKeysLost = humanAddedKeys === null || reattachedKeys === null
    ? false
    : humanAddedKeys.some((value) => !reattachedKeys.has(value));
  const allTargetCookiesLost = afterHumanBrowser.cookieDatabase.targetOriginCookiePresent === true
    && afterReattachment.cookieDatabase.targetOriginCookiePresent === false;
  const authNotPersisted = comparable
    && humanSessionEvidenceObserved === true
    && (addedKeysLost || allTargetCookiesLost);

  return {
    continuity: {
      beforeHandoff: publicStorageObservation(beforeHandoff),
      afterHumanBrowser: publicStorageObservation(afterHumanBrowser),
      afterReattachment: publicStorageObservation(afterReattachment),
      humanStorageChanged,
      reattachmentPreservedHumanStorage,
      humanSessionEvidenceObserved,
      state: authNotPersisted
        ? 'lost'
        : comparable && reattachmentPreservedHumanStorage === true
          ? 'preserved'
          : 'unverified',
    },
    authNotPersisted,
  };
}
