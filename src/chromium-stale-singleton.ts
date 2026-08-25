import { createHash } from 'node:crypto';
import { lstat, readlink, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

import { profileLocks } from './human-auth-bootstrap.js';
import { processIsRunning } from './native-control-channel.js';
import { chromiumProfileLockProcessId } from './native-window-activation.js';
import type { BrowserLaunchIdentity } from './profile-binding.js';
import {
  profilePathFingerprint,
  readProfileOwnershipLease,
  type ProfileOwnershipLeaseInspection,
} from './profile-ownership-lease.js';

const SINGLETON_NAMES = ['SingletonCookie', 'SingletonSocket', 'SingletonLock'] as const;

interface SingletonEntryIdentity {
  name: (typeof SINGLETON_NAMES)[number];
  device: number;
  inode: number;
  mode: number;
  size: number;
  modifiedAtMs: number;
  symbolicLinkTarget: string | null;
}

export interface ProvenExitedPlaywrightSingleton {
  leaseId: string;
  browserProcessId: number;
  browserExecutableFingerprint: string;
  executablePath: string;
  entries: SingletonEntryIdentity[];
}

async function executableFingerprint(executablePath: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await realpath(executablePath)).digest('hex');
  } catch {
    return null;
  }
}

async function singletonEntries(profileRoot: string): Promise<SingletonEntryIdentity[] | null> {
  const entries: SingletonEntryIdentity[] = [];
  for (const name of SINGLETON_NAMES) {
    const candidate = path.join(profileRoot, name);
    try {
      const metadata = await lstat(candidate);
      if (metadata.isDirectory()) return null;
      entries.push({
        name,
        device: metadata.dev,
        inode: metadata.ino,
        mode: metadata.mode,
        size: metadata.size,
        modifiedAtMs: metadata.mtimeMs,
        symbolicLinkTarget: metadata.isSymbolicLink() ? await readlink(candidate) : null,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
  }
  return entries;
}

function sameEntries(
  left: readonly SingletonEntryIdentity[],
  right: readonly SingletonEntryIdentity[],
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && candidate.name === entry.name
      && candidate.device === entry.device
      && candidate.inode === entry.inode
      && candidate.mode === entry.mode
      && candidate.size === entry.size
      && candidate.modifiedAtMs === entry.modifiedAtMs
      && candidate.symbolicLinkTarget === entry.symbolicLinkTarget;
  });
}

export async function proveExitedPlaywrightSingleton(
  profileRoot: string,
  identity: BrowserLaunchIdentity,
  inspection: ProfileOwnershipLeaseInspection,
): Promise<ProvenExitedPlaywrightSingleton | null> {
  const lease = inspection.lease;
  if (
    inspection.state !== 'abandoned'
    || inspection.ownerWorkerRunning !== false
    || inspection.browserProcess !== 'not_running'
    || lease === null
    || lease.browser !== identity.browser
    || lease.engine !== identity.engine
    || lease.profileFingerprint !== profilePathFingerprint(profileRoot)
    || lease.controlMode !== 'playwright'
    || lease.phase !== 'process_exited'
    || lease.browserProcessId === null
    || lease.browserExecutableFingerprint === null
  ) {
    return null;
  }
  const locks = await profileLocks(profileRoot);
  if (
    locks.length === 0
    || !locks.includes('SingletonLock')
    || locks.some((name) => !name.startsWith('Singleton'))
  ) {
    return null;
  }
  const [fingerprint, lockProcessId, entries] = await Promise.all([
    executableFingerprint(identity.executablePath),
    chromiumProfileLockProcessId(profileRoot),
    singletonEntries(profileRoot),
  ]);
  if (
    fingerprint === null
    || fingerprint !== lease.browserExecutableFingerprint
    || lockProcessId !== lease.browserProcessId
    || entries === null
    || entries.length === 0
    || processIsRunning(lockProcessId)
  ) {
    return null;
  }
  const revalidatedLockProcessId = await chromiumProfileLockProcessId(profileRoot);
  if (
    revalidatedLockProcessId !== lockProcessId
    || processIsRunning(revalidatedLockProcessId)
  ) {
    return null;
  }
  return {
    leaseId: lease.leaseId,
    browserProcessId: lease.browserProcessId,
    browserExecutableFingerprint: lease.browserExecutableFingerprint,
    executablePath: identity.executablePath,
    entries,
  };
}

export async function removeProvenExitedPlaywrightSingletonFiles(
  profileRoot: string,
  proof: ProvenExitedPlaywrightSingleton,
): Promise<boolean> {
  const [lease, fingerprint, lockProcessId, entries] = await Promise.all([
    readProfileOwnershipLease(profileRoot),
    executableFingerprint(proof.executablePath),
    chromiumProfileLockProcessId(profileRoot),
    singletonEntries(profileRoot),
  ]);
  if (
    lease?.leaseId !== proof.leaseId
    || lease.controlMode !== 'playwright'
    || lease.phase !== 'process_exited'
    || lease.browserProcessId !== proof.browserProcessId
    || lease.browserExecutableFingerprint !== proof.browserExecutableFingerprint
    || fingerprint !== proof.browserExecutableFingerprint
    || lockProcessId !== proof.browserProcessId
    || processIsRunning(lockProcessId)
    || entries === null
    || !sameEntries(proof.entries, entries)
  ) {
    return false;
  }
  try {
    for (const name of SINGLETON_NAMES) {
      if (entries.some((entry) => entry.name === name)) {
        await rm(path.join(profileRoot, name));
      }
    }
  } catch {
    return false;
  }
  return (await profileLocks(profileRoot)).length === 0;
}
