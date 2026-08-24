import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig, profileDirForBrowser } from '../src/config.js';

describe('loadConfig', () => {
  it('preserves bundled Chromium and its existing default profile', () => {
    const config = loadConfig({});

    expect(config.browser).toBe('chromium');
    expect(config.browserExecutablePath).toBeNull();
    expect(path.basename(config.profileDir)).toBe('default');
  });

  it('isolates installed browsers in a product-specific default profile', () => {
    const config = loadConfig({ STAGE5_BROWSER_BROWSER: 'brave' });

    expect(config.browser).toBe('brave');
    expect(path.basename(config.profileDir)).toBe('brave');
    expect(profileDirForBrowser(config, 'firefox')).toBe(path.join(config.profilesDir, 'firefox'));
  });

  it('retains explicit executable and profile overrides', () => {
    const config = loadConfig({
      STAGE5_BROWSER_BROWSER: 'chrome',
      STAGE5_BROWSER_EXECUTABLE_PATH: '/opt/trusted/chrome',
      STAGE5_BROWSER_PROFILE_DIR: '/tmp/stage5-browser-profile',
    });

    expect(config.browser).toBe('chrome');
    expect(config.browserExecutablePath).toBe('/opt/trusted/chrome');
    expect(config.profileDir).toBe('/tmp/stage5-browser-profile');
  });

  it('rejects unknown browser products instead of silently launching another browser', () => {
    expect(() => loadConfig({ STAGE5_BROWSER_BROWSER: 'safari' })).toThrow(
      'STAGE5_BROWSER_BROWSER must be one of: chromium, chrome, brave, edge, firefox, webkit.',
    );
  });
});
