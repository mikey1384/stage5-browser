import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type { BrowserLaunchTarget } from '../src/browser-provider.js';
import {
  compareAuthenticationStorage,
  controlledProfileArguments,
  inspectControlledProfileStorage,
  inspectProfileStorage,
  launchIdentityForTarget,
  profileBindingForBrowser,
  publicStorageObservation,
  runtimeProfileFromChromiumArguments,
  runtimeProfileFromChromiumVersionPath,
  sameLaunchIdentity,
  type ProfileStorageInspection,
} from '../src/profile-binding.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function chromiumTarget(overrides: Partial<BrowserLaunchTarget> = {}): BrowserLaunchTarget {
  return {
    browser: 'brave',
    engine: 'chromium',
    executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    source: 'discovered',
    ...overrides,
  };
}

async function cookieDatabase(
  root: string,
  relativePath: 'Cookies' | 'Network/Cookies' = 'Cookies',
): Promise<DatabaseSync> {
  const databasePath = path.join(root, 'Default', relativePath);
  await mkdir(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE cookies (
      host_key TEXT NOT NULL,
      name TEXT NOT NULL,
      is_persistent INTEGER NOT NULL
    )
  `);
  return database;
}

function storageKeys(targetOrigin: string, keys: string[]): ProfileStorageInspection {
  return {
    observedAt: '2026-08-24T00:00:00.000Z',
    targetOrigin,
    cookieDatabase: {
      supported: true,
      databaseKind: 'chromium_network',
      relativePath: 'Network/Cookies',
      exists: true,
      modifiedAt: '2026-08-24T00:00:00.000Z',
      journalModifiedAt: null,
      locations: [],
      targetOriginCookiePresent: keys.length > 0,
      sessionCookiePresent: keys.length > 0,
      persistentCookiePresent: false,
      inspection: 'aggregate_metadata',
    },
    keyTokens: new Set(keys),
  };
}

describe('browser profile binding', () => {
  it('pins Chromium control and human bootstrap to the same Default partition', () => {
    const root = '/private/tmp/stage5-profile-binding';
    const binding = profileBindingForBrowser(root, 'chromium');
    expect(binding).toEqual({
      storageKind: 'chromium_user_data',
      userDataDir: root,
      profileDirectory: 'Default',
      profilePath: path.join(root, 'Default'),
    });
    expect(controlledProfileArguments(binding)).toEqual(['--profile-directory=Default']);

    const left = launchIdentityForTarget(chromiumTarget(), root);
    const right = launchIdentityForTarget(chromiumTarget(), root);
    expect(left).toMatchObject({
      browser: 'brave',
      applicationName: 'Brave Browser',
      executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      profile: binding,
    });
    expect(sameLaunchIdentity(left, right)).toBe(true);
    expect(sameLaunchIdentity(left, {
      ...right,
      profile: { ...right.profile, profileDirectory: 'Profile 1' },
    })).toBe(false);
  });

  it('reduces the live chrome version profile path to an allowlisted runtime observation', () => {
    const configured = profileBindingForBrowser('/private/tmp/stage5-browser-runtime', 'chromium');
    expect(runtimeProfileFromChromiumVersionPath(
      '/private/tmp/stage5-browser-runtime/Default',
      configured,
      '2026-08-24T00:00:00.000Z',
    )).toEqual({
      observedAt: '2026-08-24T00:00:00.000Z',
      source: 'chromium_version_page',
      userDataDir: '/private/tmp/stage5-browser-runtime',
      profileDirectory: 'Default',
      profilePath: '/private/tmp/stage5-browser-runtime/Default',
      configuredProfilePath: '/private/tmp/stage5-browser-runtime/Default',
      matchesConfigured: true,
    });
  });

  it('detects target-origin cookie-key loss without exposing cookie names or values', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-profile-storage-'));
    temporaryRoots.push(root);
    const database = await cookieDatabase(root);
    const binding = profileBindingForBrowser(root, 'chromium');
    const before = await inspectProfileStorage(binding, 'chromium', 'https://account.example.com');

    database.prepare('INSERT INTO cookies (host_key, name, is_persistent) VALUES (?, ?, ?)')
      .run('.example.com', 'private-auth-cookie-name', 1);
    const afterHuman = await inspectProfileStorage(binding, 'chromium', 'https://account.example.com');
    const afterControlledStart = await inspectProfileStorage(
      binding,
      'chromium',
      'https://account.example.com',
    );
    database.prepare('DELETE FROM cookies').run();
    const afterTargetLoad = await inspectProfileStorage(
      binding,
      'chromium',
      'https://account.example.com',
    );
    database.close();

    const comparison = compareAuthenticationStorage(
      before,
      afterHuman,
      afterControlledStart,
      afterTargetLoad,
      {
        targetOriginLoadedAtControlledStart: false,
        navigatorWebdriverAtControlledStart: true,
      },
    );
    expect(comparison.authNotPersisted).toBe(true);
    expect(comparison.continuity).toMatchObject({
      humanStorageChanged: true,
      reattachmentPreservedHumanStorage: false,
      humanSessionEvidenceObserved: true,
      lossBoundary: 'target_load',
      automationCorrelation: 'loss_after_automation_exposure',
      state: 'lost',
      afterHumanBrowser: {
        cookieDatabase: {
          targetOriginCookiePresent: true,
          sessionCookiePresent: false,
          persistentCookiePresent: true,
        },
      },
      afterReattachment: {
        cookieDatabase: { targetOriginCookiePresent: false },
      },
    });
    expect(JSON.stringify(comparison.continuity)).not.toContain('private-auth-cookie-name');
    expect(JSON.stringify(publicStorageObservation(afterHuman))).not.toContain('private-auth-cookie-name');
  });

  it('reports preserved continuity when reattachment retains the human-added keys', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-profile-preserved-'));
    temporaryRoots.push(root);
    const database = await cookieDatabase(root);
    const binding = profileBindingForBrowser(root, 'chromium');
    const before = await inspectProfileStorage(binding, 'chromium', 'https://example.com');
    database.prepare('INSERT INTO cookies (host_key, name, is_persistent) VALUES (?, ?, ?)')
      .run('example.com', 'session-marker', 0);
    const afterHuman = await inspectProfileStorage(binding, 'chromium', 'https://example.com');
    const afterControlledStart = await inspectProfileStorage(binding, 'chromium', 'https://example.com');
    const afterTargetLoad = await inspectProfileStorage(binding, 'chromium', 'https://example.com');
    database.close();

    expect(compareAuthenticationStorage(
      before,
      afterHuman,
      afterControlledStart,
      afterTargetLoad,
      {
        targetOriginLoadedAtControlledStart: false,
        navigatorWebdriverAtControlledStart: true,
      },
    )).toMatchObject({
      authNotPersisted: false,
      continuity: {
        state: 'preserved',
        reattachmentPreservedHumanStorage: true,
        humanSessionEvidenceObserved: true,
      },
    });
  });

  it('distinguishes controlled-start loss from an already-restored target boundary', () => {
    const origin = 'https://x.com';
    const before = storageKeys(origin, []);
    const afterHuman = storageKeys(origin, ['human-session-key']);
    const afterControlledStart = storageKeys(origin, []);
    const afterTargetLoad = storageKeys(origin, []);

    expect(compareAuthenticationStorage(
      before,
      afterHuman,
      afterControlledStart,
      afterTargetLoad,
      {
        targetOriginLoadedAtControlledStart: false,
        navigatorWebdriverAtControlledStart: true,
      },
    ).continuity).toMatchObject({
      lossBoundary: 'playwright_start',
      automationCorrelation: 'not_observed',
      state: 'lost',
    });

    expect(compareAuthenticationStorage(
      before,
      afterHuman,
      afterControlledStart,
      afterTargetLoad,
      {
        targetOriginLoadedAtControlledStart: true,
        navigatorWebdriverAtControlledStart: true,
      },
    ).continuity).toMatchObject({
      lossBoundary: 'playwright_start_or_restored_target_load',
      automationCorrelation: 'loss_after_automation_exposure',
      state: 'lost',
    });
  });

  it('reduces live browser cookies to privacy-safe key presence without retaining values', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-profile-live-'));
    temporaryRoots.push(root);
    const database = await cookieDatabase(root);
    database.close();
    const inspection = await inspectControlledProfileStorage(
      profileBindingForBrowser(root, 'chromium'),
      'chromium',
      'https://account.example.com',
      async () => [
        {
          domain: '.example.com',
          name: 'private-auth-cookie-name',
          expires: Date.now() / 1_000 + 3_600,
          value: 'private-cookie-value-never-read',
        },
      ],
    );

    expect(inspection.cookieDatabase).toMatchObject({
      inspection: 'live_context_metadata',
      targetOriginCookiePresent: true,
      sessionCookiePresent: false,
      persistentCookiePresent: true,
    });
    expect(inspection.keyTokens?.size).toBe(1);
    expect(JSON.stringify(publicStorageObservation(inspection))).not.toContain('private-auth-cookie-name');
    expect(JSON.stringify(publicStorageObservation(inspection))).not.toContain('private-cookie-value-never-read');
  });

  it('reports the actual Chromium runtime profile from only allowlisted command-line fields', () => {
    const configured = profileBindingForBrowser('/private/tmp/stage5-runtime-profile', 'chromium');
    expect(runtimeProfileFromChromiumArguments([
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '--enable-automation',
      '--user-data-dir=/private/tmp/stage5-runtime-profile',
      '--profile-directory=Default',
      '--remote-debugging-pipe',
    ], configured, '2026-08-24T01:02:03.000Z')).toEqual({
      observedAt: '2026-08-24T01:02:03.000Z',
      source: 'chromium_command_line',
      userDataDir: '/private/tmp/stage5-runtime-profile',
      profileDirectory: 'Default',
      profilePath: '/private/tmp/stage5-runtime-profile/Default',
      configuredProfilePath: '/private/tmp/stage5-runtime-profile/Default',
      matchesConfigured: true,
    });
  });

  it('unions legacy and Network cookie stores during a Chromium migration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-profile-migration-'));
    temporaryRoots.push(root);
    const networkDatabase = await cookieDatabase(root, 'Network/Cookies');
    const legacyDatabase = await cookieDatabase(root, 'Cookies');
    legacyDatabase.prepare('INSERT INTO cookies (host_key, name, is_persistent) VALUES (?, ?, ?)')
      .run('example.com', 'persistent-marker', 1);

    const inspection = await inspectProfileStorage(
      profileBindingForBrowser(root, 'chromium'),
      'chromium',
      'https://example.com',
    );
    networkDatabase.close();
    legacyDatabase.close();

    expect(inspection.cookieDatabase).toMatchObject({
      databaseKind: 'chromium_legacy',
      relativePath: 'Cookies',
      targetOriginCookiePresent: true,
      persistentCookiePresent: true,
      locations: [
        { databaseKind: 'chromium_network', relativePath: 'Network/Cookies' },
        { databaseKind: 'chromium_legacy', relativePath: 'Cookies' },
      ],
    });
  });
});
