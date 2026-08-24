import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { configurePlaywrightBrowsersPath } from '../src/launch-environment.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('launcher environment', () => {
  it('resolves a relative Playwright runtime path against the package instead of the caller cwd', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-launcher-'));
    temporaryRoots.push(root);
    const launcherUrl = pathToFileURL(path.join(root, 'dist', 'launcher.js'));
    const env: NodeJS.ProcessEnv = { PLAYWRIGHT_BROWSERS_PATH: '.playwright-browsers' };

    expect(configurePlaywrightBrowsersPath(env, launcherUrl)).toBe(
      path.join(root, '.playwright-browsers'),
    );
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(path.join(root, '.playwright-browsers'));
  });

  it('preserves a trusted absolute Playwright runtime path', () => {
    const absolutePath = path.resolve('/private/tmp/stage5-browser-runtimes');
    const env: NodeJS.ProcessEnv = { PLAYWRIGHT_BROWSERS_PATH: absolutePath };
    expect(configurePlaywrightBrowsersPath(env)).toBe(absolutePath);
  });
});
