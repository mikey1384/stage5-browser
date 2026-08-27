import path from 'node:path';

import type { Stage5BrowserConfig } from '../src/config.js';

export function supervisorConfig(
  root: string,
  overrides: Partial<Stage5BrowserConfig> = {},
): Stage5BrowserConfig {
  return {
    browser: 'chromium',
    browserExecutablePath: null,
    profilesDir: path.join(root, 'profiles'),
    profileDir: path.join(root, 'profile'),
    artifactsDir: path.join(root, 'artifacts'),
    headless: true,
    operationTimeoutMs: 500,
    navigationTimeoutMs: 500,
    readinessTimeoutMs: 250,
    workerStartupTimeoutMs: 1_000,
    workerShutdownGraceMs: 100,
    ...overrides,
  };
}
