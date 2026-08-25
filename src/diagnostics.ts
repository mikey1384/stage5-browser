import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import path from 'node:path';

import {
  BROWSER_ENGINES,
  type BrowserAvailability,
  type BrowserExecutableSource,
  type BrowserProduct,
} from './browser-provider.js';
import type { ProfileOwnerEvidence } from './chromium-profile-owner.js';
import { Stage5BrowserError } from './errors.js';
import type { PageRuntimeDiagnostics } from './page-diagnostics.js';
import type {
  AuthenticationStorageContinuity,
  BrowserLaunchIdentity,
  BrowserProfileBinding,
  RuntimeProfileObservation,
} from './profile-binding.js';

export const LAUNCH_FAILURE_REASONS = [
  'browser_executable_missing',
  'browser_process_exited',
  'bundled_browser_missing',
  'display_unavailable',
  'installation_not_found',
  'launch_timeout',
  'ownership_unverified',
  'path_not_absolute',
  'path_not_executable',
  'permission_denied',
  'profile_locked',
  'unknown_launch_failure',
  'worker_protocol_mismatch',
] as const;

export type LaunchFailureReason = (typeof LAUNCH_FAILURE_REASONS)[number];

export interface LaunchFailureDiagnostic {
  browser: BrowserProduct;
  engine: (typeof BROWSER_ENGINES)[BrowserProduct];
  reason: LaunchFailureReason;
  occurredAt: string;
  suggestedAction: string;
}

export interface ProfileDiagnostics {
  path: string;
  exists: boolean;
  writable: boolean;
  lockFiles: string[];
  lockState: 'none' | 'owned_browser_running' | 'possible_external_owner';
}

export interface BrowserDiagnostics {
  browser: BrowserProduct;
  engine: (typeof BROWSER_ENGINES)[BrowserProduct];
  availability: BrowserAvailability;
  preflightSuggestedAction: string | null;
  profile: ProfileDiagnostics;
  profileOwner: ProfileOwnerEvidence;
  profileBinding: BrowserProfileBinding;
  launchIdentity: BrowserLaunchIdentity | null;
  runtimeProfile: RuntimeProfileObservation | null;
  authenticationStorageBoundary: AuthenticationStorageContinuity | null;
  lastLaunchFailure: LaunchFailureDiagnostic | null;
  launchPolicy: BrowserLaunchPolicyDiagnostics;
  automationExposure: AutomationExposureDiagnostics;
  page: PageRuntimeDiagnostics | null;
}

export interface AutomationExposureDiagnostics {
  controlMode: 'human_bootstrap' | 'none' | 'playwright';
  controlledByPlaywright: boolean;
  enableAutomationArgument: 'absent' | 'not_applicable' | 'present';
  navigatorWebdriver: boolean | null;
  navigatorWebdriverObserved: boolean;
  observation:
    | 'controlled_page_runtime'
    | 'no_browser_running'
    | 'uncontrolled_browser_not_instrumented';
}

export interface BrowserLaunchPolicyDiagnostics {
  headless: boolean;
  persistentIsolatedProfile: true;
  executableSource: BrowserExecutableSource | null;
  sandbox: 'enabled' | 'not_applicable' | 'playwright_default_disabled';
  knownSecurityRelevantArguments: string[];
  knownControlledModeStorageArguments: string[];
  argumentsComplete: false;
}

export function browserLaunchPolicyDiagnostics(
  browser: BrowserProduct,
  headless: boolean,
  executableSource: BrowserExecutableSource | null,
  platform: NodeJS.Platform = process.platform,
  attachedToNativeProcess = false,
): BrowserLaunchPolicyDiagnostics {
  const engine = BROWSER_ENGINES[browser];
  const chromiumSandboxEnabled = engine === 'chromium' && platform === 'darwin';
  const sandbox = engine !== 'chromium'
    ? 'not_applicable'
    : chromiumSandboxEnabled
      ? 'enabled'
      : 'playwright_default_disabled';
  return {
    headless,
    persistentIsolatedProfile: true,
    executableSource,
    sandbox,
    knownSecurityRelevantArguments: engine === 'chromium' && attachedToNativeProcess
      ? ['--remote-debugging-address=<loopback>', '--remote-debugging-port=<ephemeral>']
      : engine === 'chromium'
      ? chromiumSandboxEnabled
        ? ['--enable-automation']
        : ['--enable-automation', '--no-sandbox']
      : [],
    knownControlledModeStorageArguments: engine === 'chromium' && !attachedToNativeProcess
      ? ['--password-store=basic', '--use-mock-keychain']
      : [],
    argumentsComplete: false,
  };
}

const SUGGESTED_ACTIONS: Record<LaunchFailureReason, string> = {
  browser_executable_missing: 'Install the selected browser runtime, then run browser_available again.',
  browser_process_exited: 'Call browser_diagnostics, inspect the selected profile, and retry only after correcting the reported launch condition.',
  bundled_browser_missing: 'Run npm run browser:install from the Stage5 Browser repository, then restart the MCP host.',
  display_unavailable: 'Run Stage5 Browser in a desktop session with GUI access, or explicitly configure headless mode for a non-interactive check.',
  installation_not_found: 'Install the selected browser or configure a trusted absolute STAGE5_BROWSER_EXECUTABLE_PATH, then restart the MCP host.',
  launch_timeout: 'Check for a locked profile or blocked browser process with browser_diagnostics before retrying.',
  ownership_unverified: 'Do not use, kill, or delete locks for the browser process. Run browser_diagnostics and correct exact process ownership before retrying.',
  path_not_absolute: 'Set STAGE5_BROWSER_EXECUTABLE_PATH to an absolute trusted executable path, then restart the MCP host.',
  path_not_executable: 'Correct STAGE5_BROWSER_EXECUTABLE_PATH so it points to an executable file, then restart the MCP host.',
  permission_denied: 'Make the Stage5 Browser profile and artifact directories writable by the current user, then retry.',
  profile_locked: 'Check browser_status.profileLockState. Let an owned worker finish releasing the profile, or close only the dedicated Stage5 browser normally when another process owns it. Do not delete lock files while a browser may still be running.',
  unknown_launch_failure: 'Call browser_diagnostics and inspect its preflight, profile, and last-launch fields before retrying.',
  worker_protocol_mismatch: 'Restart the MCP host so the MCP server and browser worker load the same build.',
};

export function isLaunchFailureReason(value: unknown): value is LaunchFailureReason {
  return typeof value === 'string' && (LAUNCH_FAILURE_REASONS as readonly string[]).includes(value);
}

export function suggestedActionForReason(reason: unknown): string | null {
  return isLaunchFailureReason(reason) ? SUGGESTED_ACTIONS[reason] : null;
}

function errorDescriptor(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error).toLowerCase();
  }
  const code = (error as NodeJS.ErrnoException).code;
  return `${error.name} ${code ?? ''} ${error.message}`.toLowerCase();
}

export function classifyLaunchFailure(error: unknown): LaunchFailureReason {
  if (error instanceof Stage5BrowserError && isLaunchFailureReason(error.details?.reason)) {
    return error.details.reason;
  }

  const descriptor = errorDescriptor(error);
  if (
    descriptor.includes('processsingleton') ||
    descriptor.includes('singletonlock') ||
    descriptor.includes('profile is already in use') ||
    descriptor.includes('user data directory is already in use') ||
    descriptor.includes('another browser is using')
  ) {
    return 'profile_locked';
  }
  if (descriptor.includes('eacces') || descriptor.includes('eperm') || descriptor.includes('permission denied')) {
    return 'permission_denied';
  }
  if (
    descriptor.includes('executable doesn\'t exist') ||
    descriptor.includes('executable does not exist') ||
    descriptor.includes('enoent')
  ) {
    return 'browser_executable_missing';
  }
  if (descriptor.includes('timeout') || descriptor.includes('timed out')) {
    return 'launch_timeout';
  }
  if (
    descriptor.includes('missing x server') ||
    descriptor.includes('cannot open display') ||
    descriptor.includes('unable to open x display')
  ) {
    return 'display_unavailable';
  }
  if (
    descriptor.includes('browser has been closed') ||
    descriptor.includes('browser process exited') ||
    descriptor.includes('target page, context or browser has been closed')
  ) {
    return 'browser_process_exited';
  }
  return 'unknown_launch_failure';
}

export function launchFailureDiagnostic(
  browser: BrowserProduct,
  error: unknown,
  occurredAt = new Date(),
): LaunchFailureDiagnostic {
  const reason = classifyLaunchFailure(error);
  return {
    browser,
    engine: BROWSER_ENGINES[browser],
    reason,
    occurredAt: occurredAt.toISOString(),
    suggestedAction: SUGGESTED_ACTIONS[reason],
  };
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function nearestExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;
  while (!(await pathExists(current))) {
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

export async function inspectProfile(
  profilePath: string,
  browserConnected: boolean,
): Promise<ProfileDiagnostics> {
  const exists = await pathExists(profilePath);
  const writableTarget = exists ? profilePath : await nearestExistingAncestor(profilePath);
  let writable = false;
  try {
    await access(writableTarget, constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }

  const knownLocks = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'parent.lock', 'lock'];
  const lockChecks = await Promise.all(
    knownLocks.map(async (name) => ({ name, exists: await pathExists(path.join(profilePath, name)) })),
  );
  const lockFiles = lockChecks.filter((entry) => entry.exists).map((entry) => entry.name);
  return {
    path: profilePath,
    exists,
    writable,
    lockFiles,
    lockState:
      lockFiles.length === 0
        ? 'none'
        : browserConnected
          ? 'owned_browser_running'
          : 'possible_external_owner',
  };
}
