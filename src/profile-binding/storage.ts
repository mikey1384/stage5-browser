import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { BrowserContext } from 'playwright';

import type { BrowserEngine } from '../browser-provider.js';
import { playwrightBrowserType } from '../browser-provider.js';
import type { AuthenticationStorageContinuity, BrowserProfileBinding, CookieDatabaseFileMetadata, CookieDatabaseMetadata, CookieKeyRow, FileMetadata, LiveCookieKeyMetadata, ProfileStorageInspection, PublicProfileStorageObservation } from './types.js';

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

export async function inspectControlledProfileStorage(
  binding: BrowserProfileBinding,
  engine: BrowserEngine,
  targetOrigin: string | null,
  readCookies: (urls: string[]) => Promise<readonly LiveCookieKeyMetadata[]>,
): Promise<ProfileStorageInspection> {
  const fileObservation = await inspectProfileStorage(binding, engine, targetOrigin, { liveBrowser: true });
  const hostname = targetHostname(targetOrigin);
  if (hostname === null || engine === 'webkit') {
    return fileObservation;
  }
  try {
    const cookies = await readCookies([targetOrigin!]);
    const keys = cookies
      .filter((cookie) => {
        const domain = cookie.domain.replace(/^\./, '').toLocaleLowerCase();
        return domain === hostname || hostname.endsWith(`.${domain}`);
      })
      .map((cookie) => ({
        host: cookie.domain.toLocaleLowerCase(),
        name: cookie.name,
        persistent: Number.isFinite(cookie.expires) && cookie.expires > 0,
      }));
    return {
      observedAt: new Date().toISOString(),
      targetOrigin,
      cookieDatabase: {
        ...fileObservation.cookieDatabase,
        targetOriginCookiePresent: keys.length > 0,
        sessionCookiePresent: keys.some((key) => !key.persistent),
        persistentCookiePresent: keys.some((key) => key.persistent),
        inspection: 'live_context_metadata',
      },
      keyTokens: new Set(keys.map(cookieKeyToken)),
    };
  } catch {
    return fileObservation;
  }
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
  afterControlledStart: ProfileStorageInspection,
  afterTargetLoad: ProfileStorageInspection,
  context: {
    targetOriginLoadedAtControlledStart: boolean;
    navigatorWebdriverAtControlledStart: boolean | null;
  },
): { continuity: AuthenticationStorageContinuity; authNotPersisted: boolean } {
  const beforeKeys = beforeHandoff.keyTokens;
  const humanKeys = afterHumanBrowser.keyTokens;
  const controlledStartKeys = afterControlledStart.keyTokens;
  const targetLoadKeys = afterTargetLoad.keyTokens;
  const comparable = beforeKeys !== null
    && humanKeys !== null
    && controlledStartKeys !== null
    && targetLoadKeys !== null;
  const humanStorageChanged = beforeKeys === null || humanKeys === null
    ? null
    : !setEquals(beforeKeys, humanKeys);
  const controlledStartPreservedHumanStorage = humanKeys === null || controlledStartKeys === null
    ? null
    : [...humanKeys].every((value) => controlledStartKeys.has(value));
  const targetLoadPreservedControlledStorage = controlledStartKeys === null || targetLoadKeys === null
    ? null
    : [...controlledStartKeys].every((value) => targetLoadKeys.has(value));
  const reattachmentPreservedHumanStorage = humanKeys === null || targetLoadKeys === null
    ? null
    : [...humanKeys].every((value) => targetLoadKeys.has(value));
  const humanAddedKeys = beforeKeys === null || humanKeys === null
    ? null
    : [...humanKeys].filter((value) => !beforeKeys.has(value));
  const humanSessionEvidenceObserved = humanAddedKeys === null
    ? null
    : humanAddedKeys.length > 0;
  const addedKeysLostAtControlledStart = humanAddedKeys === null || controlledStartKeys === null
    ? false
    : humanAddedKeys.some((value) => !controlledStartKeys.has(value));
  const addedKeysLostAtTargetLoad = humanAddedKeys === null || targetLoadKeys === null
    ? false
    : humanAddedKeys.some((value) => !targetLoadKeys.has(value));
  const allTargetCookiesLostAtControlledStart =
    afterHumanBrowser.cookieDatabase.targetOriginCookiePresent === true
    && afterControlledStart.cookieDatabase.targetOriginCookiePresent === false;
  const allTargetCookiesLostAtTargetLoad =
    afterControlledStart.cookieDatabase.targetOriginCookiePresent === true
    && afterTargetLoad.cookieDatabase.targetOriginCookiePresent === false;
  const controlledStartLoss = addedKeysLostAtControlledStart || allTargetCookiesLostAtControlledStart;
  const targetLoadLoss = !controlledStartLoss
    && (addedKeysLostAtTargetLoad || allTargetCookiesLostAtTargetLoad);
  const lossBoundary: AuthenticationStorageContinuity['lossBoundary'] = controlledStartLoss
    ? context.targetOriginLoadedAtControlledStart
      ? 'playwright_start_or_restored_target_load'
      : 'playwright_start'
    : targetLoadLoss
      ? 'target_load'
      : comparable && reattachmentPreservedHumanStorage === true
        ? 'none'
        : 'unverified';
  const automationCorrelation: AuthenticationStorageContinuity['automationCorrelation'] =
    (lossBoundary === 'target_load' || lossBoundary === 'playwright_start_or_restored_target_load')
      && context.navigatorWebdriverAtControlledStart === true
      ? 'loss_after_automation_exposure'
      : lossBoundary === 'unverified'
        ? 'unverified'
        : 'not_observed';
  const authNotPersisted = comparable
    && humanSessionEvidenceObserved === true
    && (controlledStartLoss || targetLoadLoss);

  return {
    continuity: {
      beforeHandoff: publicStorageObservation(beforeHandoff),
      afterHumanBrowser: publicStorageObservation(afterHumanBrowser),
      afterControlledStart: publicStorageObservation(afterControlledStart),
      afterTargetLoad: publicStorageObservation(afterTargetLoad),
      afterReattachment: publicStorageObservation(afterTargetLoad),
      humanStorageChanged,
      controlledStartPreservedHumanStorage,
      targetLoadPreservedControlledStorage,
      reattachmentPreservedHumanStorage,
      humanSessionEvidenceObserved,
      targetOriginLoadedAtControlledStart: context.targetOriginLoadedAtControlledStart,
      navigatorWebdriverAtControlledStart: context.navigatorWebdriverAtControlledStart,
      lossBoundary,
      automationCorrelation,
      state: controlledStartLoss || targetLoadLoss
        ? 'lost'
        : comparable && reattachmentPreservedHumanStorage === true
          ? 'preserved'
          : 'unverified',
    },
    authNotPersisted,
  };
}
