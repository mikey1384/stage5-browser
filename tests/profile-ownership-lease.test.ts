import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  inspectProfileOwnershipLease,
  ProfileOwnershipLeaseController,
  profilePathFingerprint,
  profileOwnershipLeasePath,
  readProfileOwnershipLease,
  terminateProvenOrphan,
  writeProfileOwnershipLease,
  type ProfileOwnershipLease,
  type ProfileOwnershipDependencies,
} from '../src/profile-ownership-lease.js';
import type { BrowserLaunchIdentity } from '../src/profile-binding.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  root: string;
  executable: string;
  identity: BrowserLaunchIdentity;
  lease: ProfileOwnershipLease;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-ownership-lease-'));
  roots.push(root);
  const executable = path.join(root, 'Chromium');
  await writeFile(executable, 'fixture');
  const identity: BrowserLaunchIdentity = {
    browser: 'chromium',
    engine: 'chromium',
    applicationName: 'Chromium',
    executablePath: executable,
    executableSource: 'configured',
    profile: {
      storageKind: 'chromium_user_data',
      userDataDir: root,
      profileDirectory: 'Default',
      profilePath: path.join(root, 'Default'),
    },
  };
  return {
    root,
    executable,
    identity,
    lease: {
      version: 1,
      leaseId: '11111111-1111-4111-8111-111111111111',
      browser: 'chromium',
      engine: 'chromium',
      profileFingerprint: profilePathFingerprint(root),
      ownerWorkerProcessId: 12_345,
      ownerWorkerStartedAt: 'worker-start',
      browserProcessId: 54_321,
      browserProcessStartedAt: 'browser-start',
      browserExecutableFingerprint: createHash('sha256').update(await realpath(executable)).digest('hex'),
      controlMode: 'playwright',
      phase: 'owned_active',
      createdAt: '2026-08-25T04:00:00.000Z',
      heartbeatAt: '2026-08-25T04:00:00.000Z',
    },
  };
}

function dependencies(
  executable: string,
  workerRunning: boolean,
  browserRunning: { value: boolean },
): Partial<ProfileOwnershipDependencies> {
  return {
    now: () => new Date('2026-08-25T04:00:02.000Z'),
    processRunning: (processId) => processId === 12_345 ? workerRunning : browserRunning.value,
    processStartedAt: async (processId) => processId === 12_345 ? 'worker-start' : 'browser-start',
    processExecutable: async () => executable,
    processTable: async () => [],
    signalProcess: () => {
      browserRunning.value = false;
    },
  };
}

describe('durable profile ownership lease', () => {
  it('writes atomically with private permissions and distinguishes another live Stage5 session', async () => {
    const { root, executable, identity, lease } = await fixture();
    await writeProfileOwnershipLease(root, lease);
    await expect(readProfileOwnershipLease(root)).resolves.toEqual(lease);
    if (process.platform !== 'win32') {
      expect((await stat(profileOwnershipLeasePath(root))).mode & 0o777).toBe(0o600);
    }

    const inspection = await inspectProfileOwnershipLease(
      root,
      identity,
      '22222222-2222-4222-8222-222222222222',
      dependencies(executable, true, { value: true }),
    );
    expect(inspection).toMatchObject({
      state: 'busy_other_stage5_session',
      ownershipProven: true,
      ownerWorkerRunning: true,
      heartbeat: 'fresh',
    });
  });

  it('proves an orphan only from the exact worker/browser start identities and terminates only that proof', async () => {
    const { root, executable, identity, lease } = await fixture();
    await writeProfileOwnershipLease(root, lease);
    const browserRunning = { value: true };
    const dependencyOverrides = dependencies(executable, false, browserRunning);
    // Chromium additionally requires its live singleton owner; inject a non-Chromium
    // identity here so the unit isolates lease process-fingerprint behavior.
    const firefoxIdentity: BrowserLaunchIdentity = {
      ...identity,
      browser: 'firefox',
      engine: 'firefox',
      profile: {
        storageKind: 'firefox_profile',
        userDataDir: null,
        profileDirectory: null,
        profilePath: root,
      },
    };
    await writeProfileOwnershipLease(root, {
      ...lease,
      browser: 'firefox',
      engine: 'firefox',
    });
    const inspection = await inspectProfileOwnershipLease(
      root,
      firefoxIdentity,
      '22222222-2222-4222-8222-222222222222',
      dependencyOverrides,
    );
    expect(inspection).toMatchObject({
      state: 'owned_orphaned',
      ownershipProven: true,
      ownerWorkerRunning: false,
      browserProcess: 'matched',
    });
    await expect(terminateProvenOrphan(inspection, 50, dependencyOverrides)).resolves.toBe('process_exited');
    expect(browserRunning.value).toBe(false);

    const mismatched = await inspectProfileOwnershipLease(
      root,
      firefoxIdentity,
      '22222222-2222-4222-8222-222222222222',
      {
        ...dependencyOverrides,
        processStartedAt: async (processId) => processId === 12_345 ? 'worker-start' : 'reused-pid',
      },
    );
    await expect(terminateProvenOrphan(mismatched, 50, dependencyOverrides)).rejects.toThrow(
      'conclusively proven',
    );
  });

  it('does not signal an externally substituted browser process', async () => {
    const { root, executable, identity, lease } = await fixture();
    await writeProfileOwnershipLease(root, {
      ...lease,
      browser: 'firefox',
      engine: 'firefox',
    });
    const otherExecutable = path.join(root, 'Other Browser');
    await writeFile(otherExecutable, 'fixture');
    const signalProcess = vi.fn();
    const firefoxIdentity: BrowserLaunchIdentity = {
      ...identity,
      browser: 'firefox',
      engine: 'firefox',
      profile: {
        storageKind: 'firefox_profile',
        userDataDir: null,
        profileDirectory: null,
        profilePath: root,
      },
    };
    const inspection = await inspectProfileOwnershipLease(root, firefoxIdentity, 'other', {
      ...dependencies(otherExecutable, false, { value: true }),
      signalProcess,
    });
    expect(inspection).toMatchObject({
      state: 'abandoned',
      ownershipProven: false,
      browserProcess: 'mismatched',
    });
    await expect(terminateProvenOrphan(inspection, 50, {
      ...dependencies(otherExecutable, false, { value: true }),
      signalProcess,
    })).rejects.toThrow('conclusively proven');
    expect(signalProcess).not.toHaveBeenCalled();
  });

  it('fails closed on malformed or partially identified lease files', async () => {
    const { root, executable, identity, lease } = await fixture();
    await writeFile(profileOwnershipLeasePath(root), '{"not":"a lease"}\n');
    await expect(inspectProfileOwnershipLease(
      root,
      identity,
      'other',
      dependencies(executable, false, { value: false }),
    )).resolves.toMatchObject({ state: 'invalid', ownershipProven: false, lease: null });

    await writeFile(profileOwnershipLeasePath(root), `${JSON.stringify({
      ...lease,
      browserProcessStartedAt: null,
    })}\n`);
    await expect(inspectProfileOwnershipLease(
      root,
      identity,
      'other',
      dependencies(executable, false, { value: true }),
    )).resolves.toMatchObject({ state: 'invalid', ownershipProven: false, lease: null });
  });

  it('allows only one worker to replace a conclusively proven orphan lease', async () => {
    const { root, executable, identity, lease } = await fixture();
    const firefoxIdentity: BrowserLaunchIdentity = {
      ...identity,
      browser: 'firefox',
      engine: 'firefox',
      profile: {
        storageKind: 'firefox_profile',
        userDataDir: null,
        profileDirectory: null,
        profilePath: root,
      },
    };
    await writeProfileOwnershipLease(root, { ...lease, browser: 'firefox', engine: 'firefox' });
    const browserRunning = { value: true };
    const inspection = await inspectProfileOwnershipLease(
      root,
      firefoxIdentity,
      'other',
      dependencies(executable, false, browserRunning),
    );
    expect(inspection.state).toBe('owned_orphaned');

    const controllerDependencies: ProfileOwnershipDependencies = {
      now: () => new Date('2026-08-25T04:00:03.000Z'),
      processRunning: (processId) => processId === process.pid || processId === 54_321,
      processStartedAt: async (processId) => processId === process.pid ? 'current-worker-start' : 'browser-start',
      processExecutable: async () => executable,
      processTable: async () => [],
      signalProcess: () => undefined,
    };
    const winner = new ProfileOwnershipLeaseController(controllerDependencies);
    const loser = new ProfileOwnershipLeaseController(controllerDependencies);
    await expect(winner.takeOverProvenOrphan({
      profileRoot: root,
      identity: firefoxIdentity,
      controlMode: 'native_cdp',
      inspection,
    })).resolves.toBe(true);
    await expect(loser.takeOverProvenOrphan({
      profileRoot: root,
      identity: firefoxIdentity,
      controlMode: 'native_cdp',
      inspection,
    })).resolves.toBe(false);
    await expect(readProfileOwnershipLease(root)).resolves.toMatchObject({
      leaseId: winner.leaseId,
      ownerWorkerProcessId: process.pid,
      controlMode: 'native_cdp',
      phase: 'launching',
    });
    await winner.release();
  });

  it('serializes a queued heartbeat write ahead of release so the lease cannot be recreated', async () => {
    const { root, executable, identity } = await fixture();
    const controllerDependencies: ProfileOwnershipDependencies = {
      now: () => new Date('2026-08-25T04:00:03.000Z'),
      processRunning: () => true,
      processStartedAt: async (processId) => processId === process.pid
        ? 'current-worker-start'
        : 'browser-start',
      processExecutable: async () => executable,
      processTable: async () => [],
      signalProcess: () => undefined,
    };
    const controller = new ProfileOwnershipLeaseController(controllerDependencies);
    await expect(controller.claim({
      profileRoot: root,
      identity,
      controlMode: 'playwright',
    })).resolves.toBe(true);
    const claimed = await readProfileOwnershipLease(root);
    if (claimed === null) throw new Error('Ownership lease was not created.');

    let unblockMutation: (() => void) | undefined;
    const mutationBlocked = new Promise<void>((resolve) => {
      unblockMutation = resolve;
    });
    const internals = controller as unknown as {
      enqueueMutation: <Result>(operation: () => Promise<Result>) => Promise<Result>;
    };
    const delayedHeartbeat = internals.enqueueMutation(async () => {
      await mutationBlocked;
      await writeProfileOwnershipLease(root, {
        ...claimed,
        heartbeatAt: '2026-08-25T04:00:04.000Z',
      });
    });
    const released = controller.release();
    unblockMutation?.();
    await Promise.all([delayedHeartbeat, released]);

    await expect(readProfileOwnershipLease(root)).resolves.toBeNull();
  });
});
