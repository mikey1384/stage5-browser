import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { BROWSER_ENGINES, SUPPORTED_BROWSER_PRODUCTS, type BrowserProduct } from '../browser-provider.js';
import type { ProfileOwnershipLease } from './types.js';

const OWNERSHIP_LEASE_NAME = '.stage5-browser-ownership.json';

export function profileOwnershipLeasePath(profileRoot: string): string {
  return path.join(profileRoot, OWNERSHIP_LEASE_NAME);
}

export function profilePathFingerprint(profileRoot: string): string {
  return createHash('sha256').update(path.resolve(profileRoot)).digest('hex');
}

function validIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isProfileOwnershipLease(value: unknown): value is ProfileOwnershipLease {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ProfileOwnershipLease>;
  return candidate.version === 1
    && typeof candidate.leaseId === 'string'
    && /^[0-9a-f-]{36}$/i.test(candidate.leaseId)
    && typeof candidate.browser === 'string'
    && (SUPPORTED_BROWSER_PRODUCTS as readonly string[]).includes(candidate.browser)
    && typeof candidate.engine === 'string'
    && BROWSER_ENGINES[candidate.browser as BrowserProduct] === candidate.engine
    && typeof candidate.profileFingerprint === 'string'
    && /^[0-9a-f]{64}$/.test(candidate.profileFingerprint)
    && Number.isSafeInteger(candidate.ownerWorkerProcessId)
    && (candidate.ownerWorkerProcessId ?? 0) > 0
    && typeof candidate.ownerWorkerStartedAt === 'string'
    && (
      (
        candidate.browserProcessId === null
        && candidate.browserProcessStartedAt === null
        && candidate.browserExecutableFingerprint === null
      )
      || (
        Number.isSafeInteger(candidate.browserProcessId)
        && (candidate.browserProcessId ?? 0) > 0
        && typeof candidate.browserProcessStartedAt === 'string'
        && candidate.browserProcessStartedAt.length > 0
        && typeof candidate.browserExecutableFingerprint === 'string'
        && /^[0-9a-f]{64}$/.test(candidate.browserExecutableFingerprint)
      )
    )
    && (candidate.controlMode === 'human_handoff'
      || candidate.controlMode === 'native_cdp'
      || candidate.controlMode === 'playwright')
    && (candidate.phase === 'close_requested'
      || candidate.phase === 'human_input'
      || candidate.phase === 'launching'
      || candidate.phase === 'owned_active'
      || candidate.phase === 'process_exited'
      || candidate.phase === 'profile_unlocked')
    && validIsoDate(candidate.createdAt)
    && validIsoDate(candidate.heartbeatAt);
}

export async function writeProfileOwnershipLease(
  profileRoot: string,
  lease: ProfileOwnershipLease,
): Promise<void> {
  const destination = profileOwnershipLeasePath(profileRoot);
  const temporary = path.join(profileRoot, `.${OWNERSHIP_LEASE_NAME}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  await chmod(destination, 0o600);
}

export async function claimProfileOwnershipLease(
  profileRoot: string,
  lease: ProfileOwnershipLease,
): Promise<boolean> {
  const destination = profileOwnershipLeasePath(profileRoot);
  const temporary = path.join(profileRoot, `.${OWNERSHIP_LEASE_NAME}.${randomUUID()}.claim`);
  try {
    await writeFile(temporary, `${JSON.stringify(lease)}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await link(temporary, destination);
    await chmod(destination, 0o600);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readProfileOwnershipLease(profileRoot: string): Promise<ProfileOwnershipLease | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(profileOwnershipLeasePath(profileRoot), 'utf8'));
    return isProfileOwnershipLease(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function inspectProfileOwnershipLeaseFile(
  profileRoot: string,
): Promise<{ exists: boolean; lease: ProfileOwnershipLease | null }> {
  try {
    const parsed: unknown = JSON.parse(await readFile(profileOwnershipLeasePath(profileRoot), 'utf8'));
    return { exists: true, lease: isProfileOwnershipLease(parsed) ? parsed : null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, lease: null };
    }
    return { exists: true, lease: null };
  }
}

export async function removeProfileOwnershipLease(
  profileRoot: string,
  expectedLeaseId: string,
): Promise<boolean> {
  const current = await readProfileOwnershipLease(profileRoot);
  if (current?.leaseId !== expectedLeaseId) return false;
  await rm(profileOwnershipLeasePath(profileRoot), { force: true });
  return true;
}
