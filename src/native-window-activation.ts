import { spawn } from 'node:child_process';
import { lstat, readlink } from 'node:fs/promises';
import path from 'node:path';

import { processIsRunning } from './native-control-channel.js';

export type OwnedBrowserWindowActivationReason =
  | 'activated'
  | 'activation_failed'
  | 'activation_timed_out'
  | 'invalid_process_id'
  | 'owned_process_not_running'
  | 'platform_unsupported';

export interface OwnedBrowserWindowActivationResult {
  attempted: boolean;
  supported: boolean;
  ownedProcessRunning: boolean | null;
  applicationActivated: boolean;
  reason: OwnedBrowserWindowActivationReason;
}

export interface OwnedBrowserWindowActivator {
  readonly supported: boolean;
  activateOwnedProcess(
    processId: number,
    timeoutMs: number,
  ): Promise<OwnedBrowserWindowActivationResult>;
}

export type NativeActivationCommandResult = 'failed' | 'succeeded' | 'timed_out';
export type NativeActivationCommandRunner = (
  processId: number,
  timeoutMs: number,
) => Promise<NativeActivationCommandResult>;

type ProcessProbe = (processId: number) => boolean;

const MACOS_ACTIVATION_SCRIPT = String.raw`
ObjC.import('AppKit');
const processId = __STAGE5_PROCESS_ID__;
const application = $.NSRunningApplication.runningApplicationWithProcessIdentifier(processId);
const activated = application.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
if (!activated) {
  throw new Error('owned_application_activation_failed');
}
`;

async function runMacOsActivationCommand(
  processId: number,
  timeoutMs: number,
): Promise<NativeActivationCommandResult> {
  const script = MACOS_ACTIVATION_SCRIPT.replace('__STAGE5_PROCESS_ID__', String(processId));
  return new Promise<NativeActivationCommandResult>((resolve) => {
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], {
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    const settle = (result: NativeActivationCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle('timed_out');
    }, Math.max(1, timeoutMs));
    child.once('error', () => settle('failed'));
    child.once('exit', (code, signal) => {
      settle(code === 0 && signal === null ? 'succeeded' : 'failed');
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
        reason: 'invalid_process_id',
      };
    }
    if (!this.supported) {
      return {
        attempted: false,
        supported: false,
        ownedProcessRunning: null,
        applicationActivated: false,
        reason: 'platform_unsupported',
      };
    }
    if (!this.processProbe(processId)) {
      return {
        attempted: false,
        supported: true,
        ownedProcessRunning: false,
        applicationActivated: false,
        reason: 'owned_process_not_running',
      };
    }

    const result = await this.commandRunner(processId, timeoutMs);
    return {
      attempted: true,
      supported: true,
      ownedProcessRunning: true,
      applicationActivated: result === 'succeeded',
      reason: result === 'succeeded'
        ? 'activated'
        : result === 'timed_out'
          ? 'activation_timed_out'
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
