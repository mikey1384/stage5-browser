import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';

import { BrowserController } from '../src/browser-controller.js';
import type { Stage5BrowserConfig } from '../src/config.js';
import {
  chromiumProfileLockProcessId,
  chromiumProfileOwnerProcessId,
  NativeOwnedBrowserWindowActivator,
  type NativeActivationCommandRunner,
} from '../src/native-window-activation.js';

let temporaryRoot: string | undefined;

afterEach(async () => {
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

describe('NativeOwnedBrowserWindowActivator', () => {
  it('activates only an exact running owned PID on macOS', async () => {
    const runner = vi.fn<NativeActivationCommandRunner>().mockResolvedValue({
      outcome: 'succeeded',
      state: {
        applicationHiddenBefore: true,
        unhideAttempted: true,
        activationRequestAccepted: true,
        applicationFrontmostAfter: true,
        applicationHiddenAfter: false,
      },
    });
    const processProbe = vi.fn((processId: number) => processId === 42_424);
    const activator = new NativeOwnedBrowserWindowActivator('darwin', runner, processProbe);

    await expect(activator.activateOwnedProcess(42_424, 750)).resolves.toEqual({
      attempted: true,
      supported: true,
      ownedProcessRunning: true,
      applicationActivated: true,
      applicationHiddenBefore: true,
      unhideAttempted: true,
      unhideSucceeded: true,
      activationRequestAccepted: true,
      frontProcessFallbackAttempted: false,
      frontProcessFallbackProcessResolved: null,
      frontProcessFallbackRequestSucceeded: null,
      applicationFrontmostAfter: true,
      applicationHiddenAfter: false,
      reason: 'activated',
    });
    expect(processProbe).toHaveBeenCalledWith(42_424);
    expect(runner).toHaveBeenCalledWith(42_424, 375);
  });

  it('never runs native activation for an absent process or unsupported platform', async () => {
    const runner = vi.fn<NativeActivationCommandRunner>().mockResolvedValue({
      outcome: 'succeeded',
      state: {
        applicationHiddenBefore: false,
        unhideAttempted: false,
        activationRequestAccepted: true,
        applicationFrontmostAfter: true,
        applicationHiddenAfter: false,
      },
    });
    const missing = new NativeOwnedBrowserWindowActivator('darwin', runner, () => false);
    await expect(missing.activateOwnedProcess(98_765, 500)).resolves.toMatchObject({
      attempted: false,
      ownedProcessRunning: false,
      applicationActivated: false,
      reason: 'owned_process_not_running',
    });

    const unsupported = new NativeOwnedBrowserWindowActivator('linux', runner, () => true);
    await expect(unsupported.activateOwnedProcess(98_765, 500)).resolves.toMatchObject({
      attempted: false,
      supported: false,
      applicationActivated: false,
      reason: 'platform_unsupported',
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([
    ['failed', 'activation_failed'],
    ['timed_out', 'activation_timed_out'],
  ] as const)('sanitizes a %s native command result', async (outcome, reason) => {
    const activator = new NativeOwnedBrowserWindowActivator(
      'darwin',
      async () => ({ outcome, state: null }),
      () => true,
    );
    await expect(activator.activateOwnedProcess(12_345, 500)).resolves.toMatchObject({
      attempted: true,
      applicationActivated: false,
      reason,
    });
  });

  it('does not treat an accepted activation request as proof of visible foreground state', async () => {
    const frontProcessRunner = vi.fn(async () => ({
      outcome: 'failed' as const,
      state: {
        processResolved: true,
        requestSucceeded: true,
        applicationFrontmostAfter: false,
      },
    }));
    const activator = new NativeOwnedBrowserWindowActivator(
      'darwin',
      async () => ({
        outcome: 'failed',
        state: {
          applicationHiddenBefore: true,
          unhideAttempted: true,
          activationRequestAccepted: true,
          applicationFrontmostAfter: false,
          applicationHiddenAfter: false,
        },
      }),
      () => true,
      frontProcessRunner,
    );

    await expect(activator.activateOwnedProcess(12_345, 500)).resolves.toMatchObject({
      applicationActivated: false,
      applicationHiddenBefore: true,
      unhideAttempted: true,
      unhideSucceeded: true,
      activationRequestAccepted: true,
      frontProcessFallbackAttempted: true,
      frontProcessFallbackProcessResolved: true,
      frontProcessFallbackRequestSucceeded: true,
      applicationFrontmostAfter: false,
      applicationHiddenAfter: false,
      reason: 'activation_state_unverified',
    });
    expect(frontProcessRunner).toHaveBeenCalledOnce();
  });

  it('uses one exact-process fallback when AppKit accepts but does not foreground an unhidden app', async () => {
    const commandRunner = vi.fn<NativeActivationCommandRunner>().mockResolvedValue({
      outcome: 'failed',
      state: {
        applicationHiddenBefore: false,
        unhideAttempted: false,
        activationRequestAccepted: true,
        applicationFrontmostAfter: false,
        applicationHiddenAfter: false,
      },
    });
    const frontProcessRunner = vi.fn(async () => ({
      outcome: 'succeeded' as const,
      state: {
        processResolved: true,
        requestSucceeded: true,
        applicationFrontmostAfter: true,
      },
    }));
    const activator = new NativeOwnedBrowserWindowActivator(
      'darwin',
      commandRunner,
      () => true,
      frontProcessRunner,
    );

    await expect(activator.activateOwnedProcess(12_345, 1_000)).resolves.toMatchObject({
      applicationActivated: true,
      applicationHiddenBefore: false,
      unhideAttempted: false,
      activationRequestAccepted: true,
      frontProcessFallbackAttempted: true,
      frontProcessFallbackProcessResolved: true,
      frontProcessFallbackRequestSucceeded: true,
      applicationFrontmostAfter: true,
      applicationHiddenAfter: false,
      reason: 'activated',
    });
    expect(commandRunner).toHaveBeenCalledWith(12_345, 500);
    expect(frontProcessRunner).toHaveBeenCalledWith(12_345, expect.any(Number));
    expect(frontProcessRunner.mock.calls[0]?.[1]).toBeGreaterThan(0);
    expect(frontProcessRunner.mock.calls[0]?.[1]).toBeLessThanOrEqual(1_000);
  });
});

describe('chromiumProfileOwnerProcessId', () => {
  it('resolves a live PID only from the dedicated Chromium singleton symlink', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-window-owner-'));
    await symlink('stage5-host-24680', path.join(temporaryRoot, 'SingletonLock'));
    await expect(chromiumProfileOwnerProcessId(
      temporaryRoot,
      (processId) => processId === 24_680,
    )).resolves.toBe(24_680);
    await expect(chromiumProfileLockProcessId(temporaryRoot)).resolves.toBe(24_680);
  });

  it('rejects regular files, malformed targets, and non-running owners', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-window-owner-invalid-'));
    const singletonLock = path.join(temporaryRoot, 'SingletonLock');
    await writeFile(singletonLock, 'stage5-host-24680');
    await expect(chromiumProfileOwnerProcessId(temporaryRoot, () => true)).resolves.toBeNull();
    await rm(singletonLock);
    await symlink('stage5-host-24680', singletonLock);
    await expect(chromiumProfileOwnerProcessId(temporaryRoot, () => false)).resolves.toBeNull();
    await expect(chromiumProfileLockProcessId(temporaryRoot)).resolves.toBe(24_680);
  });
});

describe('Chromium target-window preparation', () => {
  it('waits for an asynchronous minimized-to-normal transition before reporting success', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-window-normalization-'));
    const config: Stage5BrowserConfig = {
      browser: 'chromium',
      browserExecutablePath: null,
      profilesDir: path.join(temporaryRoot, 'profiles'),
      profileDir: path.join(temporaryRoot, 'profile'),
      artifactsDir: path.join(temporaryRoot, 'artifacts'),
      headless: false,
      operationTimeoutMs: 5_000,
      navigationTimeoutMs: 5_000,
      readinessTimeoutMs: 2_000,
      workerStartupTimeoutMs: 5_000,
      workerShutdownGraceMs: 500,
    };
    const controller = new BrowserController(config);
    let windowObservationCount = 0;
    const send = vi.fn(async (method: string) => {
      if (method === 'Browser.setWindowBounds') return {};
      windowObservationCount += 1;
      return {
        windowId: 7,
        bounds: { windowState: windowObservationCount < 3 ? 'minimized' : 'normal' },
      };
    });
    const detach = vi.fn(async () => undefined);
    const page = {
      context: () => ({
        newCDPSession: async () => ({ send, detach }),
      }),
    } as unknown as Page;
    const internals = controller as unknown as {
      prepareChromiumTargetWindow: (page: Page) => Promise<{
        targetWindowResolved: boolean;
        windowStateBefore: string;
        normalizationAttempted: boolean;
        normalizationSucceeded: boolean | null;
      }>;
    };

    await expect(internals.prepareChromiumTargetWindow(page)).resolves.toEqual({
      targetWindowResolved: true,
      windowStateBefore: 'minimized',
      normalizationAttempted: true,
      normalizationSucceeded: true,
    });
    expect(send).toHaveBeenCalledWith('Browser.setWindowBounds', {
      windowId: 7,
      bounds: { windowState: 'normal' },
    });
    expect(windowObservationCount).toBe(3);
    expect(detach).toHaveBeenCalledTimes(1);
  });
});
