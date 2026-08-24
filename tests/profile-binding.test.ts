import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type { BrowserLaunchTarget } from '../src/browser-provider.js';
import {
  compareAuthenticationStorage,
  controlledProfileArguments,
  inspectProfileStorage,
  launchIdentityForTarget,
  profileBindingForBrowser,
  publicStorageObservation,
  sameLaunchIdentity,
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

  it('detects target-origin cookie-key loss without exposing cookie names or values', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-profile-storage-'));
    temporaryRoots.push(root);
    const database = await cookieDatabase(root);
    const binding = profileBindingForBrowser(root, 'chromium');
    const before = await inspectProfileStorage(binding, 'chromium', 'https://account.example.com');

    database.prepare('INSERT INTO cookies (host_key, name, is_persistent) VALUES (?, ?, ?)')
      .run('.example.com', 'private-auth-cookie-name', 1);
    const afterHuman = await inspectProfileStorage(binding, 'chromium', 'https://account.example.com');
    database.prepare('DELETE FROM cookies').run();
    const afterReattachment = await inspectProfileStorage(
      binding,
      'chromium',
      'https://account.example.com',
    );
    database.close();

    const comparison = compareAuthenticationStorage(before, afterHuman, afterReattachment);
    expect(comparison.authNotPersisted).toBe(true);
    expect(comparison.continuity).toMatchObject({
      humanStorageChanged: true,
      reattachmentPreservedHumanStorage: false,
      humanSessionEvidenceObserved: true,
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
    const afterReattachment = await inspectProfileStorage(binding, 'chromium', 'https://example.com');
    database.close();

    expect(compareAuthenticationStorage(before, afterHuman, afterReattachment)).toMatchObject({
      authNotPersisted: false,
      continuity: {
        state: 'preserved',
        reattachmentPreservedHumanStorage: true,
        humanSessionEvidenceObserved: true,
      },
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
