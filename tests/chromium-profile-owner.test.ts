import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  inspectChromiumProfileOwner,
  type ChromiumProfileOwnerInspectionDependencies,
} from '../src/chromium-profile-owner.js';
import { writeNativeControlRecord } from '../src/native-control-channel.js';
import type { BrowserLaunchIdentity } from '../src/profile-binding.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  root: string;
  executable: string;
  identity: BrowserLaunchIdentity;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-profile-owner-'));
  temporaryRoots.push(root);
  const executable = path.join(root, 'Google Chrome');
  await writeFile(executable, 'fixture');
  return {
    root,
    executable,
    identity: {
      browser: 'chrome',
      engine: 'chromium',
      applicationName: 'Google Chrome',
      executablePath: executable,
      executableSource: 'configured',
      profile: {
        storageKind: 'chromium_user_data',
        userDataDir: root,
        profileDirectory: 'Default',
        profilePath: path.join(root, 'Default'),
      },
    },
  };
}

function dependencies(
  executable: string,
  endpoint: ChromiumProfileOwnerInspectionDependencies['inspectDevToolsEndpoint'] = async () => ({
    valid: true,
    authenticationHandoff: 'absent',
  }),
): Partial<ChromiumProfileOwnerInspectionDependencies> {
  return {
    ownerProcessId: async () => 42_424,
    processExecutable: async () => executable,
    loopbackListeningPorts: async () => [29_123],
    inspectDevToolsEndpoint: endpoint,
    now: () => new Date('2026-08-25T04:00:00.000Z'),
    platform: 'darwin',
  };
}

describe('Chromium dedicated-profile ownership recovery', () => {
  it('creates an internal reconnect capability only for one exact owned endpoint after handoff', async () => {
    const { root, executable, identity } = await fixture();
    const inspection = await inspectChromiumProfileOwner(root, identity, dependencies(executable));

    expect(inspection.evidence).toEqual({
      classification: 'owned_orphaned',
      ownership: 'proven',
      lockOwnerProcess: 'running',
      expectedApplication: 'Google Chrome',
      applicationIdentity: 'matched',
      loopbackControl: 'available',
      authenticationHandoff: 'absent',
      recovery: 'automatic_reattach',
      suggestedAction: 'Stage5 Browser can safely reattach automatically; no user action, lock deletion, process termination, deployment, or host restart is required.',
    });
    expect(inspection.reconnectRecord).toEqual({
      version: 1,
      kind: 'chromium_cdp',
      browser: 'chrome',
      state: 'controlled',
      processId: 42_424,
      port: 29_123,
      createdAt: '2026-08-25T04:00:00.000Z',
    });
    const publicEvidence = JSON.stringify(inspection.evidence);
    expect(publicEvidence).not.toContain('42424');
    expect(publicEvidence).not.toContain('29123');
    expect(publicEvidence).not.toContain(root);
  });

  it('does not attach while the private authentication marker remains', async () => {
    const { root, executable, identity } = await fixture();
    await writeNativeControlRecord(root, {
      version: 1,
      kind: 'chromium_cdp',
      browser: 'chrome',
      state: 'awaiting_user',
      processId: 42_424,
      port: 29_123,
      createdAt: '2026-08-25T04:00:00.000Z',
    });
    const inspection = await inspectChromiumProfileOwner(
      root,
      identity,
      dependencies(executable, async () => ({
        valid: true,
        authenticationHandoff: 'present',
      })),
    );

    expect(inspection.reconnectRecord).toBeNull();
    expect(inspection.handoffRecord).toMatchObject({
      state: 'awaiting_user',
      processId: 42_424,
      port: 29_123,
    });
    expect(inspection.evidence).toMatchObject({
      classification: 'authentication_handoff_pending',
      ownership: 'proven',
      authenticationHandoff: 'present',
      recovery: 'return_to_authentication_handoff',
    });
  });

  it('fails closed with exact safe human action when the executable or control channel is not proven', async () => {
    const { root, executable, identity } = await fixture();
    const otherExecutable = path.join(root, 'Other Browser');
    await writeFile(otherExecutable, 'fixture');
    const endpointProbe = vi.fn(async () => ({
      valid: true,
      authenticationHandoff: 'absent' as const,
    }));
    const mismatch = await inspectChromiumProfileOwner(root, identity, {
      ...dependencies(executable, endpointProbe),
      processExecutable: async () => otherExecutable,
    });

    expect(mismatch.reconnectRecord).toBeNull();
    expect(mismatch.evidence).toMatchObject({
      classification: 'external_owner',
      ownership: 'not_proven',
      applicationIdentity: 'mismatched',
      recovery: 'do_not_modify_locks',
    });
    expect(mismatch.evidence.suggestedAction).toContain('Do not retry, delete locks, or kill');
    expect(endpointProbe).not.toHaveBeenCalled();

    const noControl = await inspectChromiumProfileOwner(root, identity, {
      ...dependencies(executable),
      loopbackListeningPorts: async () => [],
    });
    expect(noControl.reconnectRecord).toBeNull();
    expect(noControl.evidence).toMatchObject({
      classification: 'external_owner',
      ownership: 'proven',
      loopbackControl: 'absent',
      recovery: 'close_dedicated_browser_normally',
    });
    expect(noControl.evidence.suggestedAction).toContain('Cmd-Q');
    expect(noControl.evidence.suggestedAction).toContain('Do not delete lock files');
  });
});
