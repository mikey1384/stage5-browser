import { type Browser, BROWSER_ENGINES, type BrowserLaunchIdentity, type ChromiumProfileOwnerInspection, controlledProfileOwnerEvidence, emptyProfileOwnerEvidence, inspectProfileOwnershipLease, launchIdentityForTarget, ownershipProfileUnlocked, path, type ProfileDiagnostics, type ProfileOwnerEvidence, type ProfileOwnershipLeaseInspection, proveExitedPlaywrightSingleton, removeProfileOwnershipLease, resolveBrowserLaunchTarget, Stage5BrowserError, terminateProvenOrphan, waitForProfileUnlock } from '../dependencies.js';
import type { BrowserControllerContext } from '../runtime.js';

export const lifecycleOwnershipOperations = {
  lockedProfileOwnerError(
    inspection: ChromiumProfileOwnerInspection,
  ): Stage5BrowserError {
    const authenticationHandoffPending =
      inspection.evidence.classification === 'authentication_handoff_pending';
    return new Stage5BrowserError(
      authenticationHandoffPending ? 'AUTH_HANDOFF_REQUIRED' : 'BROWSER_NOT_READY',
      authenticationHandoffPending
        ? 'The dedicated Chromium profile appears to be in a private authentication handoff.'
        : 'The dedicated Chromium profile is locked and Stage5 Browser cannot safely reattach to its owner.',
      {
        recoverable: true,
        details: {
          reason: 'profile_locked',
          ownershipReason: inspection.evidence.classification,
          profileOwner: inspection.evidence,
          suggestedAction: inspection.evidence.suggestedAction,
        },
      },
    );
  },

  safeLeaseEvidence(
    inspection: ProfileOwnershipLeaseInspection,
    applicationName: string,
  ): Record<string, unknown> {
    return {
      classification: inspection.state,
      ownershipProven: inspection.ownershipProven,
      expectedApplication: applicationName,
      ownerWorkerRunning: inspection.ownerWorkerRunning,
      heartbeat: inspection.heartbeat,
      browserProcess: inspection.browserProcess,
      controlMode: inspection.lease?.controlMode ?? null,
      phase: inspection.lease?.phase ?? null,
    };
  },

  leaseSuggestedAction(
    inspection: ProfileOwnershipLeaseInspection,
    applicationName: string,
  ): string {
    if (inspection.state === 'busy_other_stage5_session') {
      return `Another live Stage5 worker owns the dedicated ${applicationName} profile. Continue in that agent session or ask it to call browser_stop; do not retry, terminate the browser, or delete locks.`;
    }
    if (inspection.state === 'owned_orphaned' && inspection.lease?.controlMode === 'human_handoff') {
      return `A private interaction handoff owns the dedicated ${applicationName}. Call browser_auth_status so Stage5 can verify and recover the durable handoff, then call browser_resume_after_login once after the private step. Do not attach manually, terminate, or delete locks.`;
    }
    if (inspection.state === 'invalid') {
      return `Stage5 found an invalid ownership record for the dedicated ${applicationName} profile. Do not overwrite it, delete browser locks, or kill a process; stop and inspect the profile ownership record before retrying.`;
    }
    return `Do not delete profile locks or kill an unverified process. Close only the visibly identified dedicated ${applicationName} normally, wait for it to exit, then call browser_start once.`;
  },

  ownershipLeaseError(
    inspection: ProfileOwnershipLeaseInspection,
    identity: BrowserLaunchIdentity,
  ): Stage5BrowserError {
    const handoffPending = inspection.state === 'owned_orphaned'
      && inspection.lease?.controlMode === 'human_handoff';
    const suggestedAction = this.leaseSuggestedAction(inspection, identity.applicationName);
    return new Stage5BrowserError(
      handoffPending ? 'AUTH_HANDOFF_REQUIRED' : 'BROWSER_NOT_READY',
      inspection.state === 'busy_other_stage5_session'
        ? 'The dedicated browser profile is busy in another live Stage5 session.'
        : handoffPending
          ? 'A private interaction handoff survived its Stage5 worker and must not be taken over automatically.'
          : 'The dedicated browser profile ownership state cannot be recovered automatically.',
      {
        recoverable: true,
        details: {
          reason: 'profile_locked',
          ownershipReason: inspection.state,
          profileOwner: this.safeLeaseEvidence(inspection, identity.applicationName),
          suggestedAction,
        },
      },
    );
  },

  async prepareOwnershipLeaseForStart(
    profileRoot: string,
    identity: BrowserLaunchIdentity,
    resumeOwnedHumanHandoff = false,
  ): Promise<ProfileOwnershipLeaseInspection | null> {
    const inspection = await inspectProfileOwnershipLease(
      profileRoot,
      identity,
      this.ownershipLease.leaseId,
    );
    if (inspection.state === 'none') return null;
    if (inspection.state === 'busy_other_stage5_session' || inspection.state === 'invalid') {
      throw this.ownershipLeaseError(inspection, identity);
    }
    if (inspection.state === 'current_owner') {
      if (
        inspection.lease?.controlMode === 'native_cdp'
        && (inspection.ownershipProven || inspection.lease.phase === 'launching')
      ) return null;
      if (
        inspection.ownershipProven
        && resumeOwnedHumanHandoff
        && inspection.lease?.controlMode === 'human_handoff'
      ) return null;
      throw this.ownershipLeaseError(inspection, identity);
    }
    if (inspection.state === 'owned_orphaned') {
      if (inspection.lease?.controlMode === 'native_cdp') {
        const claimed = await this.ownershipLease.takeOverProvenOrphan({
          profileRoot,
          identity,
          controlMode: 'native_cdp',
          inspection,
        });
        if (!claimed) {
          const competingLease = await inspectProfileOwnershipLease(
            profileRoot,
            identity,
            this.ownershipLease.leaseId,
          );
          throw this.ownershipLeaseError(competingLease, identity);
        }
        return null;
      }
      if (inspection.lease?.controlMode === 'human_handoff') {
        throw this.ownershipLeaseError(inspection, identity);
      }
      const terminated = await terminateProvenOrphan(
        inspection,
        Math.min(this.config.readinessTimeoutMs, 2_000),
      );
      const unlocked = terminated === 'process_exited'
        && await waitForProfileUnlock(profileRoot, Math.min(this.config.readinessTimeoutMs, 2_000));
      if (!unlocked) {
        throw this.ownershipLeaseError(inspection, identity);
      }
      if (inspection.lease !== null) {
        await removeProfileOwnershipLease(profileRoot, inspection.lease.leaseId);
      }
      return null;
    }
    if (inspection.state === 'abandoned' && await ownershipProfileUnlocked(profileRoot)) {
      if (inspection.lease !== null) {
        await removeProfileOwnershipLease(profileRoot, inspection.lease.leaseId);
      }
      return null;
    }
    if (
      inspection.state === 'abandoned'
      && inspection.ownerWorkerRunning === false
      && inspection.browserProcess === 'not_running'
      && inspection.lease?.controlMode === 'playwright'
      && inspection.lease.phase === 'process_exited'
    ) {
      return inspection;
    }
    throw this.ownershipLeaseError(inspection, identity);
  },

  async claimNativeControlLeaseIfNeeded(
    profileRoot: string,
    identity: BrowserLaunchIdentity,
    resumeOwnedHumanHandoff = false,
  ): Promise<void> {
    const inspection = await inspectProfileOwnershipLease(
      profileRoot,
      identity,
      this.ownershipLease.leaseId,
    );
    if (
      inspection.state === 'current_owner'
      && inspection.lease?.controlMode === 'native_cdp'
      && (inspection.ownershipProven || inspection.lease.phase === 'launching')
    ) {
      return;
    }
    if (
      resumeOwnedHumanHandoff
      && inspection.state === 'current_owner'
      && inspection.ownershipProven
      && inspection.lease?.controlMode === 'human_handoff'
    ) {
      return;
    }
    if (inspection.state !== 'none') {
      throw this.ownershipLeaseError(inspection, identity);
    }
    const claimed = await this.ownershipLease.claim({
      profileRoot,
      identity,
      controlMode: 'native_cdp',
    });
    if (claimed) return;
    const competingLease = await inspectProfileOwnershipLease(
      profileRoot,
      identity,
      this.ownershipLease.leaseId,
    );
    throw this.ownershipLeaseError(competingLease, identity);
  },

  async profileOwnerEvidence(
    profile: ProfileDiagnostics,
    launchIdentity: BrowserLaunchIdentity | null,
    humanBootstrapRunning: boolean,
  ): Promise<ProfileOwnerEvidence> {
    let identity = launchIdentity;
    if (identity === null) {
      try {
        const target = await resolveBrowserLaunchTarget(this.selectionFor(this.selectedBrowser));
        identity = launchIdentityForTarget(target, profile.path);
      } catch {
        if (profile.lockFiles.length === 0) return emptyProfileOwnerEvidence();
        return {
          classification: 'unknown_lock_owner',
          ownership: 'not_proven',
          lockOwnerProcess: 'not_running_or_unreadable',
          expectedApplication: null,
          applicationIdentity: 'unverified',
          loopbackControl: 'unverified',
          authenticationHandoff: 'unverified',
          recovery: 'do_not_modify_locks',
          suggestedAction: 'Do not retry, delete profile locks, or kill an unknown owner. Resolve the selected browser executable first, then run browser_diagnostics again.',
        };
      }
    }
    const leaseInspection = await inspectProfileOwnershipLease(
      profile.path,
      identity,
      this.ownershipLease.leaseId,
    );
    if (leaseInspection.state !== 'none') {
      const controlMode = leaseInspection.lease?.controlMode ?? null;
      const humanHandoff = controlMode === 'human_handoff';
      const durableHandoffRecovered = humanHandoff
        && this.authenticationHandoff?.state === 'awaiting_user'
        && this.authenticationHandoff.profileDir === profile.path;
      if (durableHandoffRecovered) {
        return {
          ...controlledProfileOwnerEvidence(identity.applicationName, true),
          lease: {
            state: leaseInspection.state,
            ownerWorkerRunning: leaseInspection.ownerWorkerRunning,
            heartbeat: leaseInspection.heartbeat,
            browserProcess: leaseInspection.browserProcess,
            controlMode,
            phase: leaseInspection.lease?.phase ?? null,
          },
        };
      }
      const exitedPlaywrightSingleton = await proveExitedPlaywrightSingleton(
        profile.path,
        identity,
        leaseInspection,
      ) !== null;
      const classification = leaseInspection.state === 'current_owner'
        ? humanHandoff ? 'authentication_handoff_pending' : 'owned_active'
        : leaseInspection.state === 'busy_other_stage5_session'
          ? 'busy_other_stage5_session'
          : leaseInspection.state === 'owned_orphaned'
            ? 'owned_orphaned'
            : exitedPlaywrightSingleton
              ? 'owned_orphaned'
              : 'external_owner';
      const recovery = leaseInspection.state === 'owned_orphaned'
        ? humanHandoff
          ? 'return_to_authentication_handoff'
          : controlMode === 'native_cdp'
            ? 'automatic_reattach'
            : 'automatic_owned_restart'
        : exitedPlaywrightSingleton
          ? 'automatic_owned_restart'
        : leaseInspection.state === 'current_owner' && !humanHandoff
          ? 'none'
          : 'do_not_modify_locks';
      return {
        classification,
        ownership: leaseInspection.ownershipProven || exitedPlaywrightSingleton
          ? 'proven'
          : 'not_proven',
        lockOwnerProcess: leaseInspection.browserProcess === 'matched'
          ? 'running'
          : leaseInspection.browserProcess === 'not_running'
            ? 'not_running_or_unreadable'
            : 'not_running_or_unreadable',
        expectedApplication: identity.applicationName,
        applicationIdentity: leaseInspection.browserProcess === 'matched'
          ? 'matched'
          : exitedPlaywrightSingleton
            ? 'matched'
          : leaseInspection.browserProcess === 'mismatched'
            ? 'mismatched'
            : 'unverified',
        loopbackControl: controlMode === 'native_cdp' ? 'available' : 'unverified',
        authenticationHandoff: humanHandoff ? 'present' : 'absent',
        recovery,
        suggestedAction: exitedPlaywrightSingleton
          ? 'Call browser_start once. Stage5 will remove only the revalidated singleton entries bound to its exact proven exited process, then launch the intended profile.'
          : leaseInspection.state === 'owned_orphaned' && !humanHandoff
          ? controlMode === 'native_cdp'
            ? 'Call browser_start once; Stage5 will verify and reattach to the exact orphaned native process automatically. Do not close the browser or delete locks.'
            : 'Call browser_start once; Stage5 will terminate only the exact fingerprint-matched orphan, wait for profile unlock, and relaunch it. Do not close the browser or delete locks manually.'
          : this.leaseSuggestedAction(leaseInspection, identity.applicationName),
        lease: {
          state: leaseInspection.state,
          ownerWorkerRunning: leaseInspection.ownerWorkerRunning,
          heartbeat: leaseInspection.heartbeat,
          browserProcess: leaseInspection.browserProcess,
          controlMode,
          phase: leaseInspection.lease?.phase ?? null,
        },
      };
    }
    if (profile.lockFiles.length === 0) {
      return emptyProfileOwnerEvidence();
    }
    if (humanBootstrapRunning) {
      return controlledProfileOwnerEvidence(identity.applicationName, true);
    }
    if (this.usableContext() !== undefined) {
      return controlledProfileOwnerEvidence(identity.applicationName);
    }
    if (BROWSER_ENGINES[this.selectedBrowser] !== 'chromium') {
      return {
        classification: 'external_owner',
        ownership: 'not_proven',
        lockOwnerProcess: 'not_running_or_unreadable',
        expectedApplication: identity.applicationName,
        applicationIdentity: 'unverified',
        loopbackControl: 'unverified',
        authenticationHandoff: 'unverified',
        recovery: 'do_not_modify_locks',
        suggestedAction: 'Do not delete profile locks or force-close an unknown process. Ask the user to close only the visibly identified dedicated Stage5 browser normally, wait for it to exit, then call browser_start once.',
      };
    }
    return (await this.profileOwnerInspector(profile.path, identity)).evidence;
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type LifecycleOwnershipOperations = typeof lifecycleOwnershipOperations;
