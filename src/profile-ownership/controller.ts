import { randomUUID } from 'node:crypto';

import type { BrowserLaunchIdentity } from '../profile-binding.js';
import { DEFAULT_DEPENDENCIES, executableFingerprint, trustedExecutableMatches } from './process.js';
import { claimProfileOwnershipLease, profilePathFingerprint, readProfileOwnershipLease, removeProfileOwnershipLease, writeProfileOwnershipLease } from './store.js';
import type { OwnedProcessObservation, ProfileOwnershipControlMode, ProfileOwnershipDependencies, ProfileOwnershipLease, ProfileOwnershipLeaseInspection, ProfileOwnershipPhase } from './types.js';

const HEARTBEAT_INTERVAL_MS = 1_000;

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

  async adoptVerifiedHumanHandoff(input: {
    profileRoot: string;
    identity: BrowserLaunchIdentity;
    browserProcess: OwnedProcessObservation;
    inspection: ProfileOwnershipLeaseInspection;
  }): Promise<boolean> {
    return this.enqueueMutation(async () => {
      const prior = input.inspection;
      if (
        (prior.state !== 'abandoned' && prior.state !== 'owned_orphaned')
        || prior.ownerWorkerRunning !== false
        || prior.lease?.controlMode !== 'human_handoff'
      ) {
        throw new Error('Refusing to adopt a human handoff that is not owned by an exited Stage5 worker.');
      }
      const [startedAt, executable] = await Promise.all([
        this.dependencies.processStartedAt(input.browserProcess.processId),
        this.dependencies.processExecutable(input.browserProcess.processId),
      ]);
      if (
        !this.dependencies.processRunning(input.browserProcess.processId)
        || startedAt !== input.browserProcess.startedAt
        || executable === null
        || !(await trustedExecutableMatches(executable, input.identity))
      ) {
        throw new Error('Refusing to adopt a human handoff without an exact live browser-process identity.');
      }

      const lease = await this.createLease({
        profileRoot: input.profileRoot,
        identity: input.identity,
        browserProcess: input.browserProcess,
        controlMode: 'human_handoff',
        phase: 'human_input',
      });
      if (!(await removeProfileOwnershipLease(input.profileRoot, prior.lease.leaseId))) {
        return false;
      }
      if (!(await claimProfileOwnershipLease(input.profileRoot, lease))) {
        return false;
      }
      this.active = { profileRoot: input.profileRoot, lease };
      this.startHeartbeat();
      return true;
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
