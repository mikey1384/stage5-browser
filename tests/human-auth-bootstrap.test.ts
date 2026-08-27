import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { BrowserLaunchTarget } from '../src/browser-provider.js';
import { Stage5BrowserError } from '../src/errors.js';
import {
  compareProfileExitMarker,
  humanBrowserArguments,
  humanBrowserLaunchPolicy,
  inspectProfileShutdown,
  isStage5HandoffMarkerUrl,
  NativeHumanBrowserLauncher,
  profileLocks,
  stage5HandoffMarkerUrl,
  waitForProfileUnlock,
} from '../src/human-auth-bootstrap.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function target(overrides: Partial<BrowserLaunchTarget> = {}): BrowserLaunchTarget {
  return {
    browser: 'brave',
    engine: 'chromium',
    executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    source: 'discovered',
    ...overrides,
  };
}

describe('human authentication bootstrap', () => {
  it('uses a fixed loopback channel without Playwright automation flags for continuous Chromium attachment', () => {
    const input = {
      target: target(),
      profileDir: '/private/tmp/stage5 human profile',
      handoffLabel: 'Stage5 brave · example.com · TEST1234',
      url: 'https://x.com/i/flow/login',
    };
    const args = humanBrowserArguments(input);
    expect(isStage5HandoffMarkerUrl(args[3] ?? '')).toBe(true);
    expect(decodeURIComponent((args[3] ?? '').split(',').slice(1).join(','))).toContain(input.handoffLabel);
    expect(args).toEqual([
      '--user-data-dir=/private/tmp/stage5 human profile',
      '--profile-directory=Default',
      '--new-window',
      stage5HandoffMarkerUrl(input.handoffLabel),
      'https://x.com/i/flow/login',
    ]);
    expect(args.join(' ')).not.toMatch(/enable-automation|remote-debugging|no-sandbox/i);
    expect(humanBrowserLaunchPolicy(input.target)).toMatchObject({
      supported: true,
      controlledByPlaywright: false,
      automationFlagsPresent: false,
      argumentKinds: expect.arrayContaining(['loopback_debugging']),
    });
    const continuousArguments = humanBrowserArguments(input, 29_123);
    expect(continuousArguments).toEqual([
      '--user-data-dir=/private/tmp/stage5 human profile',
      '--profile-directory=Default',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=29123',
      '--new-window',
      stage5HandoffMarkerUrl(input.handoffLabel),
      'https://x.com/i/flow/login',
    ]);
    expect(continuousArguments.join(' ')).not.toMatch(/enable-automation|no-sandbox/i);

    const firefoxInput = {
      ...input,
      target: target({ browser: 'firefox', engine: 'firefox', executablePath: null, source: 'bundled' }),
    };
    expect(humanBrowserArguments(firefoxInput)).toEqual([
      '-no-remote',
      '-wait-for-browser',
      '-foreground',
      '-profile',
      '/private/tmp/stage5 human profile',
      '-new-window',
      stage5HandoffMarkerUrl(input.handoffLabel),
      '-new-tab',
      'https://x.com/i/flow/login',
    ]);

    expect(() => humanBrowserArguments({
      ...input,
      target: target({ browser: 'webkit', engine: 'webkit', executablePath: null, source: 'bundled' }),
    })).toThrowError(expect.objectContaining<Partial<Stage5BrowserError>>({
      code: 'AUTH_HANDOFF_UNAVAILABLE',
    }));
  });

  it('detects Chromium clean shutdown state without rewriting profile preferences', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-human-profile-'));
    temporaryRoots.push(root);
    const profile = path.join(root, 'Profile 1');
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(root, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 1' } }));
    await writeFile(
      path.join(profile, 'Preferences'),
      JSON.stringify({ profile: { exit_type: 'Normal', exited_cleanly: true } }),
    );

    await expect(inspectProfileShutdown(root, 'brave')).resolves.toEqual({
      state: 'clean',
      exitType: 'normal',
      exitedCleanly: true,
      exitedCleanlySource: 'preferences_flag',
      profileDirectory: 'Profile 1',
      profileLocks: [],
      preferencesModifiedAt: expect.any(String),
    });

    await writeFile(
      path.join(profile, 'Preferences'),
      JSON.stringify({ profile: { exit_type: 'Crashed', exited_cleanly: false } }),
    );
    await expect(inspectProfileShutdown(root, 'brave')).resolves.toMatchObject({
      state: 'unclean',
      exitType: 'crashed',
      exitedCleanly: false,
    });
  });

  it('waits for real profile locks to disappear and never removes them itself', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-human-lock-'));
    temporaryRoots.push(root);
    const lock = path.join(root, 'SingletonLock');
    await writeFile(lock, 'owned');
    expect(await profileLocks(root)).toEqual(['SingletonLock']);
    const release = setTimeout(() => void unlink(lock), 50);
    await expect(waitForProfileUnlock(root, 1_000)).resolves.toBe(true);
    clearTimeout(release);
    expect(await profileLocks(root)).toEqual([]);
  });

  it('does not mistake an unheld persistent macOS Firefox .parentlock file for a live owner', async () => {
    if (process.platform !== 'darwin') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-firefox-parentlock-'));
    temporaryRoots.push(root);
    await writeFile(path.join(root, '.parentlock'), '');
    await expect(profileLocks(root)).resolves.toEqual([]);
    await expect(waitForProfileUnlock(root, 2_500)).resolves.toBe(true);
  });

  it('tracks a detached native process without controlling it', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-native-process-'));
    temporaryRoots.push(root);
    const launcher = new NativeHumanBrowserLauncher(async () => 29_123);
    const session = await launcher.launch({
      target: target({ browser: 'brave', executablePath: '/usr/bin/true', source: 'configured' }),
      profileDir: root,
      handoffLabel: 'Stage5 brave · example.com · TEST1234',
      url: 'https://example.com/',
    });
    await expect(session.waitForExit(1_000)).resolves.toBe(true);
    expect(session.state()).toMatchObject({ running: false, processId: expect.any(Number) });
    expect(session.identity()).toMatchObject({
      browser: 'brave',
      executablePath: '/usr/bin/true',
      profile: {
        userDataDir: root,
        profileDirectory: 'Default',
      },
    });
    expect(session.controlChannel()).toEqual({
      kind: 'chromium_cdp',
      endpointUrl: 'http://127.0.0.1:29123',
    });
  });

  it('derives an unambiguous clean-exit boolean from Chromium exit_type', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-human-derived-exit-'));
    temporaryRoots.push(root);
    await mkdir(path.join(root, 'Default'), { recursive: true });
    await writeFile(path.join(root, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 8' } }));
    await writeFile(
      path.join(root, 'Default', 'Preferences'),
      JSON.stringify({ profile: { exit_type: 'Normal' } }),
    );

    await expect(inspectProfileShutdown(root, 'brave', 'Default')).resolves.toMatchObject({
      state: 'clean',
      exitType: 'normal',
      exitedCleanly: true,
      exitedCleanlySource: 'exit_type',
      profileDirectory: 'Default',
    });
  });

  it('distinguishes a stale Chromium exit marker from one rewritten during the handoff', () => {
    const baseline = {
      state: 'unclean' as const,
      exitType: 'crashed' as const,
      exitedCleanly: false,
      exitedCleanlySource: 'preferences_flag' as const,
      profileDirectory: 'Default',
      profileLocks: [],
      preferencesModifiedAt: '2026-08-24T01:00:00.000Z',
    };

    expect(compareProfileExitMarker(baseline, baseline)).toBe('unchanged_from_before_handoff');
    expect(compareProfileExitMarker(baseline, {
      ...baseline,
      preferencesModifiedAt: '2026-08-24T02:00:00.000Z',
    })).toBe('rewritten_with_same_value');
    expect(compareProfileExitMarker(baseline, {
      ...baseline,
      state: 'clean',
      exitType: 'normal',
      exitedCleanly: true,
    })).toBe('changed_during_handoff');
    expect(compareProfileExitMarker(baseline, {
      ...baseline,
      preferencesModifiedAt: null,
    })).toBe('unavailable');
  });
});
