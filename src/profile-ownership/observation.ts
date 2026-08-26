import { chromiumProfileOwnerProcessId } from '../native-window-activation.js';
import { profileLocks } from '../human-auth-bootstrap.js';
import type { BrowserLaunchIdentity } from '../profile-binding.js';
import { DEFAULT_DEPENDENCIES, trustedExecutableMatches } from './process.js';
import type { OwnedProcessObservation, ProcessTableEntry, ProfileOwnershipDependencies, ProfileOwnershipLeaseInspection } from './types.js';

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
