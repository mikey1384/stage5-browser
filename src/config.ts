import os from 'node:os';
import path from 'node:path';

export interface Stage5BrowserConfig {
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

  return {
    profileDir: env.STAGE5_BROWSER_PROFILE_DIR ?? path.join(root, 'profiles', 'default'),
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
