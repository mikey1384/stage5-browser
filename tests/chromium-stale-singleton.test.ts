import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  proveExitedPlaywrightSingleton,
  removeProvenExitedPlaywrightSingletonFiles,
} from '../src/chromium-stale-singleton.js';
import type { BrowserLaunchIdentity } from '../src/profile-binding.js';
import {
  profilePathFingerprint,
  readProfileOwnershipLease,
  writeProfileOwnershipLease,
  type ProfileOwnershipLease,
  type ProfileOwnershipLeaseInspection,
} from '../src/profile-ownership-lease.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) =>
    rm(root, { recursive: true, force: true })));
});

async function fixture(browserProcessId = 2_147_483_647): Promise<{
  root: string;
  identity: BrowserLaunchIdentity;
  lease: ProfileOwnershipLease;
  inspection: ProfileOwnershipLeaseInspection;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-stale-singleton-'));
  temporaryRoots.push(root);
  const executablePath = path.join(root, 'Chromium fixture');
  await writeFile(executablePath, 'fixture');
  const identity: BrowserLaunchIdentity = {
    browser: 'chromium',
    engine: 'chromium',
    applicationName: 'Chromium fixture',
    executablePath,
    executableSource: 'configured',
    profile: {
      storageKind: 'chromium_user_data',
      userDataDir: root,
      profileDirectory: 'Default',
      profilePath: path.join(root, 'Default'),
    },
  };
  const now = new Date().toISOString();
  const lease: ProfileOwnershipLease = {
    version: 1,
    leaseId: randomUUID(),
    browser: 'chromium',
    engine: 'chromium',
    profileFingerprint: profilePathFingerprint(root),
    ownerWorkerProcessId: 2_147_483_646,
    ownerWorkerStartedAt: 'exited-worker',
    browserProcessId,
    browserProcessStartedAt: 'exited-browser',
    browserExecutableFingerprint: createHash('sha256')
      .update(await realpath(executablePath))
      .digest('hex'),
    controlMode: 'playwright',
    phase: 'process_exited',
    createdAt: now,
    heartbeatAt: now,
  };
  await writeProfileOwnershipLease(root, lease);
  await Promise.all([
    symlink(`fixture-host-${browserProcessId}`, path.join(root, 'SingletonLock')),
    symlink('stale-cookie', path.join(root, 'SingletonCookie')),
    symlink(path.join(root, 'missing-socket'), path.join(root, 'SingletonSocket')),
  ]);
  return {
    root,
    identity,
    lease,
    inspection: {
      state: 'abandoned',
      lease,
      ownershipProven: false,
      ownerWorkerRunning: false,
      heartbeat: 'stale',
      browserProcess: 'not_running',
    },
  };
}

describe('proven exited Chromium singleton recovery', () => {
  it('removes only unchanged singleton entries while retaining the exact Stage5 lease', async () => {
    const { root, identity, lease, inspection } = await fixture();
    const proof = await proveExitedPlaywrightSingleton(root, identity, inspection);
    expect(proof).toMatchObject({ leaseId: lease.leaseId, browserProcessId: lease.browserProcessId });
    if (proof === null) throw new Error('Fixture did not produce a stale-singleton proof.');

    await expect(removeProvenExitedPlaywrightSingletonFiles(root, proof)).resolves.toBe(true);
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      await expect(lstat(path.join(root, name))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(readProfileOwnershipLease(root)).resolves.toMatchObject({ leaseId: lease.leaseId });
  });

  it('invalidates the capability when any singleton entry changes before removal', async () => {
    const { root, identity, inspection } = await fixture();
    const proof = await proveExitedPlaywrightSingleton(root, identity, inspection);
    if (proof === null) throw new Error('Fixture did not produce a stale-singleton proof.');
    const cookie = path.join(root, 'SingletonCookie');
    await rm(cookie);
    await symlink('replacement-cookie', cookie);

    await expect(removeProvenExitedPlaywrightSingletonFiles(root, proof)).resolves.toBe(false);
    await expect(lstat(path.join(root, 'SingletonLock'))).resolves.toBeDefined();
  });

  it('refuses a live PID, mismatched lock PID, or any non-singleton profile lock', async () => {
    const live = await fixture(process.pid);
    await expect(
      proveExitedPlaywrightSingleton(live.root, live.identity, live.inspection),
    ).resolves.toBeNull();

    const mismatched = await fixture();
    await rm(path.join(mismatched.root, 'SingletonLock'));
    await symlink('fixture-host-2147483000', path.join(mismatched.root, 'SingletonLock'));
    await expect(
      proveExitedPlaywrightSingleton(mismatched.root, mismatched.identity, mismatched.inspection),
    ).resolves.toBeNull();

    const foreignLock = await fixture();
    await writeFile(path.join(foreignLock.root, 'lock'), 'foreign-lock');
    await expect(
      proveExitedPlaywrightSingleton(foreignLock.root, foreignLock.identity, foreignLock.inspection),
    ).resolves.toBeNull();
  });
});
