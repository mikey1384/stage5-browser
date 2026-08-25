import { spawn } from 'node:child_process';
import { lstat, readlink } from 'node:fs/promises';
import path from 'node:path';

import { processIsRunning } from './native-control-channel.js';

export type OwnedBrowserWindowActivationReason =
  | 'activated'
  | 'activation_failed'
  | 'activation_state_unverified'
  | 'activation_timed_out'
  | 'invalid_process_id'
  | 'owned_process_not_running'
  | 'platform_unsupported';

export interface OwnedBrowserWindowActivationResult {
  attempted: boolean;
  supported: boolean;
  ownedProcessRunning: boolean | null;
  applicationActivated: boolean;
  applicationHiddenBefore: boolean | null;
  unhideAttempted: boolean;
  unhideSucceeded: boolean | null;
  activationRequestAccepted: boolean | null;
  applicationFrontmostAfter: boolean | null;
  applicationHiddenAfter: boolean | null;
  reason: OwnedBrowserWindowActivationReason;
}

export interface OwnedBrowserWindowActivator {
  readonly supported: boolean;
  activateOwnedProcess(
    processId: number,
    timeoutMs: number,
  ): Promise<OwnedBrowserWindowActivationResult>;
}

export type NativeActivationCommandOutcome = 'failed' | 'succeeded' | 'timed_out';
export interface NativeActivationCommandState {
  applicationHiddenBefore: boolean;
  unhideAttempted: boolean;
  activationRequestAccepted: boolean;
  applicationFrontmostAfter: boolean;
  applicationHiddenAfter: boolean;
}
export interface NativeActivationCommandResult {
  outcome: NativeActivationCommandOutcome;
  state: NativeActivationCommandState | null;
}
export type NativeActivationCommandRunner = (
  processId: number,
  timeoutMs: number,
) => Promise<NativeActivationCommandResult>;

type ProcessProbe = (processId: number) => boolean;

const MACOS_ACTIVATION_SCRIPT = String.raw`
ObjC.import('AppKit');
const processId = __STAGE5_PROCESS_ID__;
const application = $.NSRunningApplication.runningApplicationWithProcessIdentifier(processId);
if (!application) {
  throw new Error('owned_application_unavailable');
}
const applicationHiddenBefore = Boolean(application.hidden);
const unhideAttempted = applicationHiddenBefore;
if (unhideAttempted) {
  application.unhide;
}
const activationOptions = $.NSApplicationActivateAllWindows |
  $.NSApplicationActivateIgnoringOtherApps;
const activationRequestAccepted = Boolean(application.activateWithOptions(activationOptions));
for (let attempt = 0; attempt < 20; attempt += 1) {
  if (Boolean(application.active) && !Boolean(application.hidden)) {
    break;
  }
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.025));
}
JSON.stringify({
  applicationHiddenBefore,
  unhideAttempted,
  activationRequestAccepted,
  applicationFrontmostAfter: Boolean(application.active),
  applicationHiddenAfter: Boolean(application.hidden),
});
`;

const MAX_NATIVE_ACTIVATION_OUTPUT_BYTES = 4_096;

function parseNativeActivationState(output: string): NativeActivationCommandState | null {
  try {
    const parsed = JSON.parse(output.trim()) as Partial<NativeActivationCommandState>;
    if (
      typeof parsed.applicationHiddenBefore !== 'boolean' ||
      typeof parsed.unhideAttempted !== 'boolean' ||
      typeof parsed.activationRequestAccepted !== 'boolean' ||
      typeof parsed.applicationFrontmostAfter !== 'boolean' ||
      typeof parsed.applicationHiddenAfter !== 'boolean'
    ) {
      return null;
    }
    return parsed as NativeActivationCommandState;
  } catch {
    return null;
  }
}

async function runMacOsActivationCommand(
  processId: number,
  timeoutMs: number,
): Promise<NativeActivationCommandResult> {
  const script = MACOS_ACTIVATION_SCRIPT.replace('__STAGE5_PROCESS_ID__', String(processId));
  return new Promise<NativeActivationCommandResult>((resolve) => {
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let output = '';
    let outputExceededLimit = false;
    let settled = false;
    const settle = (result: NativeActivationCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ outcome: 'timed_out', state: null });
    }, Math.max(1, timeoutMs));
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (outputExceededLimit) return;
      output += chunk;
      if (Buffer.byteLength(output, 'utf8') > MAX_NATIVE_ACTIVATION_OUTPUT_BYTES) {
        outputExceededLimit = true;
        output = '';
      }
    });
    child.once('error', () => settle({ outcome: 'failed', state: null }));
    child.once('exit', (code, signal) => {
      const state = outputExceededLimit ? null : parseNativeActivationState(output);
      const stateVerified = state?.applicationFrontmostAfter === true &&
        state.applicationHiddenAfter === false;
      settle({
        outcome: code === 0 && signal === null && stateVerified ? 'succeeded' : 'failed',
        state,
      });
    });
  });
}

/**
 * Foregrounds only the exact Stage5-owned macOS application process. It never
 * selects applications by display name, bundle name, window title, or page text.
 */
export class NativeOwnedBrowserWindowActivator implements OwnedBrowserWindowActivator {
  readonly supported: boolean;

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly commandRunner: NativeActivationCommandRunner = runMacOsActivationCommand,
    private readonly processProbe: ProcessProbe = processIsRunning,
  ) {
    this.supported = platform === 'darwin';
  }

  async activateOwnedProcess(
    processId: number,
    timeoutMs: number,
  ): Promise<OwnedBrowserWindowActivationResult> {
    if (!Number.isSafeInteger(processId) || processId <= 0) {
      return {
        attempted: false,
        supported: this.supported,
        ownedProcessRunning: null,
        applicationActivated: false,
        applicationHiddenBefore: null,
        unhideAttempted: false,
        unhideSucceeded: null,
        activationRequestAccepted: null,
        applicationFrontmostAfter: null,
        applicationHiddenAfter: null,
        reason: 'invalid_process_id',
      };
    }
    if (!this.supported) {
      return {
        attempted: false,
        supported: false,
        ownedProcessRunning: null,
        applicationActivated: false,
        applicationHiddenBefore: null,
        unhideAttempted: false,
        unhideSucceeded: null,
        activationRequestAccepted: null,
        applicationFrontmostAfter: null,
        applicationHiddenAfter: null,
        reason: 'platform_unsupported',
      };
    }
    if (!this.processProbe(processId)) {
      return {
        attempted: false,
        supported: true,
        ownedProcessRunning: false,
        applicationActivated: false,
        applicationHiddenBefore: null,
        unhideAttempted: false,
        unhideSucceeded: null,
        activationRequestAccepted: null,
        applicationFrontmostAfter: null,
        applicationHiddenAfter: null,
        reason: 'owned_process_not_running',
      };
    }

    const command = await this.commandRunner(processId, timeoutMs);
    const state = command.state;
    const applicationActivated = command.outcome === 'succeeded' &&
      state?.applicationFrontmostAfter === true &&
      state.applicationHiddenAfter === false;
    return {
      attempted: true,
      supported: true,
      ownedProcessRunning: true,
      applicationActivated,
      applicationHiddenBefore: state?.applicationHiddenBefore ?? null,
      unhideAttempted: state?.unhideAttempted ?? false,
      unhideSucceeded: state?.unhideAttempted === true
        ? state.applicationHiddenAfter === false
        : null,
      activationRequestAccepted: state?.activationRequestAccepted ?? null,
      applicationFrontmostAfter: state?.applicationFrontmostAfter ?? null,
      applicationHiddenAfter: state?.applicationHiddenAfter ?? null,
      reason: applicationActivated
        ? 'activated'
        : command.outcome === 'timed_out'
          ? 'activation_timed_out'
          : state !== null
            ? 'activation_state_unverified'
            : 'activation_failed',
    };
  }
}

/**
 * Resolves the process that owns an already-running dedicated Chromium profile.
 * The singleton target is consumed only as an internal ownership fact; neither
 * the target nor the PID is returned through the MCP protocol.
 */
export async function chromiumProfileOwnerProcessId(
  profileRoot: string,
  processProbe: ProcessProbe = processIsRunning,
): Promise<number | null> {
  try {
    const singletonLock = path.join(profileRoot, 'SingletonLock');
    const metadata = await lstat(singletonLock);
    if (!metadata.isSymbolicLink()) {
      return null;
    }
    const target = await readlink(singletonLock);
    const match = /-(\d+)$/.exec(target);
    if (match === null) {
      return null;
    }
    const processId = Number.parseInt(match[1] ?? '', 10);
    return Number.isSafeInteger(processId) && processId > 0 && processProbe(processId)
      ? processId
      : null;
  } catch {
    return null;
  }
}
