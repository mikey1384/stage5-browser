import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { processIsRunning } from '../native-control-channel.js';
import type { BrowserLaunchIdentity } from '../profile-binding.js';
import type { ProcessTableEntry, ProfileOwnershipDependencies } from './types.js';

const PROCESS_COMMAND_TIMEOUT_MS = 1_000;

function runCommand(command: string, arguments_: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, arguments_, {
      encoding: 'utf8',
      maxBuffer: 2 * 1_024 * 1_024,
      timeout: PROCESS_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout) => resolve(error === null ? stdout : null));
  });
}

export async function processExecutablePath(processId: number): Promise<string | null> {
  if (process.platform === 'darwin') {
    return (await runCommand('/bin/ps', ['-p', String(processId), '-o', 'comm=']))?.trim() || null;
  }
  if (process.platform === 'linux') {
    try {
      return await realpath(`/proc/${processId}/exe`);
    } catch {
      return null;
    }
  }
  return null;
}

export async function processStartedAtToken(processId: number): Promise<string | null> {
  if (process.platform === 'darwin') {
    return (await runCommand('/bin/ps', ['-p', String(processId), '-o', 'lstart=']))?.trim() || null;
  }
  if (process.platform === 'linux') {
    try {
      const [stat, bootId] = await Promise.all([
        readFile(`/proc/${processId}/stat`, 'utf8'),
        readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      ]);
      const closeParenthesis = stat.lastIndexOf(')');
      const fields = stat.slice(closeParenthesis + 2).split(' ');
      const startTicks = fields[19];
      return typeof startTicks === 'string' && startTicks.length > 0
        ? `${bootId.trim()}:${startTicks}`
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function defaultProcessTable(): Promise<ProcessTableEntry[] | null> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  const output = await runCommand('/bin/ps', ['-axo', 'pid=,ppid=,comm=']);
  if (output === null) return null;
  const entries: ProcessTableEntry[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    const processId = Number.parseInt(match[1] ?? '', 10);
    const parentProcessId = Number.parseInt(match[2] ?? '', 10);
    const executablePath = match[3] ?? '';
    if (
      Number.isSafeInteger(processId)
      && processId > 0
      && Number.isSafeInteger(parentProcessId)
      && parentProcessId >= 0
      && executablePath.length > 0
    ) {
      entries.push({ processId, parentProcessId, executablePath });
    }
  }
  return entries;
}

export const DEFAULT_DEPENDENCIES: ProfileOwnershipDependencies = {
  now: () => new Date(),
  processRunning: processIsRunning,
  processStartedAt: processStartedAtToken,
  processExecutable: processExecutablePath,
  processTable: defaultProcessTable,
  signalProcess: (processId, signal) => process.kill(processId, signal),
};

async function canonicalExecutableMatches(observed: string, expected: string): Promise<boolean> {
  try {
    return await realpath(observed) === await realpath(expected);
  } catch {
    return false;
  }
}

export async function executableFingerprint(executablePath: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await realpath(executablePath)).digest('hex');
  } catch {
    return null;
  }
}

export async function trustedExecutableMatches(
  observed: string,
  identity: BrowserLaunchIdentity,
): Promise<boolean> {
  if (await canonicalExecutableMatches(observed, identity.executablePath)) return true;
  if (identity.executableSource !== 'bundled') return false;
  try {
    const [observedCanonical, expectedCanonical] = await Promise.all([
      realpath(observed),
      realpath(identity.executablePath),
    ]);
    const expectedParts = expectedCanonical.split(path.sep);
    const bundleIndex = expectedParts.findIndex((part) => /^(?:chromium|firefox|webkit)-\d+$/.test(part));
    if (bundleIndex < 0) return false;
    const browserRoot = expectedParts.slice(0, bundleIndex).join(path.sep) || path.sep;
    const expectedBundle = expectedParts[bundleIndex];
    if (expectedBundle === undefined) return false;
    const [family, revision] = expectedBundle.split('-');
    const observedRelative = path.relative(browserRoot, observedCanonical);
    const observedBundle = observedRelative.split(path.sep)[0] ?? '';
    const trustedBundle = observedBundle === expectedBundle
      || (family === 'chromium' && observedBundle === `chromium_headless_shell-${revision}`);
    return observedRelative !== ''
      && !observedRelative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(observedRelative)
      && trustedBundle;
  } catch {
    return false;
  }
}
