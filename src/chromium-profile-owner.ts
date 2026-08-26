import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';

import type { BrowserProduct } from './browser-provider.js';
import { isStage5HandoffMarkerUrl } from './human-auth-bootstrap.js';
import { readNativeControlRecord, type NativeControlRecord } from './native-control-channel.js';
import { chromiumProfileOwnerProcessId } from './native-window-activation.js';
import type { BrowserLaunchIdentity } from './profile-binding.js';

export type ProfileOwnerClassification =
  | 'authentication_handoff_pending'
  | 'busy_other_stage5_session'
  | 'controlled'
  | 'dedicated_browser_control_unavailable'
  | 'external_owner'
  | 'none'
  | 'owned_active'
  | 'owned_orphaned'
  | 'owner_process_unavailable'
  | 'reconnectable_stage5_browser'
  | 'unknown_lock_owner';

export interface ProfileOwnerEvidence {
  classification: ProfileOwnerClassification;
  ownership: 'none' | 'not_proven' | 'proven';
  lockOwnerProcess: 'none' | 'not_running_or_unreadable' | 'running';
  expectedApplication: string | null;
  applicationIdentity: 'matched' | 'mismatched' | 'unverified';
  loopbackControl: 'absent' | 'ambiguous' | 'available' | 'unverified';
  authenticationHandoff: 'absent' | 'present' | 'unverified';
  recovery:
    | 'automatic_reattach'
    | 'automatic_owned_restart'
    | 'close_dedicated_browser_normally'
    | 'do_not_modify_locks'
    | 'none'
    | 'return_to_authentication_handoff';
  suggestedAction: string | null;
  lease?: {
    state: ProfileOwnershipLeasePublicState;
    ownerWorkerRunning: boolean | null;
    heartbeat: 'fresh' | 'stale' | 'unavailable';
    browserProcess: 'matched' | 'mismatched' | 'not_running' | 'unavailable';
    controlMode: 'human_handoff' | 'native_cdp' | 'playwright' | null;
    phase:
      | 'close_requested'
      | 'human_input'
      | 'launching'
      | 'owned_active'
      | 'process_exited'
      | 'profile_unlocked'
      | null;
  };
}

export type ProfileOwnershipLeasePublicState =
  | 'abandoned'
  | 'busy_other_stage5_session'
  | 'current_owner'
  | 'invalid'
  | 'owned_orphaned';

export interface ChromiumProfileOwnerInspection {
  evidence: ProfileOwnerEvidence;
  /** Internal-only exact recovery capability. Never serialize this object to an agent. */
  reconnectRecord: NativeControlRecord | null;
  /** Internal-only exact pending-handoff capability. Never attach without an explicit resume call. */
  handoffRecord: NativeControlRecord | null;
}

export interface DevToolsEndpointInspection {
  valid: boolean;
  authenticationHandoff: 'absent' | 'present' | 'unverified';
}

export interface ChromiumProfileOwnerInspectionDependencies {
  ownerProcessId: (profileRoot: string) => Promise<number | null>;
  processExecutable: (processId: number) => Promise<string | null>;
  loopbackListeningPorts: (processId: number) => Promise<number[] | null>;
  inspectDevToolsEndpoint: (port: number) => Promise<DevToolsEndpointInspection>;
  now: () => Date;
  platform: NodeJS.Platform;
}

const COMMAND_TIMEOUT_MS = 1_000;
const ENDPOINT_TIMEOUT_MS = 750;
const MAX_ENDPOINT_RESPONSE_CHARACTERS = 2_000_000;
const MAX_LISTENING_PORTS_TO_PROBE = 16;

function runCommand(command: string, arguments_: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, arguments_, {
      encoding: 'utf8',
      maxBuffer: 128 * 1_024,
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout) => {
      resolve(error === null ? stdout : null);
    });
  });
}

async function defaultProcessExecutable(processId: number): Promise<string | null> {
  if (process.platform === 'darwin') {
    const output = await runCommand('/bin/ps', ['-p', String(processId), '-o', 'comm=']);
    return output?.trim() || null;
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

function parseLoopbackListeningPorts(output: string): number[] {
  const ports = new Set<number>();
  for (const line of output.split('\n')) {
    const match = /^n127\.0\.0\.1:(\d+)$/.exec(line.trim());
    if (match === null) continue;
    const port = Number.parseInt(match[1] ?? '', 10);
    if (Number.isSafeInteger(port) && port >= 1_024 && port <= 65_535) {
      ports.add(port);
    }
  }
  return [...ports].sort((left, right) => left - right);
}

async function defaultLoopbackListeningPorts(processId: number): Promise<number[] | null> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return null;
  }
  const executable = process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof';
  const output = await runCommand(executable, [
    '-nP',
    '-a',
    '-p',
    String(processId),
    '-iTCP',
    '-sTCP:LISTEN',
    '-Fn',
  ]);
  return output === null ? null : parseLoopbackListeningPorts(output);
}

async function boundedLoopbackJson(port: number, pathname: string): Promise<unknown | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > MAX_ENDPOINT_RESPONSE_CHARACTERS) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function defaultInspectDevToolsEndpoint(port: number): Promise<DevToolsEndpointInspection> {
  const version = await boundedLoopbackJson(port, '/json/version');
  if (typeof version !== 'object' || version === null) {
    return { valid: false, authenticationHandoff: 'unverified' };
  }
  const webSocketDebuggerUrl = (version as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl;
  if (typeof webSocketDebuggerUrl !== 'string') {
    return { valid: false, authenticationHandoff: 'unverified' };
  }
  try {
    const endpoint = new URL(webSocketDebuggerUrl);
    if (
      endpoint.protocol !== 'ws:'
      || endpoint.hostname !== '127.0.0.1'
      || Number.parseInt(endpoint.port, 10) !== port
    ) {
      return { valid: false, authenticationHandoff: 'unverified' };
    }
  } catch {
    return { valid: false, authenticationHandoff: 'unverified' };
  }

  const targets = await boundedLoopbackJson(port, '/json/list');
  if (!Array.isArray(targets)) {
    return { valid: true, authenticationHandoff: 'unverified' };
  }
  const markerPresent = targets.some((target) => {
    if (typeof target !== 'object' || target === null) return false;
    const candidate = target as { type?: unknown; url?: unknown };
    return candidate.type === 'page'
      && typeof candidate.url === 'string'
      && isStage5HandoffMarkerUrl(candidate.url);
  });
  return {
    valid: true,
    authenticationHandoff: markerPresent ? 'present' : 'absent',
  };
}

const DEFAULT_DEPENDENCIES: ChromiumProfileOwnerInspectionDependencies = {
  ownerProcessId: chromiumProfileOwnerProcessId,
  processExecutable: defaultProcessExecutable,
  loopbackListeningPorts: defaultLoopbackListeningPorts,
  inspectDevToolsEndpoint: defaultInspectDevToolsEndpoint,
  now: () => new Date(),
  platform: process.platform,
};

function normalQuitInstruction(applicationName: string, platform: NodeJS.Platform): string {
  return platform === 'darwin'
    ? `Close only the dedicated ${applicationName} application normally with Cmd-Q, wait for it to exit and release the profile, then call browser_start once. Do not delete lock files or force-close an unknown process.`
    : `Close only the dedicated ${applicationName} application normally from its application menu, wait for it to exit and release the profile, then call browser_start once. Do not delete lock files or force-close an unknown process.`;
}

export function emptyProfileOwnerEvidence(): ProfileOwnerEvidence {
  return {
    classification: 'none',
    ownership: 'none',
    lockOwnerProcess: 'none',
    expectedApplication: null,
    applicationIdentity: 'unverified',
    loopbackControl: 'unverified',
    authenticationHandoff: 'unverified',
    recovery: 'none',
    suggestedAction: null,
  };
}

export function controlledProfileOwnerEvidence(
  applicationName: string,
  authenticationHandoff = false,
): ProfileOwnerEvidence {
  return {
    classification: authenticationHandoff ? 'authentication_handoff_pending' : 'owned_active',
    ownership: 'proven',
    lockOwnerProcess: 'running',
    expectedApplication: applicationName,
    applicationIdentity: 'matched',
    loopbackControl: 'available',
    authenticationHandoff: authenticationHandoff ? 'present' : 'absent',
    recovery: authenticationHandoff ? 'return_to_authentication_handoff' : 'none',
    suggestedAction: authenticationHandoff
      ? 'Call browser_auth_status, then call browser_resume_after_login once after the private step. Do not start, relaunch, close, or modify the dedicated browser profile.'
      : null,
  };
}

async function canonicalExecutableMatches(observed: string, expected: string): Promise<boolean> {
  try {
    return await realpath(observed) === await realpath(expected);
  } catch {
    return false;
  }
}

/**
 * Inspects a locked dedicated Chromium profile without exposing its PID, ports,
 * command line, tabs, or URLs. Recovery is offered only when the live singleton
 * owner uses the exact configured executable, exposes one valid loopback CDP
 * endpoint, and no private-login marker remains.
 */
export async function inspectChromiumProfileOwner(
  profileRoot: string,
  identity: BrowserLaunchIdentity,
  dependencyOverrides: Partial<ChromiumProfileOwnerInspectionDependencies> = {},
): Promise<ChromiumProfileOwnerInspection> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const processId = await dependencies.ownerProcessId(profileRoot);
  if (processId === null) {
    return {
      evidence: {
        classification: 'external_owner',
        ownership: 'not_proven',
        lockOwnerProcess: 'not_running_or_unreadable',
        expectedApplication: identity.applicationName,
        applicationIdentity: 'unverified',
        loopbackControl: 'unverified',
        authenticationHandoff: 'unverified',
        recovery: 'do_not_modify_locks',
        suggestedAction: `Leave the dedicated ${identity.applicationName} profile locks untouched. If that exact Stage5 browser is visibly still exiting, wait for it to finish and call browser_start once; otherwise stop and ask the user to close only that dedicated application normally.`,
      },
      reconnectRecord: null,
      handoffRecord: null,
    };
  }

  const observedExecutable = await dependencies.processExecutable(processId);
  const executableMatched = observedExecutable !== null
    && await canonicalExecutableMatches(observedExecutable, identity.executablePath);
  if (!executableMatched) {
    return {
      evidence: {
        classification: 'external_owner',
        ownership: 'not_proven',
        lockOwnerProcess: 'running',
        expectedApplication: identity.applicationName,
        applicationIdentity: observedExecutable === null ? 'unverified' : 'mismatched',
        loopbackControl: 'unverified',
        authenticationHandoff: 'unverified',
        recovery: 'do_not_modify_locks',
        suggestedAction: `Do not retry, delete locks, or kill the lock owner because Stage5 cannot prove it is the dedicated ${identity.applicationName}. Ask the user to close only the visibly labeled Stage5 ${identity.applicationName} window normally; if no such window is visible, stop.`,
      },
      reconnectRecord: null,
      handoffRecord: null,
    };
  }

  const ports = await dependencies.loopbackListeningPorts(processId);
  if (ports === null || ports.length === 0 || ports.length > MAX_LISTENING_PORTS_TO_PROBE) {
    return {
      evidence: {
        classification: 'external_owner',
        ownership: 'proven',
        lockOwnerProcess: 'running',
        expectedApplication: identity.applicationName,
        applicationIdentity: 'matched',
        loopbackControl: ports === null ? 'unverified' : ports.length === 0 ? 'absent' : 'ambiguous',
        authenticationHandoff: 'unverified',
        recovery: 'close_dedicated_browser_normally',
        suggestedAction: normalQuitInstruction(identity.applicationName, dependencies.platform),
      },
      reconnectRecord: null,
      handoffRecord: null,
    };
  }

  const endpointInspections = await Promise.all(ports.map(async (port) => ({
    port,
    inspection: await dependencies.inspectDevToolsEndpoint(port),
  })));
  const validEndpoints = endpointInspections.filter((candidate) => candidate.inspection.valid);
  if (validEndpoints.length !== 1) {
    return {
      evidence: {
        classification: 'external_owner',
        ownership: 'proven',
        lockOwnerProcess: 'running',
        expectedApplication: identity.applicationName,
        applicationIdentity: 'matched',
        loopbackControl: validEndpoints.length === 0 ? 'absent' : 'ambiguous',
        authenticationHandoff: 'unverified',
        recovery: 'close_dedicated_browser_normally',
        suggestedAction: normalQuitInstruction(identity.applicationName, dependencies.platform),
      },
      reconnectRecord: null,
      handoffRecord: null,
    };
  }

  const endpoint = validEndpoints[0];
  if (endpoint === undefined) {
    throw new Error('Valid endpoint inspection unexpectedly disappeared.');
  }
  if (endpoint.inspection.authenticationHandoff !== 'absent') {
    const handoffPresent = endpoint.inspection.authenticationHandoff === 'present';
    const persistedRecord = handoffPresent
      ? await readNativeControlRecord(profileRoot, identity.browser as BrowserProduct)
      : null;
    const handoffRecord = persistedRecord?.state === 'awaiting_user'
      && persistedRecord.processId === processId
      && persistedRecord.port === endpoint.port
      ? persistedRecord
      : null;
    return {
      evidence: {
        classification: handoffPresent
          ? 'authentication_handoff_pending'
          : 'external_owner',
        ownership: 'proven',
        lockOwnerProcess: 'running',
        expectedApplication: identity.applicationName,
        applicationIdentity: 'matched',
        loopbackControl: 'available',
        authenticationHandoff: endpoint.inspection.authenticationHandoff,
        recovery: handoffPresent
          ? 'return_to_authentication_handoff'
          : 'close_dedicated_browser_normally',
        suggestedAction: handoffPresent
          ? 'Call browser_auth_status, then use browser_resume_after_login from the Stage5 session that recovers this exact durable handoff. Do not start, relaunch, close, or modify the dedicated browser profile.'
          : normalQuitInstruction(identity.applicationName, dependencies.platform),
      },
      reconnectRecord: null,
      handoffRecord,
    };
  }

  return {
    evidence: {
      classification: 'owned_orphaned',
      ownership: 'proven',
      lockOwnerProcess: 'running',
      expectedApplication: identity.applicationName,
      applicationIdentity: 'matched',
      loopbackControl: 'available',
      authenticationHandoff: 'absent',
      recovery: 'automatic_reattach',
      suggestedAction: 'Stage5 Browser can safely reattach automatically; no user action, lock deletion, process termination, deployment, or host restart is required.',
    },
    reconnectRecord: {
      version: 1,
      kind: 'chromium_cdp',
      browser: identity.browser as BrowserProduct,
      state: 'controlled',
      processId,
      port: endpoint.port,
      createdAt: dependencies.now().toISOString(),
    },
    handoffRecord: null,
  };
}
