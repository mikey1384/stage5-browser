import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  browserAvailability,
  browserExecutableCandidates,
  resolveBrowserLaunchTarget,
} from '../src/browser-provider.js';
import { Stage5BrowserError } from '../src/errors.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('browser provider', () => {
  it('uses Playwright bundled Chromium by default', async () => {
    await expect(
      resolveBrowserLaunchTarget({ browser: 'chromium', executablePath: null }),
    ).resolves.toEqual({
      browser: 'chromium',
      engine: 'chromium',
      executablePath: null,
      source: 'bundled',
    });
  });

  it('accepts an absolute, executable operator override', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-provider-'));
    temporaryRoots.push(root);
    const executablePath = path.join(root, 'brave-browser');
    await writeFile(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await chmod(executablePath, 0o700);

    const launchTarget = await resolveBrowserLaunchTarget(
      { browser: 'brave', executablePath },
    );

    expect(launchTarget).toEqual({
      browser: 'brave',
      engine: 'chromium',
      executablePath: await realpath(executablePath),
      source: 'configured',
    });
  });

  it('rejects a relative operator override', async () => {
    await expect(
      resolveBrowserLaunchTarget({ browser: 'chrome', executablePath: './chrome' }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'BROWSER_NOT_READY',
      details: { browser: 'chrome', reason: 'path_not_absolute' },
    });
  });

  it('reports a structured error when the selected browser is not installed', async () => {
    await expect(
      resolveBrowserLaunchTarget(
        { browser: 'edge', executablePath: null },
        { platform: 'linux', env: { PATH: '' }, homeDir: '/nonexistent' },
      ),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: 'BROWSER_NOT_READY',
      recoverable: true,
      details: { browser: 'edge', reason: 'installation_not_found' },
    });
  });

  it('preflights unavailable browsers without throwing', async () => {
    await expect(
      browserAvailability(
        { browser: 'edge', executablePath: null },
        { platform: 'linux', env: { PATH: '' }, homeDir: '/nonexistent' },
      ),
    ).resolves.toEqual({
      browser: 'edge',
      engine: 'chromium',
      available: false,
      source: null,
      reason: 'installation_not_found',
    });
  });

  it('knows standard system and per-user macOS application locations', () => {
    expect(browserExecutableCandidates('brave', { platform: 'darwin', homeDir: '/Users/tester' })).toEqual([
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Users/tester/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ]);
  });
});
