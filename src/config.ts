import os from 'node:os';
import path from 'node:path';

import {
  SUPPORTED_BROWSER_PRODUCTS,
  type BrowserProduct,
} from './browser-provider.js';

export interface Stage5BrowserConfig {
  browser: BrowserProduct;
  browserExecutablePath: string | null;
  profilesDir: string;
  profileDir: string;
  artifactsDir: string;
  headless: boolean;
  operationTimeoutMs: number;
  navigationTimeoutMs: number;
  readinessTimeoutMs: number;
  workerStartupTimeoutMs: number;
  workerShutdownGraceMs: number;
}

const DEFAULT_OPERATION_TIMEOUT_MS = 15_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 20_000;

function parseBrowserProduct(value: string | undefined): BrowserProduct {
  const normalized = value?.trim().toLowerCase() ?? 'chromium';
  if ((SUPPORTED_BROWSER_PRODUCTS as readonly string[]).includes(normalized)) {
    return normalized as BrowserProduct;
  }

  throw new Error(
    `STAGE5_BROWSER_BROWSER must be one of: ${SUPPORTED_BROWSER_PRODUCTS.join(', ')}.`,
  );
}

function dataRoot(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Stage5 Browser');
  }

  if (process.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Stage5 Browser');
  }

  return path.join(env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'stage5-browser');
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseDuration(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Stage5BrowserConfig {
  const root = dataRoot(env);
  const profilesDir = env.STAGE5_BROWSER_PROFILES_DIR ?? path.join(root, 'profiles');
  const browser = parseBrowserProduct(env.STAGE5_BROWSER_BROWSER);
  const configuredExecutablePath = env.STAGE5_BROWSER_EXECUTABLE_PATH?.trim();
  const defaultProfileName = browser === 'chromium' ? 'default' : browser;

  return {
    browser,
    browserExecutablePath:
      configuredExecutablePath === undefined || configuredExecutablePath.length === 0
        ? null
        : configuredExecutablePath,
    profilesDir,
    profileDir: env.STAGE5_BROWSER_PROFILE_DIR ?? path.join(profilesDir, defaultProfileName),
    artifactsDir: env.STAGE5_BROWSER_ARTIFACTS_DIR ?? path.join(root, 'artifacts'),
    headless: parseBoolean(env.STAGE5_BROWSER_HEADLESS, false),
    operationTimeoutMs: parseDuration(
      env.STAGE5_BROWSER_OPERATION_TIMEOUT_MS,
      DEFAULT_OPERATION_TIMEOUT_MS,
      1_000,
      60_000,
    ),
    navigationTimeoutMs: parseDuration(
      env.STAGE5_BROWSER_NAVIGATION_TIMEOUT_MS,
      DEFAULT_NAVIGATION_TIMEOUT_MS,
      1_000,
      60_000,
    ),
    readinessTimeoutMs: 5_000,
    workerStartupTimeoutMs: 10_000,
    workerShutdownGraceMs: 1_000,
  };
}

export function profileDirForBrowser(
  config: Pick<Stage5BrowserConfig, 'browser' | 'profileDir' | 'profilesDir'>,
  browser: BrowserProduct,
): string {
  if (browser === config.browser) {
    return config.profileDir;
  }
  return path.join(config.profilesDir, browser === 'chromium' ? 'default' : browser);
}
