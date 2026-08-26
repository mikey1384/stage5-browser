import type { BrowserLaunchIdentity } from '../profile-binding.js';
import { profileLocks } from '../human-auth-bootstrap.js';
import { chromiumProfileOwnerProcessId } from '../native-window-activation.js';
import { DEFAULT_DEPENDENCIES, executableFingerprint, trustedExecutableMatches } from './process.js';
import { inspectProfileOwnershipLeaseFile, profilePathFingerprint } from './store.js';
import type { ProfileOwnershipDependencies, ProfileOwnershipLease, ProfileOwnershipLeaseInspection } from './types.js';

const ACTIVE_HEARTBEAT_MS = 5_000;

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
