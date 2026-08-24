import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  type BrowserLaunchTarget,
  type BrowserProduct,
} from './browser-provider.js';
import { Stage5BrowserError } from './errors.js';
import {
  executablePathForTarget,
  launchIdentityForTarget,
  type BrowserLaunchIdentity,
} from './profile-binding.js';

export type ProfileShutdownState = 'clean' | 'unclean' | 'unknown';

export interface ProfileShutdownInspection {
  state: ProfileShutdownState;
  exitType: 'crashed' | 'normal' | 'session_ended' | 'unknown' | null;
  exitedCleanly: boolean | null;
  exitedCleanlySource: 'preferences_flag' | 'exit_type' | 'profile_lock' | 'process_exit' | 'insufficient_evidence';
  profileDirectory: string | null;
  profileLocks: string[];
  preferencesModifiedAt: string | null;
}

export type ProfileExitMarkerComparison =
  | 'unchanged_from_before_handoff'
  | 'rewritten_with_same_value'
  | 'changed_during_handoff'
  | 'unavailable';

export interface ProfileShutdownDecision extends ProfileShutdownInspection {
  exitTypeComparison: ProfileExitMarkerComparison;
  currentSessionEvidence: 'clean_process_exit' | 'abnormal_process_exit' | 'process_exit_unknown';
  reattachmentDecision: 'allowed' | 'override_available' | 'explicit_unlocked_profile_override';
}

export interface HumanBrowserProcessState {
  running: boolean;
  processId: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  launchedAt: string;
}

export interface HumanBrowserSession {
  state(): HumanBrowserProcessState;
  identity(): BrowserLaunchIdentity;
  waitForExit(timeoutMs: number): Promise<boolean>;
}

export interface HumanBrowserLaunchInput {
  target: BrowserLaunchTarget;
  profileDir: string;
  handoffLabel: string;
  url: string;
}

export interface HumanBrowserLauncher {
  launch(input: HumanBrowserLaunchInput): Promise<HumanBrowserSession>;
}

export interface HumanBrowserLaunchPolicy {
  supported: boolean;
  browser: BrowserProduct;
  engine: BrowserLaunchTarget['engine'];
  controlledByPlaywright: false;
  automationFlagsPresent: false;
  argumentKinds: Array<'identity_marker' | 'new_window' | 'profile_directory' | 'profile_partition'>;
}

const HANDOFF_MARKER_PREFIX = 'data:text/html;charset=utf-8,';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function stage5HandoffMarkerUrl(label: string): string {
  const safeLabel = escapeHtml(label.slice(0, 200));
  const document = `<!doctype html><html><head><meta charset="utf-8"><meta name="stage5-browser-handoff" content="true"><title>${safeLabel}</title><style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;margin:0;display:grid;place-items:center;min-height:100vh}main{max-width:42rem;padding:3rem}h1{font-size:2rem}p{color:#cbd5e1;line-height:1.5}</style></head><body><main><h1>${safeLabel}</h1><p>This marker identifies the dedicated Stage5 authentication window. Use the adjacent sign-in tab, then quit this exact browser application normally.</p></main></body></html>`;
  return `${HANDOFF_MARKER_PREFIX}${encodeURIComponent(document)}`;
}

export function isStage5HandoffMarkerUrl(value: string): boolean {
  if (!value.startsWith(HANDOFF_MARKER_PREFIX)) {
    return false;
  }
  try {
    return decodeURIComponent(value.slice(HANDOFF_MARKER_PREFIX.length))
      .includes('<meta name="stage5-browser-handoff" content="true">');
  } catch {
    return false;
  }
}

const PROFILE_LOCK_NAMES = [
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  '.parentlock',
  'parent.lock',
  'lock',
] as const;

export function humanBrowserLaunchPolicy(target: BrowserLaunchTarget): HumanBrowserLaunchPolicy {
  return {
    supported: target.engine === 'chromium' || target.engine === 'firefox',
    browser: target.browser,
    engine: target.engine,
    controlledByPlaywright: false,
    automationFlagsPresent: false,
    argumentKinds: target.engine === 'chromium'
      ? ['profile_directory', 'profile_partition', 'identity_marker', 'new_window']
      : ['profile_directory', 'identity_marker', 'new_window'],
  };
}

export function humanBrowserArguments(input: HumanBrowserLaunchInput): string[] {
  const identity = launchIdentityForTarget(input.target, input.profileDir);
  const markerUrl = stage5HandoffMarkerUrl(input.handoffLabel);
  if (input.target.engine === 'chromium') {
    return [
      `--user-data-dir=${identity.profile.userDataDir}`,
      `--profile-directory=${identity.profile.profileDirectory}`,
      '--new-window',
      markerUrl,
      input.url,
    ];
  }
  if (input.target.engine === 'firefox') {
    return [
      '-profile',
      input.profileDir,
      '-new-instance',
      '-new-window',
      markerUrl,
      '-new-tab',
      input.url,
    ];
  }
  throw new Stage5BrowserError(
    'AUTH_HANDOFF_UNAVAILABLE',
    'Human authentication bootstrap is not available for the selected browser engine.',
    {
      recoverable: true,
      details: {
        reason: 'human_bootstrap_engine_unsupported',
        browser: input.target.browser,
        engine: input.target.engine,
        suggestedAction: 'Select Brave, Chrome, Edge, Chromium, or Firefox for the human authentication bootstrap.',
      },
    },
  );
}

class SpawnedHumanBrowserSession implements HumanBrowserSession {
  private running = true;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private readonly launchedAt = new Date().toISOString();

  constructor(
    private readonly child: ChildProcess,
    private readonly launchIdentity: BrowserLaunchIdentity,
  ) {
    child.once('exit', (code, signal) => {
      this.running = false;
      this.exitCode = code;
      this.exitSignal = signal;
    });
  }

  state(): HumanBrowserProcessState {
    return {
      running: this.running && this.child.exitCode === null && this.child.signalCode === null,
      processId: this.child.pid ?? null,
      exitCode: this.exitCode ?? this.child.exitCode,
      exitSignal: this.exitSignal ?? this.child.signalCode,
      launchedAt: this.launchedAt,
    };
  }

  identity(): BrowserLaunchIdentity {
    return this.launchIdentity;
  }

  async waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.state().running) {
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.child.off('exit', onExit);
        resolve(false);
      }, timeoutMs);
      this.child.once('exit', onExit);
      if (!this.state().running) {
        this.child.off('exit', onExit);
        clearTimeout(timer);
        resolve(true);
      }
    });
  }
}

export class NativeHumanBrowserLauncher implements HumanBrowserLauncher {
  async launch(input: HumanBrowserLaunchInput): Promise<HumanBrowserSession> {
    const policy = humanBrowserLaunchPolicy(input.target);
    if (!policy.supported) {
      humanBrowserArguments(input);
    }

    const identity = launchIdentityForTarget(input.target, input.profileDir);
    const child = spawn(executablePathForTarget(input.target), humanBrowserArguments(input), {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
      windowsHide: false,
    });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off('error', onError);
        resolve();
      };
      const onError = (error: Error): void => {
        child.off('spawn', onSpawn);
        reject(error);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
    child.unref();
    return new SpawnedHumanBrowserSession(child, identity);
  }
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

export async function profileLocks(profileDir: string): Promise<string[]> {
  const checks = await Promise.all(
    PROFILE_LOCK_NAMES.map(async (name) => ({ name, exists: await pathExists(path.join(profileDir, name)) })),
  );
  return checks.filter((entry) => entry.exists).map((entry) => entry.name);
}

export async function waitForProfileUnlock(profileDir: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  do {
    if ((await profileLocks(profileDir)).length === 0) {
      return true;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, timeoutMs - (Date.now() - startedAt))));
  } while (Date.now() - startedAt < timeoutMs);
  return (await profileLocks(profileDir)).length === 0;
}

async function readJson(candidate: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(candidate, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function modifiedAt(candidate: string): Promise<string | null> {
  try {
    return (await stat(candidate)).mtime.toISOString();
  } catch {
    return null;
  }
}

function safeProfileDirectoryName(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9 _.-]{1,80}$/.test(value) && !value.includes('..')
    ? value
    : 'Default';
}

function normalizedExitType(value: unknown): ProfileShutdownInspection['exitType'] {
  if (typeof value !== 'string') {
    return null;
  }
  switch (value.toLocaleLowerCase()) {
    case 'normal':
      return 'normal';
    case 'sessionended':
    case 'session_ended':
      return 'session_ended';
    case 'crashed':
      return 'crashed';
    default:
      return 'unknown';
  }
}

export async function inspectProfileShutdown(
  profileDir: string,
  browser: BrowserProduct,
  pinnedProfileDirectory?: string | null,
): Promise<ProfileShutdownInspection> {
  const locks = await profileLocks(profileDir);
  if (!['chromium', 'chrome', 'brave', 'edge'].includes(browser)) {
    return {
      state: locks.length === 0 ? 'unknown' : 'unclean',
      exitType: null,
      exitedCleanly: null,
      exitedCleanlySource: locks.length > 0 ? 'profile_lock' : 'insufficient_evidence',
      profileDirectory: null,
      profileLocks: locks,
      preferencesModifiedAt: null,
    };
  }

  const localState = await readJson(path.join(profileDir, 'Local State'));
  const localStateProfile = localState?.profile;
  const profileName = pinnedProfileDirectory === undefined
    ? safeProfileDirectoryName(
        typeof localStateProfile === 'object' && localStateProfile !== null
          ? (localStateProfile as Record<string, unknown>).last_used
          : null,
      )
    : safeProfileDirectoryName(pinnedProfileDirectory);
  const preferencesPath = path.join(profileDir, profileName, 'Preferences');
  const preferences = await readJson(preferencesPath);
  const profile = preferences?.profile;
  const profilePreferences = typeof profile === 'object' && profile !== null
    ? profile as Record<string, unknown>
    : null;
  const exitType = normalizedExitType(profilePreferences?.exit_type);
  const explicitExitedCleanly = typeof profilePreferences?.exited_cleanly === 'boolean'
    ? profilePreferences.exited_cleanly
    : null;
  const exitedCleanly = explicitExitedCleanly !== null
    ? explicitExitedCleanly
    : locks.length > 0 || exitType === 'crashed'
      ? false
      : exitType === 'normal' || exitType === 'session_ended'
        ? true
        : null;
  const exitedCleanlySource: ProfileShutdownInspection['exitedCleanlySource'] =
    explicitExitedCleanly !== null
      ? 'preferences_flag'
      : locks.length > 0
        ? 'profile_lock'
        : exitType === 'normal' || exitType === 'session_ended' || exitType === 'crashed'
          ? 'exit_type'
          : 'insufficient_evidence';
  const clean = locks.length === 0 && (
    exitedCleanly === true || exitType === 'normal' || exitType === 'session_ended'
  );
  const unclean = locks.length > 0 || exitedCleanly === false || exitType === 'crashed';
  return {
    state: unclean ? 'unclean' : clean ? 'clean' : 'unknown',
    exitType,
    exitedCleanly,
    exitedCleanlySource,
    profileDirectory: profileName,
    profileLocks: locks,
    preferencesModifiedAt: await modifiedAt(preferencesPath),
  };
}

export function compareProfileExitMarker(
  before: ProfileShutdownInspection,
  after: ProfileShutdownInspection,
): ProfileExitMarkerComparison {
  if (
    before.exitType === null
    || after.exitType === null
    || before.preferencesModifiedAt === null
    || after.preferencesModifiedAt === null
  ) {
    return 'unavailable';
  }
  if (before.exitType !== after.exitType) {
    return 'changed_during_handoff';
  }
  return before.preferencesModifiedAt === after.preferencesModifiedAt
    ? 'unchanged_from_before_handoff'
    : 'rewritten_with_same_value';
}
