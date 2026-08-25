import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  link,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  BROWSER_ENGINES,
  SUPPORTED_BROWSER_PRODUCTS,
  type BrowserEngine,
  type BrowserProduct,
} from './browser-provider.js';
import { profileLocks } from './human-auth-bootstrap.js';
import { processIsRunning } from './native-control-channel.js';
import { chromiumProfileOwnerProcessId } from './native-window-activation.js';
import type { BrowserLaunchIdentity } from './profile-binding.js';

const OWNERSHIP_LEASE_NAME = '.stage5-browser-ownership.json';
const HEARTBEAT_INTERVAL_MS = 1_000;
const ACTIVE_HEARTBEAT_MS = 5_000;
const PROCESS_COMMAND_TIMEOUT_MS = 1_000;

export type ProfileOwnershipControlMode = 'human_handoff' | 'native_cdp' | 'playwright';
export type ProfileOwnershipPhase =
  | 'close_requested'
  | 'human_input'
  | 'launching'
  | 'owned_active'
  | 'process_exited'
  | 'profile_unlocked';

export interface ProfileOwnershipLease {
  version: 1;
  leaseId: string;
  browser: BrowserProduct;
  engine: BrowserEngine;
  profileFingerprint: string;
  ownerWorkerProcessId: number;
  ownerWorkerStartedAt: string;
  browserProcessId: number | null;
  browserProcessStartedAt: string | null;
  browserExecutableFingerprint: string | null;
  controlMode: ProfileOwnershipControlMode;
  phase: ProfileOwnershipPhase;
  createdAt: string;
  heartbeatAt: string;
}

export interface ProfileOwnershipLeaseInspection {
  state:
    | 'abandoned'
    | 'busy_other_stage5_session'
    | 'current_owner'
    | 'invalid'
    | 'none'
    | 'owned_orphaned';
  lease: ProfileOwnershipLease | null;
  ownershipProven: boolean;
  ownerWorkerRunning: boolean | null;
  heartbeat: 'fresh' | 'stale' | 'unavailable';
  browserProcess: 'matched' | 'mismatched' | 'not_running' | 'unavailable';
}

export interface OwnedProcessObservation {
  processId: number;
  startedAt: string;
  executablePath: string;
}

export interface ProcessTableEntry {
  processId: number;
  parentProcessId: number;
  executablePath: string;
}

export interface ProfileOwnershipDependencies {
  now: () => Date;
  processRunning: (processId: number) => boolean;
  processStartedAt: (processId: number) => Promise<string | null>;
  processExecutable: (processId: number) => Promise<string | null>;
  processTable: () => Promise<ProcessTableEntry[] | null>;
  signalProcess: (processId: number, signal: NodeJS.Signals) => void;
}

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

const DEFAULT_DEPENDENCIES: ProfileOwnershipDependencies = {
  now: () => new Date(),
  processRunning: processIsRunning,
  processStartedAt: processStartedAtToken,
  processExecutable: processExecutablePath,
  processTable: defaultProcessTable,
  signalProcess: (processId, signal) => process.kill(processId, signal),
};

export function profileOwnershipLeasePath(profileRoot: string): string {
  return path.join(profileRoot, OWNERSHIP_LEASE_NAME);
}

export function profilePathFingerprint(profileRoot: string): string {
  return createHash('sha256').update(path.resolve(profileRoot)).digest('hex');
}

function validIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isProfileOwnershipLease(value: unknown): value is ProfileOwnershipLease {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ProfileOwnershipLease>;
  return candidate.version === 1
    && typeof candidate.leaseId === 'string'
    && /^[0-9a-f-]{36}$/i.test(candidate.leaseId)
    && typeof candidate.browser === 'string'
    && (SUPPORTED_BROWSER_PRODUCTS as readonly string[]).includes(candidate.browser)
    && typeof candidate.engine === 'string'
    && BROWSER_ENGINES[candidate.browser as BrowserProduct] === candidate.engine
    && typeof candidate.profileFingerprint === 'string'
    && /^[0-9a-f]{64}$/.test(candidate.profileFingerprint)
    && Number.isSafeInteger(candidate.ownerWorkerProcessId)
    && (candidate.ownerWorkerProcessId ?? 0) > 0
    && typeof candidate.ownerWorkerStartedAt === 'string'
    && (
      (
        candidate.browserProcessId === null
        && candidate.browserProcessStartedAt === null
        && candidate.browserExecutableFingerprint === null
      )
      || (
        Number.isSafeInteger(candidate.browserProcessId)
        && (candidate.browserProcessId ?? 0) > 0
        && typeof candidate.browserProcessStartedAt === 'string'
        && candidate.browserProcessStartedAt.length > 0
        && typeof candidate.browserExecutableFingerprint === 'string'
        && /^[0-9a-f]{64}$/.test(candidate.browserExecutableFingerprint)
      )
    )
    && (candidate.controlMode === 'human_handoff'
      || candidate.controlMode === 'native_cdp'
      || candidate.controlMode === 'playwright')
    && (candidate.phase === 'close_requested'
      || candidate.phase === 'human_input'
      || candidate.phase === 'launching'
      || candidate.phase === 'owned_active'
      || candidate.phase === 'process_exited'
      || candidate.phase === 'profile_unlocked')
    && validIsoDate(candidate.createdAt)
    && validIsoDate(candidate.heartbeatAt);
}

export async function writeProfileOwnershipLease(
  profileRoot: string,
  lease: ProfileOwnershipLease,
): Promise<void> {
  const destination = profileOwnershipLeasePath(profileRoot);
  const temporary = path.join(profileRoot, `.${OWNERSHIP_LEASE_NAME}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  await chmod(destination, 0o600);
}

export async function claimProfileOwnershipLease(
  profileRoot: string,
  lease: ProfileOwnershipLease,
): Promise<boolean> {
  const destination = profileOwnershipLeasePath(profileRoot);
  const temporary = path.join(profileRoot, `.${OWNERSHIP_LEASE_NAME}.${randomUUID()}.claim`);
  try {
    await writeFile(temporary, `${JSON.stringify(lease)}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await link(temporary, destination);
    await chmod(destination, 0o600);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readProfileOwnershipLease(profileRoot: string): Promise<ProfileOwnershipLease | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(profileOwnershipLeasePath(profileRoot), 'utf8'));
    return isProfileOwnershipLease(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function inspectProfileOwnershipLeaseFile(
  profileRoot: string,
): Promise<{ exists: boolean; lease: ProfileOwnershipLease | null }> {
  try {
    const parsed: unknown = JSON.parse(await readFile(profileOwnershipLeasePath(profileRoot), 'utf8'));
    return { exists: true, lease: isProfileOwnershipLease(parsed) ? parsed : null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, lease: null };
    }
    return { exists: true, lease: null };
  }
}

export async function removeProfileOwnershipLease(
  profileRoot: string,
  expectedLeaseId: string,
): Promise<boolean> {
  const current = await readProfileOwnershipLease(profileRoot);
  if (current?.leaseId !== expectedLeaseId) return false;
  await rm(profileOwnershipLeasePath(profileRoot), { force: true });
  return true;
}

async function canonicalExecutableMatches(observed: string, expected: string): Promise<boolean> {
  try {
    return await realpath(observed) === await realpath(expected);
  } catch {
    return false;
  }
}

async function executableFingerprint(executablePath: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await realpath(executablePath)).digest('hex');
  } catch {
    return null;
  }
}

async function trustedExecutableMatches(
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

async function browserProcessMatches(
  lease: ProfileOwnershipLease,
  identity: BrowserLaunchIdentity,
  dependencies: ProfileOwnershipDependencies,
): Promise<ProfileOwnershipLeaseInspection['browserProcess']> {
  const processId = lease.browserProcessId;
  if (processId === null) return 'unavailable';
  if (!dependencies.processRunning(processId)) return 'not_running';
  const [startedAt, executable] = await Promise.all([
    dependencies.processStartedAt(processId),
    dependencies.processExecutable(processId),
  ]);
  if (
    startedAt === null
    || lease.browserProcessStartedAt === null
    || startedAt !== lease.browserProcessStartedAt
    || executable === null
    || lease.browserExecutableFingerprint === null
    || await executableFingerprint(executable) !== lease.browserExecutableFingerprint
    || !(await trustedExecutableMatches(executable, identity))
  ) {
    return 'mismatched';
  }
  if (identity.engine === 'chromium' && identity.profile.userDataDir !== null) {
    const activeLocks = await profileLocks(identity.profile.userDataDir);
    const singletonPresent = activeLocks.some((name) => name.startsWith('Singleton'));
    if (singletonPresent) {
      const lockOwner = await chromiumProfileOwnerProcessId(
        identity.profile.userDataDir,
        dependencies.processRunning,
      );
      if (lockOwner !== processId) return 'mismatched';
    }
  }
  return 'matched';
}

export async function inspectProfileOwnershipLease(
  profileRoot: string,
  identity: BrowserLaunchIdentity,
  currentLeaseId: string,
  dependencyOverrides: Partial<ProfileOwnershipDependencies> = {},
): Promise<ProfileOwnershipLeaseInspection> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const leaseFile = await inspectProfileOwnershipLeaseFile(profileRoot);
  const lease = leaseFile.lease;
  if (!leaseFile.exists) {
    return {
      state: 'none',
      lease: null,
      ownershipProven: false,
      ownerWorkerRunning: null,
      heartbeat: 'unavailable',
      browserProcess: 'unavailable',
    };
  }
  if (lease === null) {
    return {
      state: 'invalid',
      lease: null,
      ownershipProven: false,
      ownerWorkerRunning: null,
      heartbeat: 'unavailable',
      browserProcess: 'unavailable',
    };
  }
  if (
    lease.browser !== identity.browser
    || lease.engine !== identity.engine
    || lease.profileFingerprint !== profilePathFingerprint(profileRoot)
  ) {
    return {
      state: 'invalid',
      lease,
      ownershipProven: false,
      ownerWorkerRunning: null,
      heartbeat: 'unavailable',
      browserProcess: 'unavailable',
    };
  }

  const workerRunning = dependencies.processRunning(lease.ownerWorkerProcessId)
    && await dependencies.processStartedAt(lease.ownerWorkerProcessId) === lease.ownerWorkerStartedAt;
  const heartbeat = dependencies.now().getTime() - Date.parse(lease.heartbeatAt) <= ACTIVE_HEARTBEAT_MS
    ? 'fresh'
    : 'stale';
  const processMatch = await browserProcessMatches(lease, identity, dependencies);
  if (lease.leaseId === currentLeaseId && workerRunning) {
    return {
      state: 'current_owner',
      lease,
      ownershipProven: processMatch === 'matched',
      ownerWorkerRunning: true,
      heartbeat,
      browserProcess: processMatch,
    };
  }
  if (workerRunning) {
    return {
      state: 'busy_other_stage5_session',
      lease,
      ownershipProven: processMatch === 'matched',
      ownerWorkerRunning: true,
      heartbeat,
      browserProcess: processMatch,
    };
  }
  if (processMatch === 'matched') {
    return {
      state: 'owned_orphaned',
      lease,
      ownershipProven: true,
      ownerWorkerRunning: false,
      heartbeat,
      browserProcess: 'matched',
    };
  }
  return {
    state: 'abandoned',
    lease,
    ownershipProven: false,
    ownerWorkerRunning: false,
    heartbeat,
    browserProcess: processMatch,
  };
}

export function descendantProcessIds(entries: ProcessTableEntry[], rootProcessId: number): Set<number> {
  const descendants = new Set<number>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of entries) {
      if (
        !descendants.has(entry.processId)
        && (entry.parentProcessId === rootProcessId || descendants.has(entry.parentProcessId))
      ) {
        descendants.add(entry.processId);
        grew = true;
      }
    }
  }
  return descendants;
}

export async function snapshotOwnedDescendants(
  ownerProcessId: number,
  dependencyOverrides: Partial<ProfileOwnershipDependencies> = {},
): Promise<Set<number>> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const entries = await dependencies.processTable();
  return entries === null ? new Set() : descendantProcessIds(entries, ownerProcessId);
}

export async function observeLaunchedBrowserProcess(
  identity: BrowserLaunchIdentity,
  baselineDescendants: ReadonlySet<number>,
  timeoutMs: number,
  dependencyOverrides: Partial<ProfileOwnershipDependencies> = {},
): Promise<OwnedProcessObservation | null> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const deadline = Date.now() + Math.max(1, timeoutMs);
  do {
    if (identity.engine === 'chromium' && identity.profile.userDataDir !== null) {
      const processId = await chromiumProfileOwnerProcessId(
        identity.profile.userDataDir,
        dependencies.processRunning,
      );
      if (processId !== null) {
        const [startedAt, executable] = await Promise.all([
          dependencies.processStartedAt(processId),
          dependencies.processExecutable(processId),
        ]);
        if (
          startedAt !== null
          && executable !== null
          && await trustedExecutableMatches(executable, identity)
        ) {
          return { processId, startedAt, executablePath: executable };
        }
      }
    }

    const entries = await dependencies.processTable();
    if (entries !== null) {
      const descendants = descendantProcessIds(entries, process.pid);
      const candidates = entries.filter((entry) =>
        descendants.has(entry.processId) && !baselineDescendants.has(entry.processId));
      const matched: Array<OwnedProcessObservation & { parentProcessId: number }> = [];
      for (const candidate of candidates) {
        if (!(await trustedExecutableMatches(candidate.executablePath, identity))) continue;
        const startedAt = await dependencies.processStartedAt(candidate.processId);
        if (startedAt !== null) matched.push({
          processId: candidate.processId,
          parentProcessId: candidate.parentProcessId,
          startedAt,
          executablePath: candidate.executablePath,
        });
      }
      const matchedProcessIds = new Set(matched.map((candidate) => candidate.processId));
      const topLevelMatched = matched.filter((candidate) => !matchedProcessIds.has(candidate.parentProcessId));
      if (topLevelMatched.length === 1) {
        const candidate = topLevelMatched[0];
        if (candidate !== undefined) {
          return {
            processId: candidate.processId,
            startedAt: candidate.startedAt,
            executablePath: candidate.executablePath,
          };
        }
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
  } while (Date.now() < deadline);
  return null;
}

export class ProfileOwnershipLeaseController {
  readonly leaseId = randomUUID();
  private active: { profileRoot: string; lease: ProfileOwnershipLease } | null = null;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly dependencies: ProfileOwnershipDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  async claim(input: {
    profileRoot: string;
    identity: BrowserLaunchIdentity;
    controlMode: ProfileOwnershipControlMode;
  }): Promise<boolean> {
    return this.enqueueMutation(() => this.claimUnserialized(input));
  }

  private async claimUnserialized(input: {
    profileRoot: string;
    identity: BrowserLaunchIdentity;
    controlMode: ProfileOwnershipControlMode;
  }): Promise<boolean> {
    const lease = await this.createLease({
      ...input,
      browserProcess: null,
      phase: 'launching',
    });
    if (!(await claimProfileOwnershipLease(input.profileRoot, lease))) return false;
    this.active = { profileRoot: input.profileRoot, lease };
    this.startHeartbeat();
    return true;
  }

  async takeOverProvenOrphan(input: {
    profileRoot: string;
    identity: BrowserLaunchIdentity;
    controlMode: ProfileOwnershipControlMode;
    inspection: ProfileOwnershipLeaseInspection;
  }): Promise<boolean> {
    return this.enqueueMutation(async () => {
      const orphan = input.inspection;
      if (
        orphan.state !== 'owned_orphaned'
        || !orphan.ownershipProven
        || orphan.browserProcess !== 'matched'
        || orphan.lease === null
      ) {
        throw new Error('Refusing to take over a browser without a conclusively proven orphaned lease.');
      }
      if (!(await removeProfileOwnershipLease(input.profileRoot, orphan.lease.leaseId))) {
        return false;
      }
      return this.claimUnserialized({
        profileRoot: input.profileRoot,
        identity: input.identity,
        controlMode: input.controlMode,
      });
    });
  }

  async establish(input: {
    profileRoot: string;
    identity: BrowserLaunchIdentity;
    browserProcess: OwnedProcessObservation | null;
    controlMode: ProfileOwnershipControlMode;
    phase: ProfileOwnershipPhase;
  }): Promise<ProfileOwnershipLease> {
    return this.enqueueMutation(async () => {
      const existing = await readProfileOwnershipLease(input.profileRoot);
      const lease = await this.createLease(input, existing?.leaseId === this.leaseId ? existing.createdAt : undefined);
      await writeProfileOwnershipLease(input.profileRoot, lease);
      this.active = { profileRoot: input.profileRoot, lease };
      this.startHeartbeat();
      return lease;
    });
  }

  private async createLease(input: {
    profileRoot: string;
    identity: BrowserLaunchIdentity;
    browserProcess: OwnedProcessObservation | null;
    controlMode: ProfileOwnershipControlMode;
    phase: ProfileOwnershipPhase;
  }, createdAtOverride?: string): Promise<ProfileOwnershipLease> {
    const now = this.dependencies.now().toISOString();
    const workerStartedAt = await this.dependencies.processStartedAt(process.pid);
    if (workerStartedAt === null) {
      throw new Error('Could not record the Stage5 worker process start identity.');
    }
    const browserExecutableFingerprint = input.browserProcess === null
      ? null
      : await executableFingerprint(input.browserProcess.executablePath);
    if (input.browserProcess !== null && browserExecutableFingerprint === null) {
      throw new Error('Could not record the owned browser executable identity.');
    }
    return {
      version: 1,
      leaseId: this.leaseId,
      browser: input.identity.browser,
      engine: input.identity.engine,
      profileFingerprint: profilePathFingerprint(input.profileRoot),
      ownerWorkerProcessId: process.pid,
      ownerWorkerStartedAt: workerStartedAt,
      browserProcessId: input.browserProcess?.processId ?? null,
      browserProcessStartedAt: input.browserProcess?.startedAt ?? null,
      browserExecutableFingerprint,
      controlMode: input.controlMode,
      phase: input.phase,
      createdAt: createdAtOverride ?? now,
      heartbeatAt: now,
    };
  }

  async updatePhase(phase: ProfileOwnershipPhase): Promise<void> {
    await this.enqueueMutation(async () => {
      if (this.active === null) return;
      const current = await readProfileOwnershipLease(this.active.profileRoot);
      if (current?.leaseId !== this.leaseId) {
        this.stopHeartbeat();
        this.active = null;
        return;
      }
      const lease = { ...current, phase, heartbeatAt: this.dependencies.now().toISOString() };
      await writeProfileOwnershipLease(this.active.profileRoot, lease);
      this.active = { profileRoot: this.active.profileRoot, lease };
    });
  }

  async release(): Promise<void> {
    this.stopHeartbeat();
    await this.enqueueMutation(async () => {
      if (this.active === null) return;
      await removeProfileOwnershipLease(this.active.profileRoot, this.leaseId);
      this.active = null;
    });
  }

  async detach(): Promise<void> {
    this.stopHeartbeat();
    await this.enqueueMutation(async () => {
      this.active = null;
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.enqueueMutation(() => this.heartbeat()).catch(() => undefined);
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private async heartbeat(): Promise<void> {
    if (this.active === null) return;
    const current = await readProfileOwnershipLease(this.active.profileRoot);
    if (current?.leaseId !== this.leaseId) {
      this.stopHeartbeat();
      this.active = null;
      return;
    }
    const lease = { ...current, heartbeatAt: this.dependencies.now().toISOString() };
    await writeProfileOwnershipLease(this.active.profileRoot, lease).catch(() => undefined);
    if (this.active !== null) {
      this.active = { profileRoot: this.active.profileRoot, lease };
    }
  }

  private enqueueMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export async function terminateProvenOrphan(
  inspection: ProfileOwnershipLeaseInspection,
  timeoutMs: number,
  dependencyOverrides: Partial<ProfileOwnershipDependencies> = {},
): Promise<'process_exited' | 'still_running'> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  if (
    inspection.state !== 'owned_orphaned'
    || !inspection.ownershipProven
    || inspection.browserProcess !== 'matched'
    || inspection.lease?.browserProcessId === null
    || inspection.lease?.browserProcessId === undefined
  ) {
    throw new Error('Refusing to terminate a browser without a conclusively proven orphaned lease.');
  }
  const processId = inspection.lease.browserProcessId;
  dependencies.signalProcess(processId, 'SIGTERM');
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (dependencies.processRunning(processId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
  }
  return dependencies.processRunning(processId) ? 'still_running' : 'process_exited';
}

export async function ownershipProfileUnlocked(profileRoot: string): Promise<boolean> {
  return (await profileLocks(profileRoot)).length === 0;
}
