import {
  type BrowserLaunchIdentity,
  inspectProfileOwnershipLease,
  inspectProfileShutdown,
  type NativeControlRecord,
  type OwnedProcessObservation,
  processIsRunning,
  processStartedAtToken,
  type ProfileOwnershipLeaseInspection,
  type ProfileStorageInspection,
  readNativeControlRecord,
  resolveBrowserLaunchTarget,
  restoreNativeHumanBrowserSession,
  launchIdentityForTarget,
  profileDirForBrowser,
  Stage5BrowserError,
} from '../dependencies.js';
import type { AuthenticationHandoff } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

function sameControlRecord(
  left: NativeControlRecord | null,
  right: NativeControlRecord,
): left is NativeControlRecord {
  return left !== null
    && left.state === 'awaiting_user'
    && left.browser === right.browser
    && left.processId === right.processId
    && left.port === right.port
    && left.createdAt === right.createdAt;
}

function unavailableStorage(targetOrigin: string | null): ProfileStorageInspection {
  return {
    observedAt: new Date().toISOString(),
    targetOrigin,
    cookieDatabase: {
      supported: false,
      databaseKind: 'missing',
      relativePath: null,
      exists: false,
      modifiedAt: null,
      journalModifiedAt: null,
      locations: [],
      targetOriginCookiePresent: null,
      sessionCookiePresent: null,
      persistentCookiePresent: null,
      inspection: 'unsupported',
    },
    keyTokens: null,
  };
}

function leasePermitsReadOnlyRestore(inspection: ProfileOwnershipLeaseInspection): boolean {
  if (inspection.lease?.controlMode !== 'human_handoff') return false;
  if (inspection.state === 'current_owner') {
    return inspection.ownershipProven || inspection.lease.phase === 'launching';
  }
  if (inspection.state === 'owned_orphaned') {
    return inspection.ownershipProven && inspection.browserProcess === 'matched';
  }
  return inspection.state === 'abandoned' && inspection.ownerWorkerRunning === false;
}

function leaseProvesControlRecord(
  inspection: ProfileOwnershipLeaseInspection,
  record: NativeControlRecord,
): boolean {
  return inspection.lease?.controlMode === 'human_handoff'
    && (inspection.state === 'current_owner' || inspection.state === 'owned_orphaned')
    && inspection.ownershipProven
    && inspection.browserProcess === 'matched'
    && inspection.lease.browserProcessId === record.processId;
}

function leaseProvesNativeHandoffTransition(
  inspection: ProfileOwnershipLeaseInspection,
  record: NativeControlRecord,
): boolean {
  return inspection.lease?.controlMode === 'native_cdp'
    && inspection.lease.phase === 'close_requested'
    && (inspection.state === 'current_owner' || inspection.state === 'owned_orphaned')
    && inspection.ownershipProven
    && inspection.browserProcess === 'matched'
    && inspection.lease.browserProcessId === record.processId;
}

function durableHandoffUnavailable(reason: string): Stage5BrowserError {
  return new Stage5BrowserError(
    'AUTH_HANDOFF_REQUIRED',
    'The durable private handoff could not be bound to this worker without weakening process ownership.',
    {
      recoverable: true,
      details: {
        reason,
        actionDispatched: false,
        suggestedAction: 'Leave the exact dedicated browser open. Call browser_auth_status once and report the sanitized ownership evidence; do not request another handoff, attach to another process, close the browser, or delete locks.',
      },
    },
  );
}

export const handoffDurableOperations = {
  async restoreDurableAuthenticationHandoff(): Promise<boolean> {
    if (this.authenticationHandoff !== null) return true;
    if (
      this.pendingHandoffRelease !== null
      || this.privateFieldHandoff !== null
      || this.usableContext() !== undefined
    ) return false;

    try {
      const target = await resolveBrowserLaunchTarget(this.selectionFor(this.selectedBrowser));
      if (target.engine !== 'chromium') return false;
      const profileDir = profileDirForBrowser(this.config, this.selectedBrowser);
      const identity = launchIdentityForTarget(target, profileDir);
      const record = await readNativeControlRecord(profileDir, this.selectedBrowser);
      if (record?.state !== 'awaiting_user' || !processIsRunning(record.processId)) return false;

      const lease = await inspectProfileOwnershipLease(
        profileDir,
        identity,
        this.ownershipLease.leaseId,
      );
      const nativeTransition = leaseProvesNativeHandoffTransition(lease, record);
      if (!leasePermitsReadOnlyRestore(lease) && !nativeTransition) {
        return false;
      }
      if (!leaseProvesControlRecord(lease, record) || nativeTransition) {
        const owner = await this.profileOwnerInspector(profileDir, identity);
        if (!sameControlRecord(owner.handoffRecord, record)) return false;
      }

      this.authenticationHandoff = {
        mode: 'human_bootstrap',
        state: 'awaiting_user',
        targetOrigin: null,
        requestedAt: record.createdAt,
        resumedAt: null,
        page: null,
        profileDir,
        launchIdentity: identity,
        handoffLabel: `Recovered Stage5 ${identity.browser} private handoff`,
        targetUrl: 'about:blank',
        beforeUrl: null,
        beforeSemanticFingerprint: null,
        beforeStorage: unavailableStorage(null),
        beforeProfileShutdown: await inspectProfileShutdown(
          profileDir,
          this.selectedBrowser,
          identity.profile.profileDirectory,
        ),
        session: restoreNativeHumanBrowserSession(record, identity),
        profileShutdown: null,
        shutdownOverrideOffered: false,
        releaseStrategy: 'native_same_process',
        releaseCloseRequestCompleted: true,
      };
      this.controlledLaunchIdentity = identity;
      this.state = 'stopped';
      return true;
    } catch {
      return false;
    }
  },

  async ensureDurableAuthenticationHandoffOwnership(
    handoff: AuthenticationHandoff,
    record: NativeControlRecord,
  ): Promise<void> {
    const startedAt = await processStartedAtToken(record.processId);
    if (startedAt === null || !processIsRunning(record.processId)) {
      throw durableHandoffUnavailable('native_handoff_process_unavailable');
    }
    const browserProcess: OwnedProcessObservation = {
      processId: record.processId,
      startedAt,
      executablePath: handoff.launchIdentity.executablePath,
    };
    const inspection = await inspectProfileOwnershipLease(
      handoff.profileDir,
      handoff.launchIdentity,
      this.ownershipLease.leaseId,
    );
    if (leaseProvesNativeHandoffTransition(inspection, record)) {
      const owner = await this.profileOwnerInspector(handoff.profileDir, handoff.launchIdentity);
      if (!sameControlRecord(owner.handoffRecord, record)) {
        throw durableHandoffUnavailable('native_handoff_transition_unverified');
      }
      if (inspection.state === 'current_owner') {
        await this.ownershipLease.establish({
          profileRoot: handoff.profileDir,
          identity: handoff.launchIdentity,
          browserProcess,
          controlMode: 'human_handoff',
          phase: 'human_input',
        });
        return;
      }
      const adopted = await this.ownershipLease.adoptVerifiedNativeHandoffTransition({
        profileRoot: handoff.profileDir,
        identity: handoff.launchIdentity,
        browserProcess,
        inspection,
      });
      if (!adopted) throw durableHandoffUnavailable('native_handoff_lease_changed');
      return;
    }
    if (inspection.lease?.controlMode !== 'human_handoff') {
      throw durableHandoffUnavailable('native_handoff_lease_mismatch');
    }

    if (inspection.state === 'current_owner') {
      if (!leaseProvesControlRecord(inspection, record)) {
        const owner = await this.profileOwnerInspector(handoff.profileDir, handoff.launchIdentity);
        if (!sameControlRecord(owner.handoffRecord, record)) {
          throw durableHandoffUnavailable('native_handoff_identity_unverified');
        }
      }
      await this.ownershipLease.establish({
        profileRoot: handoff.profileDir,
        identity: handoff.launchIdentity,
        browserProcess,
        controlMode: 'human_handoff',
        phase: 'human_input',
      });
      return;
    }
    if (
      inspection.state !== 'owned_orphaned'
      && inspection.state !== 'abandoned'
    ) {
      throw durableHandoffUnavailable('native_handoff_lease_busy');
    }
    if (!leaseProvesControlRecord(inspection, record)) {
      const owner = await this.profileOwnerInspector(handoff.profileDir, handoff.launchIdentity);
      if (!sameControlRecord(owner.handoffRecord, record)) {
        throw durableHandoffUnavailable('native_handoff_identity_unverified');
      }
    }
    const adopted = await this.ownershipLease.adoptVerifiedHumanHandoff({
      profileRoot: handoff.profileDir,
      identity: handoff.launchIdentity,
      browserProcess,
      inspection,
    });
    if (!adopted) {
      throw durableHandoffUnavailable('native_handoff_lease_changed');
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type HandoffDurableOperations = typeof handoffDurableOperations;
