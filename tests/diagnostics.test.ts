import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  browserLaunchPolicyDiagnostics,
  classifyLaunchFailure,
  inspectProfile,
  launchFailureDiagnostic,
  suggestedActionForReason,
} from '../src/diagnostics.js';
import { Stage5BrowserError } from '../src/errors.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('browser diagnostics', () => {
  it('enables the Chromium sandbox on macOS and exposes only known safe launch-policy facts', () => {
    expect(browserLaunchPolicyDiagnostics('brave', false, 'installed', 'darwin')).toEqual({
      headless: false,
      persistentIsolatedProfile: true,
      executableSource: 'installed',
      sandbox: 'enabled',
      knownSecurityRelevantArguments: ['--enable-automation'],
      argumentsComplete: false,
    });
    expect(browserLaunchPolicyDiagnostics('chromium', true, 'bundled', 'linux')).toMatchObject({
      sandbox: 'playwright_default_disabled',
      knownSecurityRelevantArguments: ['--enable-automation', '--no-sandbox'],
    });
    expect(browserLaunchPolicyDiagnostics('firefox', true, 'bundled', 'darwin')).toMatchObject({
      sandbox: 'not_applicable',
      knownSecurityRelevantArguments: [],
    });
  });

  it('classifies common launch failures without exposing raw error text', () => {
    expect(classifyLaunchFailure(new Error('Failed to create a ProcessSingleton for this profile'))).toBe(
      'profile_locked',
    );
    expect(classifyLaunchFailure(Object.assign(new Error('spawn failed'), { code: 'EACCES' }))).toBe(
      'permission_denied',
    );
    expect(classifyLaunchFailure(new Error("Executable doesn't exist at /missing/browser"))).toBe(
      'browser_executable_missing',
    );

    const diagnostic = launchFailureDiagnostic(
      'chromium',
      new Stage5BrowserError('BROWSER_NOT_READY', 'Unavailable.', {
        details: { reason: 'bundled_browser_missing' },
      }),
      new Date('2026-08-24T02:00:00.000Z'),
    );
    expect(diagnostic).toMatchObject({
      browser: 'chromium',
      engine: 'chromium',
      reason: 'bundled_browser_missing',
      occurredAt: '2026-08-24T02:00:00.000Z',
    });
    expect(diagnostic.suggestedAction).toContain('browser:install');
    expect(suggestedActionForReason('installation_not_found')).toContain('Install');
  });

  it('reports profile writability and possible external lock ownership', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-profile-'));
    temporaryRoots.push(root);
    const profile = path.join(root, 'profile');

    await expect(inspectProfile(profile, false)).resolves.toMatchObject({
      path: profile,
      exists: false,
      writable: true,
      lockFiles: [],
      lockState: 'none',
    });

    await writeFile(path.join(root, 'placeholder'), 'fixture');
    await mkdir(profile);
    await writeFile(path.join(profile, 'SingletonLock'), 'fixture');
    await expect(inspectProfile(profile, false)).resolves.toMatchObject({
      exists: true,
      writable: true,
      lockFiles: ['SingletonLock'],
      lockState: 'possible_external_owner',
    });
  });
});
