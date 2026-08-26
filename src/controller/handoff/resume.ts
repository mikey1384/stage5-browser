import { type Browser, type BrowserCommandInput, type BrowserCommandOutput, compareAuthenticationStorage, compareProfileExitMarker, inspectProfile, inspectProfileShutdown, isStage5HandoffMarkerUrl, launchIdentityForTarget, type NativeControlRecord, ownershipProfileUnlocked, type Page, path, processIsRunning, type ProfileShutdownDecision, type ProfileStorageInspection, readNativeControlRecord, removeNativeControlRecord, type Request, resolveBrowserLaunchTarget, sameLaunchIdentity, sanitizeUrlForJournal, Stage5BrowserError, waitForProfileUnlock, writeNativeControlRecord } from '../dependencies.js';
import { remainingHandoffWorkBudget } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const handoffResumeOperations = {
  async resumeAfterLogin(
    input: BrowserCommandInput<'resumeAfterLogin'>,
  ): Promise<BrowserCommandOutput<'resumeAfterLogin'>> {
    const deadlineAt = Date.now() + input.timeoutMs;
    await this.restoreDurableAuthenticationHandoff();
    if (this.authenticationHandoff?.state !== 'awaiting_user') {
      throw new Stage5BrowserError('AUTH_HANDOFF_REQUIRED', 'No login handoff is currently awaiting the user.', {
        recoverable: true,
        details: {
          reason: 'no_pending_handoff',
          suggestedAction: 'Call browser_request_login_handoff before asking the user to authenticate.',
        },
      });
    }

    if (input.expected !== null) {
      this.validateAuthenticationUrlExpectation(input.expected);
    }

    const handoff = this.authenticationHandoff;
    let processState = handoff.session.state();
    const continuousChromiumHandoff = handoff.launchIdentity.engine === 'chromium'
      && handoff.session.controlChannel?.()?.kind === 'chromium_cdp';
    if (continuousChromiumHandoff && !processState.running) {
      await removeNativeControlRecord(handoff.profileDir);
      await this.ownershipLease.updatePhase('process_exited').catch(() => undefined);
      if (await ownershipProfileUnlocked(handoff.profileDir)) {
        await this.ownershipLease.updatePhase('profile_unlocked').catch(() => undefined);
        await this.ownershipLease.release().catch(() => undefined);
      }
      this.authenticationHandoff = null;
      this.state = 'stopped';
      throw new Stage5BrowserError(
        'AUTH_NOT_PERSISTED',
        'The dedicated browser was closed before Stage5 Browser could attach to the authenticated process.',
        {
          recoverable: true,
          details: {
            reason: 'human_browser_exited_before_attach',
            suggestedAction: 'Request a new login handoff and leave that dedicated browser open after authentication; Stage5 Browser now attaches without restarting it.',
          },
        },
      );
    }
    if (!continuousChromiumHandoff && processState.running) {
      const exitBudgetMs = remainingHandoffWorkBudget(deadlineAt);
      if (exitBudgetMs > 0) {
        await handoff.session.waitForExit(exitBudgetMs);
        processState = handoff.session.state();
      }
      if (processState.running) {
        throw new Stage5BrowserError(
          'AUTH_HANDOFF_REQUIRED',
          'The private human-interaction browser is still running.',
          {
            recoverable: true,
            details: {
              reason: 'human_browser_still_running',
              phase: 'human_input',
              ownershipRetained: true,
              suggestedAction: `Complete the private step and quit ${handoff.launchIdentity.applicationName} normally so its process exits, then call browser_resume_after_login once. On macOS, use Cmd-Q in that exact application; closing only a tab or window may leave it running.`,
            },
          },
        );
      }
    }

    let afterHumanStorage: ProfileStorageInspection | null = null;
    if (!continuousChromiumHandoff) {
      await this.ownershipLease.updatePhase('process_exited');
      const unlockBudgetMs = remainingHandoffWorkBudget(deadlineAt);
      let profileUnlocked = unlockBudgetMs > 0
        && await waitForProfileUnlock(handoff.profileDir, unlockBudgetMs);
      if (!profileUnlocked) {
        profileUnlocked = (await inspectProfile(handoff.profileDir, false)).lockFiles.length === 0;
      }
      if (!profileUnlocked) {
        const profile = await inspectProfile(handoff.profileDir, false);
        throw new Stage5BrowserError(
          'AUTH_HANDOFF_REQUIRED',
          'The private browser process exited, but its profile is still locked.',
          {
            recoverable: true,
            details: {
              reason: 'profile_locked_after_handoff',
              phase: 'process_exited',
              profileLockFiles: profile.lockFiles,
              ownershipRetained: true,
              suggestedAction: 'Do not reopen the browser, repeat the private step, or delete profile locks. Call browser_resume_after_login once more; Stage5 will continue waiting on this same handoff instead of relaunching it.',
            },
          },
        );
      }

      await this.ownershipLease.updatePhase('profile_unlocked');
      await this.ownershipLease.release();

      if (remainingHandoffWorkBudget(deadlineAt) === 0) {
        throw new Stage5BrowserError(
          'AUTH_HANDOFF_REQUIRED',
          'The private browser exited and its profile unlocked, but this operation budget ended before controlled reattachment.',
          {
            recoverable: true,
            details: {
              reason: 'handoff_resume_pending',
              phase: 'profile_unlocked',
              profileLockFiles: [],
              suggestedAction: 'Do not reopen the browser or repeat the private step. Call browser_resume_after_login once more to continue with the same unlocked profile.',
            },
          },
        );
      }

      const observedShutdown = await inspectProfileShutdown(
        handoff.profileDir,
        this.selectedBrowser,
        handoff.launchIdentity.profile.profileDirectory,
      );
      const exitTypeComparison = compareProfileExitMarker(handoff.beforeProfileShutdown, observedShutdown);
      const processExitedNormally = processState.exitCode === 0 && processState.exitSignal === null;
      const processExitedAbnormally = processState.exitSignal !== null
        || (processState.exitCode !== null && processState.exitCode !== 0);
      const explicitUnlockedProfileOverride = !processExitedNormally && handoff.shutdownOverrideOffered;
      const shutdown: ProfileShutdownDecision = {
        ...observedShutdown,
        state: processExitedNormally
          ? 'clean'
          : explicitUnlockedProfileOverride
            ? 'unknown'
            : processExitedAbnormally
              ? 'unclean'
              : 'unknown',
        exitedCleanly: processExitedNormally ? true : processExitedAbnormally ? false : null,
        exitedCleanlySource: processExitedNormally || processExitedAbnormally
          ? 'process_exit'
          : 'insufficient_evidence',
        exitTypeComparison,
        currentSessionEvidence: processExitedNormally
          ? 'clean_process_exit'
          : processExitedAbnormally
            ? 'abnormal_process_exit'
            : 'process_exit_unknown',
        reattachmentDecision: processExitedNormally
          ? 'allowed'
          : explicitUnlockedProfileOverride
            ? 'explicit_unlocked_profile_override'
            : 'override_available',
      };
      handoff.profileShutdown = shutdown;
      if (!processExitedNormally && !explicitUnlockedProfileOverride) {
        handoff.shutdownOverrideOffered = true;
        throw new Stage5BrowserError(
          'AUTH_HANDOFF_REQUIRED',
          processExitedAbnormally
            ? 'The private authentication browser process exited abnormally, but the profile is unlocked.'
            : 'The private authentication browser stopped and unlocked its profile, but did not report a process exit result.',
          {
            recoverable: true,
            details: {
              reason: processExitedAbnormally
                ? 'abnormal_human_browser_process_exit'
                : 'human_browser_process_exit_unknown',
              exitType: shutdown.exitType,
              exitTypeComparison: shutdown.exitTypeComparison,
              exitedCleanly: shutdown.exitedCleanly,
              exitedCleanlySource: shutdown.exitedCleanlySource,
              profileDirectory: shutdown.profileDirectory,
              profileLocks: shutdown.profileLocks,
              processExitCode: processState.exitCode,
              processExitSignal: processState.exitSignal,
              overrideAvailable: true,
              suggestedAction: 'Do not repeat authentication or reopen the browser. Because the human process is gone and the profile has zero locks, call browser_resume_after_login once more with the same expectation to explicitly reattach this same isolated profile. Stage5 Browser will not rewrite its Chromium preferences.',
            },
          },
        );
      }

      afterHumanStorage = await this.profileStorageInspector(
        handoff.launchIdentity.profile,
        handoff.launchIdentity.engine,
        handoff.targetOrigin,
      );
    }
    const resumeTarget = await resolveBrowserLaunchTarget(this.selectionFor(this.selectedBrowser));
    const resumeIdentity = launchIdentityForTarget(resumeTarget, handoff.profileDir);
    if (!sameLaunchIdentity(handoff.launchIdentity, resumeIdentity)) {
      throw new Stage5BrowserError(
        'AUTH_NOT_PERSISTED',
        'The browser executable or profile partition changed before controlled reattachment.',
        {
          recoverable: true,
          details: {
            reason: 'auth_launch_identity_mismatch',
            humanIdentity: handoff.launchIdentity,
            reattachmentIdentity: resumeIdentity,
            suggestedAction: 'Do not repeat the login. Restore the same selected backend and dedicated profile binding, then resume once.',
          },
        },
      );
    }

    let continuousRecord: NativeControlRecord | null = null;
    if (continuousChromiumHandoff) {
      continuousRecord = await readNativeControlRecord(handoff.profileDir, this.selectedBrowser);
      if (
        continuousRecord === null
        || continuousRecord.processId !== processState.processId
        || !processIsRunning(continuousRecord.processId)
      ) {
        throw new Stage5BrowserError(
          'AUTH_NOT_PERSISTED',
          'The private browser control record no longer matches the authenticated process.',
          {
            recoverable: true,
            details: {
              reason: 'native_control_identity_mismatch',
              suggestedAction: 'Do not attach to another process. Close the dedicated Stage5 browser if it is still visible, then request a new handoff.',
            },
          },
        );
      }
      await this.ensureDurableAuthenticationHandoffOwnership(handoff, continuousRecord);
      continuousRecord = { ...continuousRecord, state: 'controlled' };
      await writeNativeControlRecord(handoff.profileDir, continuousRecord);
    }

    handoff.state = 'ready_for_agent_verification';
    let page: Page;
    try {
      await this.start({}, handoff.targetOrigin, continuousChromiumHandoff);
      if (
        this.controlledLaunchIdentity === null
        || !sameLaunchIdentity(handoff.launchIdentity, this.controlledLaunchIdentity)
      ) {
        throw new Stage5BrowserError(
          'AUTH_NOT_PERSISTED',
          'Controlled reattachment did not use the native authentication browser identity.',
          {
            recoverable: true,
            details: {
              reason: 'auth_launch_identity_mismatch',
              humanIdentity: handoff.launchIdentity,
              reattachmentIdentity: this.controlledLaunchIdentity,
              suggestedAction: 'Do not repeat the login. Inspect the reported executable and profile binding mismatch first.',
            },
          },
        );
      }
      const context = this.usableContext();
      if (context === undefined) {
        throw new Stage5BrowserError('BROWSER_NOT_READY', 'The controlled browser did not reconnect after login.');
      }
      if (this.runtimeProfileObservation?.matchesConfigured === false) {
        throw new Stage5BrowserError(
          'AUTH_NOT_PERSISTED',
          'The running browser reported a different profile path from the authentication handoff.',
          {
            recoverable: true,
            details: {
              reason: 'auth_runtime_profile_mismatch',
              configuredProfile: handoff.launchIdentity.profile,
              runtimeProfile: this.runtimeProfileObservation,
              suggestedAction: 'Do not repeat login. Stop before navigation and inspect the reported runtime profile path mismatch.',
            },
          },
        );
      }
      const markerPages = context.pages().filter((candidate) => isStage5HandoffMarkerUrl(candidate.url()));
      await Promise.all(markerPages.map(async (candidate) => candidate.close({ runBeforeUnload: false })));
      page = context.pages().findLast((candidate) => !candidate.isClosed()) ?? (await context.newPage());
      this.bindPage(page);
      this.activePage = page;
      handoff.page = page;
      if (!this.isWebUrl(page.url()) && handoff.targetUrl !== 'about:blank') {
        await this.open({
          url: handoff.targetUrl,
          newTab: false,
          stabilizationMs: 750,
          timeoutMs: input.timeoutMs,
        });
        page = this.preferredPage() ?? page;
      }
    } catch (error) {
      if (continuousRecord !== null && processIsRunning(continuousRecord.processId)) {
        await writeNativeControlRecord(handoff.profileDir, {
          ...continuousRecord,
          state: 'awaiting_user',
        }).catch(() => undefined);
      }
      handoff.state = 'awaiting_user';
      handoff.page = null;
      throw error;
    }
    let authenticationUrlFailure: Stage5BrowserError | null = null;
    if (input.expected !== null) {
      try {
        await this.waitForUrlExpectation(
          page,
          input.expected,
          input.timeoutMs,
          'Login handoff',
          true,
        );
      } catch (error) {
        if (!(error instanceof Stage5BrowserError)) {
          throw error;
        }
        authenticationUrlFailure = error;
      }
    }
    const resumedContext = this.usableContext();
    if (resumedContext === undefined) {
      throw new Stage5BrowserError('BROWSER_NOT_READY', 'The controlled browser disappeared during storage-boundary inspection.');
    }
    const controlledStartBoundary = this.controlledStartBoundary?.targetOrigin === handoff.targetOrigin
      ? this.controlledStartBoundary
      : null;
    const afterControlledStartStorage = controlledStartBoundary?.storage
      ?? await this.controlledProfileStorageInspector(
        handoff.launchIdentity.profile,
        handoff.launchIdentity.engine,
        handoff.targetOrigin,
        (urls) => resumedContext.cookies(urls).then((cookies) => cookies.map((cookie) => ({
          domain: cookie.domain,
          name: cookie.name,
          expires: cookie.expires,
        }))),
      );
    const afterTargetLoadStorage = await this.controlledProfileStorageInspector(
      handoff.launchIdentity.profile,
      handoff.launchIdentity.engine,
      handoff.targetOrigin,
      (urls) => resumedContext.cookies(urls).then((cookies) => cookies.map((cookie) => ({
        domain: cookie.domain,
        name: cookie.name,
        expires: cookie.expires,
      }))),
    );
    const effectiveAfterHumanStorage = afterHumanStorage ?? afterControlledStartStorage;
    const storageComparison = compareAuthenticationStorage(
      handoff.beforeStorage,
      effectiveAfterHumanStorage,
      afterControlledStartStorage,
      afterTargetLoadStorage,
      {
        targetOriginLoadedAtControlledStart: controlledStartBoundary?.targetOriginLoaded ?? false,
        navigatorWebdriverAtControlledStart: controlledStartBoundary?.navigatorWebdriver ?? null,
      },
    );
    handoff.resumedAt = new Date().toISOString();
    const afterUrl = sanitizeUrlForJournal(page.url()) ?? null;
    const afterSemanticFingerprint = await this.semanticFingerprint(page);
    this.lastHandoffOutcome = {
      observation: 'sanitized_before_after_boundary',
      exactUserInteractionsObserved: false,
      beforeUrl: handoff.beforeUrl,
      afterUrl,
      routeChanged: handoff.beforeUrl === null || afterUrl === null
        ? null
        : handoff.beforeUrl !== afterUrl,
      semanticStructureChanged:
        handoff.beforeSemanticFingerprint === null || afterSemanticFingerprint === null
          ? null
          : handoff.beforeSemanticFingerprint !== afterSemanticFingerprint,
      launchIdentityMatched: true,
      runtimeProfile: this.runtimeProfileObservation,
      storageContinuity: storageComparison.continuity,
      comparedAt: handoff.resumedAt,
    };
    this.lastKnownUrl = page.url();
    const verificationPreview = await this.authenticationVerificationPreview(page);
    if (storageComparison.authNotPersisted) {
      throw new Stage5BrowserError(
        'AUTH_NOT_PERSISTED',
        'Target-origin session metadata was lost across controlled reattachment.',
        {
          recoverable: true,
          details: {
            reason: 'authentication_storage_lost',
            runtimeProfile: this.runtimeProfileObservation,
            storageContinuity: storageComparison.continuity,
            currentUrl: sanitizeUrlForJournal(page.url()) ?? null,
            suggestedAction: 'Do not repeat login. Report the loss boundary, automation correlation, restored-target flag, runtime profile, and visible site state before changing the control architecture.',
          },
        },
      );
    }
    if (
      authenticationUrlFailure !== null
      && storageComparison.continuity.humanSessionEvidenceObserved === true
      && input.expected !== null
    ) {
      throw new Stage5BrowserError(
        'AUTH_NOT_PERSISTED',
        'The human login changed target-origin session metadata, but controlled reattachment did not reach the requested post-login route.',
        {
          recoverable: true,
          details: {
            reason: 'post_login_url_not_reached',
            launchIdentity: handoff.launchIdentity,
            storageContinuity: storageComparison.continuity,
            expected: input.expected,
            currentUrl: sanitizeUrlForJournal(page.url()) ?? null,
            suggestedAction: 'Do not repeat the login yet. Inspect the bounded verification preview and profile binding evidence; the controlled browser remains available for diagnosis.',
          },
        },
      );
    }
    if (authenticationUrlFailure !== null) {
      throw authenticationUrlFailure;
    }
    return {
      ...(await this.authenticationStatus(page)),
      userActionRequired: false,
      instructions: 'Storage continuity is not treated as proof of authentication. Inspect verificationPreview now; if it still shows signed-out controls, stop and report that site state rather than proceeding or repeating login. Then take a fresh full semantic snapshot before any account action.',
      verificationPreview,
    };
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type HandoffResumeOperations = typeof handoffResumeOperations;
