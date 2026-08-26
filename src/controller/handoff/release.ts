import { type BrowserCommandOutput, type HumanBrowserSession, inspectProfile, inspectProfileOwnershipLease, inspectProfileShutdown, launchFailureDiagnostic, type OwnedProcessObservation, ownershipProfileUnlocked, processIsRunning, processStartedAtToken, type Request, sameLaunchIdentity, Stage5BrowserError, waitForProfileUnlock } from '../dependencies.js';
import { boundedValue, type PendingHandoffRelease, remainingHandoffWorkBudget } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const handoffReleaseOperations = {
  async continuePendingHandoffRelease(
    deadlineAt: number,
  ): Promise<BrowserCommandOutput<'requestLoginHandoff'>> {
    const pending = this.pendingHandoffRelease;
    if (pending === null) {
      throw new Stage5BrowserError('AUTH_HANDOFF_REQUIRED', 'No private handoff release is pending.', {
        recoverable: true,
        details: {
          reason: 'no_pending_handoff',
          suggestedAction: 'Request the private interaction handoff from the exact page that needs user input.',
        },
      });
    }

    const processBudgetMs = remainingHandoffWorkBudget(deadlineAt);
    const processExited = processBudgetMs > 0 && await this.waitForExactOwnedProcessExit(
      pending.controlledBrowserProcess,
      processBudgetMs,
    );
    if (!processExited) {
      const profile = await inspectProfile(pending.profileDir, false);
      throw this.handoffReleasePendingError('close_requested', profile.lockFiles, pending);
    }
    await this.ownershipLease.updatePhase('process_exited');

    const unlockBudgetMs = remainingHandoffWorkBudget(deadlineAt);
    let profileUnlocked = unlockBudgetMs > 0
      && await waitForProfileUnlock(pending.profileDir, unlockBudgetMs);
    if (!profileUnlocked) {
      const profile = await inspectProfile(pending.profileDir, false);
      profileUnlocked = profile.lockFiles.length === 0;
      if (!profileUnlocked) {
        throw this.handoffReleasePendingError('process_exited', profile.lockFiles, pending);
      }
    }
    await this.ownershipLease.updatePhase('profile_unlocked');

    if (remainingHandoffWorkBudget(deadlineAt) === 0) {
      throw this.handoffReleasePendingError('profile_unlocked', [], pending);
    }
    const [beforeStorage, beforeProfileShutdown] = await Promise.all([
      this.profileStorageInspector(
        pending.launchIdentity.profile,
        pending.launchIdentity.engine,
        pending.targetOrigin,
      ),
      inspectProfileShutdown(
        pending.profileDir,
        this.selectedBrowser,
        pending.launchIdentity.profile.profileDirectory,
      ),
    ]);
    await this.ownershipLease.release();

    const humanLeaseClaimed = await this.ownershipLease.claim({
      profileRoot: pending.profileDir,
      identity: pending.launchIdentity,
      controlMode: 'human_handoff',
    });
    if (!humanLeaseClaimed) {
      const competingLease = await inspectProfileOwnershipLease(
        pending.profileDir,
        pending.launchIdentity,
        this.ownershipLease.leaseId,
      );
      throw this.ownershipLeaseError(competingLease, pending.launchIdentity);
    }

    let session: HumanBrowserSession;
    try {
      session = await this.humanBrowserLauncher.launch({
        target: pending.launchTarget,
        profileDir: pending.profileDir,
        handoffLabel: pending.handoffLabel,
        url: pending.targetUrl,
      });
    } catch (error) {
      if (await ownershipProfileUnlocked(pending.profileDir)) {
        await this.ownershipLease.updatePhase('profile_unlocked').catch(() => undefined);
        await this.ownershipLease.release().catch(() => undefined);
      }
      this.state = 'failed';
      const diagnostic = launchFailureDiagnostic(this.selectedBrowser, error);
      this.lastLaunchFailure = diagnostic;
      throw new Stage5BrowserError(
        'BROWSER_NOT_READY',
        'The private human-interaction browser could not be launched.',
        {
          recoverable: true,
          details: {
            browser: diagnostic.browser,
            engine: diagnostic.engine,
            reason: diagnostic.reason,
            occurredAt: diagnostic.occurredAt,
            suggestedAction: diagnostic.suggestedAction,
          },
          cause: error,
        },
      );
    }

    const humanLaunchIdentity = session.identity();
    const humanProcessState = session.state();
    const humanProcessStartedAt = humanProcessState.processId === null
      ? null
      : await processStartedAtToken(humanProcessState.processId);
    if (humanProcessState.processId === null || humanProcessStartedAt === null) {
      throw new Stage5BrowserError(
        'BROWSER_NOT_READY',
        'The private browser launched, but Stage5 could not establish its exact durable ownership identity.',
        {
          recoverable: true,
          details: {
            reason: 'ownership_unverified',
            suggestedAction: `Do not enter private information. Close only the newly opened ${humanLaunchIdentity.applicationName} normally, wait for it to exit, then request the handoff once.`,
          },
        },
      );
    }
    await this.ownershipLease.establish({
      profileRoot: pending.profileDir,
      identity: humanLaunchIdentity,
      browserProcess: {
        processId: humanProcessState.processId,
        startedAt: humanProcessStartedAt,
        executablePath: humanLaunchIdentity.executablePath,
      },
      controlMode: 'human_handoff',
      phase: 'human_input',
    });

    this.authenticationHandoff = {
      mode: 'human_bootstrap',
      state: 'awaiting_user',
      targetOrigin: pending.targetOrigin,
      requestedAt: pending.requestedAt,
      resumedAt: null,
      page: null,
      profileDir: pending.profileDir,
      launchIdentity: humanLaunchIdentity,
      handoffLabel: pending.handoffLabel,
      targetUrl: pending.targetUrl,
      beforeUrl: pending.beforeUrl,
      beforeSemanticFingerprint: pending.beforeSemanticFingerprint,
      beforeStorage,
      beforeProfileShutdown,
      session,
      profileShutdown: null,
      shutdownOverrideOffered: false,
    };
    this.pendingHandoffRelease = null;
    this.state = 'stopped';

    if (!sameLaunchIdentity(pending.launchIdentity, humanLaunchIdentity)) {
      throw new Stage5BrowserError(
        'AUTH_NOT_PERSISTED',
        'The native private-interaction browser did not launch with the controlled browser identity.',
        {
          recoverable: true,
          details: {
            reason: 'auth_launch_identity_mismatch',
            controlledIdentity: pending.launchIdentity,
            humanIdentity: humanLaunchIdentity,
            suggestedAction: 'Do not enter private information. Quit only the newly opened browser normally and correct the configured backend before requesting another handoff.',
          },
        },
      );
    }

    const continuousAttachment = session.controlChannel?.()?.kind === 'chromium_cdp';
    return {
      ...(await this.authenticationStatus(undefined)),
      userActionRequired: true,
      instructions: continuousAttachment
        ? `Use only the newly opened ${humanLaunchIdentity.applicationName} window identified as “${pending.handoffLabel}”. It uses the Stage5 ${humanLaunchIdentity.browser} profile partition “${humanLaunchIdentity.profile.profileDirectory ?? 'profile root'}” for ${pending.targetOrigin ?? 'the requested page'}. Complete only the private step yourself—such as a password, passkey, OTP, EIN, identity document, or selfie—then leave that exact browser application open and tell the agent to call browser_resume_after_login. Never send private values or documents to the agent.`
        : `Use only the newly opened ${humanLaunchIdentity.applicationName} window identified as “${pending.handoffLabel}”. It uses the Stage5 ${humanLaunchIdentity.browser} profile partition “${humanLaunchIdentity.profile.profileDirectory ?? 'profile root'}” for ${pending.targetOrigin ?? 'the requested page'}. Complete only the private step yourself—such as a password, passkey, OTP, EIN, identity document, or selfie—then quit ${humanLaunchIdentity.applicationName} normally so its process exits. On macOS, use Cmd-Q in that exact application; closing only a tab or window may leave it running. Never send private values or documents to the agent. After it exits, tell the agent to call browser_resume_after_login.`,
    };
  },

  async waitForExactOwnedProcessExit(
    processObservation: OwnedProcessObservation,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadlineAt = Date.now() + Math.max(1, timeoutMs);
    do {
      if (!(await this.exactOwnedProcessStillRunning(processObservation))) return true;
      if (Date.now() >= deadlineAt) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadlineAt - Date.now())));
    } while (Date.now() < deadlineAt);
    return !(await this.exactOwnedProcessStillRunning(processObservation));
  },

  async exactOwnedProcessStillRunning(
    processObservation: OwnedProcessObservation,
  ): Promise<boolean> {
    if (!processIsRunning(processObservation.processId)) return false;
    const observedStart = await boundedValue(
      processStartedAtToken(processObservation.processId),
      500,
      null,
    );
    return observedStart === null || observedStart === processObservation.startedAt;
  },

  handoffReleasePendingError(
    phase: 'close_requested' | 'process_exited' | 'profile_unlocked',
    profileLockFiles: string[],
    pending?: PendingHandoffRelease | null,
  ): Stage5BrowserError {
    const activePending = pending === undefined ? this.pendingHandoffRelease : pending;
    const applicationName = activePending?.launchIdentity.applicationName ?? 'the dedicated browser';
    return new Stage5BrowserError(
      'AUTH_HANDOFF_REQUIRED',
      phase === 'close_requested'
        ? `Stage5 requested ${applicationName} to close, but its exact owned process has not exited within this operation budget.`
        : phase === 'process_exited'
          ? `The exact owned ${applicationName} process exited, but its profile has not unlocked within this operation budget.`
          : `The exact owned ${applicationName} process exited and its profile unlocked; Stage5 retained the handoff so it can continue safely.`,
      {
        recoverable: true,
        details: {
          reason: 'handoff_release_pending',
          phase,
          closeRequestCompleted: activePending?.closeRequestCompleted ?? null,
          profileLockFiles,
          ownershipRetained: true,
          suggestedAction: 'Do not reopen the browser, repeat authentication, delete profile locks, or switch backends. Call browser_request_login_handoff once more; Stage5 will resume this exact release phase instead of relaunching the controlled browser.',
        },
      },
    );
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type HandoffReleaseOperations = typeof handoffReleaseOperations;
