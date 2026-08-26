import { execFile } from 'node:child_process';
import { lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { BrowserProduct } from './browser-provider.js';

export type ProfileShutdownState = 'clean' | 'unclean' | 'unknown';

export interface ProfileShutdownInspection {
  state: ProfileShutdownState;
  exitType: 'crashed' | 'normal' | 'session_ended' | 'unknown' | null;
  exitedCleanly: boolean | null;
  exitedCleanlySource: 'preferences_flag' | 'exit_type' | 'profile_lock' | 'process_exit' | 'insufficient_evidence';
  profileDirectory: string | null;
  profileLocks: string[];
  preferencesModifiedAt: string | null;
}

export type ProfileExitMarkerComparison =
  | 'unchanged_from_before_handoff'
  | 'rewritten_with_same_value'
  | 'changed_during_handoff'
  | 'unavailable';

export interface ProfileShutdownDecision extends ProfileShutdownInspection {
  exitTypeComparison: ProfileExitMarkerComparison;
  currentSessionEvidence: 'clean_process_exit' | 'abnormal_process_exit' | 'process_exit_unknown';
  reattachmentDecision: 'allowed' | 'override_available' | 'explicit_unlocked_profile_override';
}

const PROFILE_LOCK_NAMES = [
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  '.parentlock',
  'parent.lock',
  'lock',
] as const;

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function macFirefoxParentLockHeld(candidate: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/usr/sbin/lsof', ['-t', candidate], {
      encoding: 'utf8',
      maxBuffer: 64 * 1_024,
      timeout: 1_000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve(true);
        return;
      }
      if (error !== null && (error as Error & { killed?: boolean }).killed === true) {
        resolve(true);
        return;
      }
      if (error === null) {
        resolve(stdout.trim().length > 0);
        return;
      }
      const exitCode = (error as Error & { code?: string | number }).code;
      resolve(!(exitCode === 1 && stdout.trim().length === 0 && stderr.trim().length === 0));
    });
  });
}

async function activeProfileLock(
  profileDir: string,
  name: (typeof PROFILE_LOCK_NAMES)[number],
): Promise<boolean> {
  const candidate = path.join(profileDir, name);
  if (!(await pathExists(candidate))) return false;
  if (process.platform === 'darwin' && name === '.parentlock') {
    return macFirefoxParentLockHeld(candidate);
  }
  return true;
}

export async function profileLocks(profileDir: string): Promise<string[]> {
  const checks = await Promise.all(
    PROFILE_LOCK_NAMES.map(async (name) => ({ name, exists: await activeProfileLock(profileDir, name) })),
  );
  return checks.filter((entry) => entry.exists).map((entry) => entry.name);
}

export async function waitForProfileUnlock(profileDir: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  do {
    if ((await profileLocks(profileDir)).length === 0) return true;
    if (Date.now() - startedAt >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, timeoutMs - (Date.now() - startedAt))));
  } while (Date.now() - startedAt < timeoutMs);
  return (await profileLocks(profileDir)).length === 0;
}

async function readJson(candidate: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(candidate, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function modifiedAt(candidate: string): Promise<string | null> {
  try {
    return (await stat(candidate)).mtime.toISOString();
  } catch {
    return null;
  }
}

function safeProfileDirectoryName(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9 _.-]{1,80}$/.test(value) && !value.includes('..')
    ? value
    : 'Default';
}

function normalizedExitType(value: unknown): ProfileShutdownInspection['exitType'] {
  if (typeof value !== 'string') return null;
  switch (value.toLocaleLowerCase()) {
    case 'normal':
      return 'normal';
    case 'sessionended':
    case 'session_ended':
      return 'session_ended';
    case 'crashed':
      return 'crashed';
    default:
      return 'unknown';
  }
}

export async function inspectProfileShutdown(
  profileDir: string,
  browser: BrowserProduct,
  pinnedProfileDirectory?: string | null,
): Promise<ProfileShutdownInspection> {
  const locks = await profileLocks(profileDir);
  if (!['chromium', 'chrome', 'brave', 'edge'].includes(browser)) {
    return {
      state: locks.length === 0 ? 'unknown' : 'unclean',
      exitType: null,
      exitedCleanly: null,
      exitedCleanlySource: locks.length > 0 ? 'profile_lock' : 'insufficient_evidence',
      profileDirectory: null,
      profileLocks: locks,
      preferencesModifiedAt: null,
    };
  }

  const localState = await readJson(path.join(profileDir, 'Local State'));
  const localStateProfile = localState?.profile;
  const profileName = pinnedProfileDirectory === undefined
    ? safeProfileDirectoryName(
        typeof localStateProfile === 'object' && localStateProfile !== null
          ? (localStateProfile as Record<string, unknown>).last_used
          : null,
      )
    : safeProfileDirectoryName(pinnedProfileDirectory);
  const preferencesPath = path.join(profileDir, profileName, 'Preferences');
  const preferences = await readJson(preferencesPath);
  const profile = preferences?.profile;
  const profilePreferences = typeof profile === 'object' && profile !== null
    ? profile as Record<string, unknown>
    : null;
  const exitType = normalizedExitType(profilePreferences?.exit_type);
  const explicitExitedCleanly = typeof profilePreferences?.exited_cleanly === 'boolean'
    ? profilePreferences.exited_cleanly
    : null;
  const exitedCleanly = explicitExitedCleanly !== null
    ? explicitExitedCleanly
    : locks.length > 0 || exitType === 'crashed'
      ? false
      : exitType === 'normal' || exitType === 'session_ended'
        ? true
        : null;
  const exitedCleanlySource: ProfileShutdownInspection['exitedCleanlySource'] =
    explicitExitedCleanly !== null
      ? 'preferences_flag'
      : locks.length > 0
        ? 'profile_lock'
        : exitType === 'normal' || exitType === 'session_ended' || exitType === 'crashed'
          ? 'exit_type'
          : 'insufficient_evidence';
  const clean = locks.length === 0 && (
    exitedCleanly === true || exitType === 'normal' || exitType === 'session_ended'
  );
  const unclean = locks.length > 0 || exitedCleanly === false || exitType === 'crashed';
  return {
    state: unclean ? 'unclean' : clean ? 'clean' : 'unknown',
    exitType,
    exitedCleanly,
    exitedCleanlySource,
    profileDirectory: profileName,
    profileLocks: locks,
    preferencesModifiedAt: await modifiedAt(preferencesPath),
  };
}

export function compareProfileExitMarker(
  before: ProfileShutdownInspection,
  after: ProfileShutdownInspection,
): ProfileExitMarkerComparison {
  if (
    before.exitType === null
    || after.exitType === null
    || before.preferencesModifiedAt === null
    || after.preferencesModifiedAt === null
  ) {
    return 'unavailable';
  }
  if (before.exitType !== after.exitType) return 'changed_during_handoff';
  return before.preferencesModifiedAt === after.preferencesModifiedAt
    ? 'unchanged_from_before_handoff'
    : 'rewritten_with_same_value';
}
