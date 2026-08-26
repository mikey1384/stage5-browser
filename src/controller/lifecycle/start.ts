import { type BrowserCommandInput, type BrowserStatus, controlledProfileArguments, inspectProfileOwnershipLease, launchFailureDiagnostic, launchIdentityForTarget, mkdir, observeLaunchedBrowserProcess, path, playwrightBrowserType, processIsRunning, profileDirForBrowser, proveExitedPlaywrightSingleton, readNativeControlRecord, removeNativeControlRecord, removeProfileOwnershipLease, removeProvenExitedPlaywrightSingletonFiles, resolveBrowserLaunchTarget, snapshotOwnedDescendants, Stage5BrowserError, waitForProfileUnlock } from '../dependencies.js';
import type { BrowserControllerContext } from '../runtime.js';

export const lifecycleStartOperations = {
  async start(
    input: BrowserCommandInput<'start'> = {},
    authenticationProbeTargetOrigin: string | null = null,
    resumeOwnedHumanHandoff = false,
  ): Promise<BrowserStatus> {
    if (this.pendingHandoffRelease !== null || this.authenticationHandoff?.state === 'awaiting_user') {
      throw this.humanBootstrapInProgressError();
    }
    if (this.context !== undefined && !this.context.isClosed()) {
      if (input.browser !== undefined && input.browser !== this.selectedBrowser) {
        throw new Stage5BrowserError(
          'OPERATION_FAILED',
          'Another browser profile is already running. Use browser_switch to close it and change browsers.',
          {
            details: {
              currentBrowser: this.selectedBrowser,
              requestedBrowser: input.browser,
              reason: 'browser_already_running',
            },
          },
        );
      }
      this.state = 'running';
      return this.status();
    }

    if (input.browser !== undefined && input.browser !== this.selectedBrowser) {
      await resolveBrowserLaunchTarget(this.selectionFor(input.browser));
      this.selectedBrowser = input.browser;
      this.lastKnownUrl = null;
    }

    this.state = 'starting';
    let ownershipClaimedForLaunch = false;
    let attemptedProfileRoot: string | null = null;
    let delegatedStaleSingletonRecovery = false;
    try {
      const launchTarget = await resolveBrowserLaunchTarget(this.selectionFor(this.selectedBrowser));
      const enableChromiumSandbox = launchTarget.engine === 'chromium' && process.platform === 'darwin';
      const profileDir = profileDirForBrowser(this.config, this.selectedBrowser);
      attemptedProfileRoot = profileDir;
      const launchIdentity = launchIdentityForTarget(launchTarget, profileDir);
      await Promise.all([
        mkdir(profileDir, { recursive: true, mode: 0o700 }),
        mkdir(this.config.artifactsDir, { recursive: true, mode: 0o700 }),
        mkdir(path.join(this.config.artifactsDir, 'downloads'), { recursive: true, mode: 0o700 }),
      ]);

      const abandonedExitRecovery = await this.prepareOwnershipLeaseForStart(
        profileDir,
        launchIdentity,
        resumeOwnedHumanHandoff,
      );

      if (launchTarget.engine === 'chromium') {
        const nativeRecord = await readNativeControlRecord(profileDir, this.selectedBrowser);
        if (nativeRecord !== null) {
          if (processIsRunning(nativeRecord.processId)) {
            if (nativeRecord.state === 'awaiting_user') {
              throw new Stage5BrowserError(
                'AUTH_HANDOFF_REQUIRED',
                'A private Chromium login handoff is still awaiting explicit resume.',
                {
                  recoverable: true,
                  details: {
                    reason: 'native_handoff_awaiting_user',
                    suggestedAction: 'Return to the agent that requested the handoff and call browser_resume_after_login after private login. If that agent session is unavailable, close the dedicated browser normally, then start a new handoff.',
                  },
                },
              );
            }
            await this.claimNativeControlLeaseIfNeeded(
              profileDir,
              launchIdentity,
              resumeOwnedHumanHandoff,
            );
            return await this.attachToNativeChromium(
              nativeRecord,
              launchIdentity,
              authenticationProbeTargetOrigin,
            );
          }
          await removeNativeControlRecord(profileDir);
        }

        // A compatible worker replacement can release its Chromium process a fraction
        // after the new worker starts. Wait briefly for that owned lock to clear, but
        // never remove a lock or assume that an unknown owner is stale.
        if (!(await waitForProfileUnlock(profileDir, Math.min(this.config.readinessTimeoutMs, 2_000)))) {
          const lateNativeRecord = await readNativeControlRecord(profileDir, this.selectedBrowser);
          if (lateNativeRecord !== null && processIsRunning(lateNativeRecord.processId)) {
            await this.claimNativeControlLeaseIfNeeded(
              profileDir,
              launchIdentity,
              resumeOwnedHumanHandoff,
            );
            return await this.attachToNativeChromium(
              lateNativeRecord,
              launchIdentity,
              authenticationProbeTargetOrigin,
            );
          }
          const ownerInspection = await this.profileOwnerInspector(profileDir, launchIdentity);
          if (ownerInspection.reconnectRecord !== null) {
            await this.claimNativeControlLeaseIfNeeded(
              profileDir,
              launchIdentity,
              resumeOwnedHumanHandoff,
            );
            return await this.attachToNativeChromium(
              ownerInspection.reconnectRecord,
              launchIdentity,
              authenticationProbeTargetOrigin,
            );
          }
          const staleSingletonProof = abandonedExitRecovery === null
            ? null
            : await proveExitedPlaywrightSingleton(
              profileDir,
              launchIdentity,
              abandonedExitRecovery,
            );
          if (
            staleSingletonProof !== null
            && await removeProvenExitedPlaywrightSingletonFiles(
              profileDir,
              staleSingletonProof,
            )
          ) {
            if (
              !(await removeProfileOwnershipLease(
                profileDir,
                staleSingletonProof.leaseId,
              ))
            ) {
              const current = await inspectProfileOwnershipLease(
                profileDir,
                launchIdentity,
                this.ownershipLease.leaseId,
              );
              throw this.ownershipLeaseError(current, launchIdentity);
            }
            delegatedStaleSingletonRecovery = true;
          } else {
            throw this.lockedProfileOwnerError(ownerInspection);
          }
        } else if (abandonedExitRecovery !== null) {
          const lease = abandonedExitRecovery.lease;
          if (
            lease === null
            || !(await removeProfileOwnershipLease(profileDir, lease.leaseId))
          ) {
            const current = await inspectProfileOwnershipLease(
              profileDir,
              launchIdentity,
              this.ownershipLease.leaseId,
            );
            throw this.ownershipLeaseError(current, launchIdentity);
          }
        }
      }

      const leaseClaimed = await this.ownershipLease.claim({
        profileRoot: profileDir,
        identity: launchIdentity,
        controlMode: 'playwright',
      });
      if (!leaseClaimed) {
        const competingLease = await inspectProfileOwnershipLease(
          profileDir,
          launchIdentity,
          this.ownershipLease.leaseId,
        );
        throw this.ownershipLeaseError(competingLease, launchIdentity);
      }
      ownershipClaimedForLaunch = true;
      const baselineDescendants = await snapshotOwnedDescendants(process.pid);
      const context = await playwrightBrowserType(launchTarget.engine).launchPersistentContext(profileDir, {
        headless: this.config.headless,
        acceptDownloads: true,
        downloadsPath: path.join(this.config.artifactsDir, 'downloads'),
        viewport: { width: 1440, height: 900 },
        ...(launchTarget.engine === 'chromium'
          ? { args: controlledProfileArguments(launchIdentity.profile) }
          : {}),
        ...(enableChromiumSandbox ? { chromiumSandbox: true } : {}),
        ...(launchTarget.executablePath === null
          ? {}
          : { executablePath: launchTarget.executablePath }),
      });
      await this.activateControlledContext(
        context,
        launchIdentity,
        launchTarget.engine,
        authenticationProbeTargetOrigin,
      );
      const browserProcess = await observeLaunchedBrowserProcess(
        launchIdentity,
        baselineDescendants,
        Math.min(this.config.readinessTimeoutMs, 2_000),
      );
      if (browserProcess === null) {
        await context.close({ reason: 'Stage5 Browser could not establish exact durable process ownership.' })
          .catch(() => undefined);
        throw new Stage5BrowserError(
          'BROWSER_NOT_READY',
          'Stage5 Browser launched the profile but could not prove the exact browser process for its durable ownership lease.',
          {
            recoverable: true,
            details: {
              reason: 'ownership_unverified',
              suggestedAction: 'Call browser_diagnostics. Do not use, kill, or delete locks for the unverified browser process; close only the visibly identified dedicated Stage5 browser normally.',
            },
          },
        );
      }
      await this.ownershipLease.establish({
        profileRoot: profileDir,
        identity: launchIdentity,
        browserProcess,
        controlMode: 'playwright',
        phase: 'owned_active',
      });
      this.controlledBrowserProcess = browserProcess;
      return this.status();
    } catch (error) {
      if (ownershipClaimedForLaunch && attemptedProfileRoot !== null) {
        const unlocked = await waitForProfileUnlock(
          attemptedProfileRoot,
          Math.min(this.config.readinessTimeoutMs, 500),
        );
        if (unlocked) {
          await this.ownershipLease.updatePhase('profile_unlocked').catch(() => undefined);
          await this.ownershipLease.release().catch(() => undefined);
        } else if (delegatedStaleSingletonRecovery) {
          // The attempted browser never established an owned process. Remove only
          // this worker's exact Stage5 lease; any new or remaining Chromium locks
          // stay untouched and continue to fail closed as external ownership.
          await this.ownershipLease.release().catch(() => undefined);
        }
      }
      this.state = 'failed';
      const diagnostic = launchFailureDiagnostic(this.selectedBrowser, error);
      this.lastLaunchFailure = diagnostic;
      if (error instanceof Stage5BrowserError) {
        throw new Stage5BrowserError(error.code, error.message, {
          recoverable: error.recoverable,
          details: {
            ...error.details,
            browser: diagnostic.browser,
            engine: diagnostic.engine,
            reason: error.details?.reason ?? diagnostic.reason,
            suggestedAction: error.details?.suggestedAction ?? diagnostic.suggestedAction,
            occurredAt: diagnostic.occurredAt,
          },
          cause: error,
        });
      }
      throw new Stage5BrowserError('BROWSER_NOT_READY', 'The dedicated browser profile could not be started.', {
        recoverable: true,
        details: { ...diagnostic },
        cause: error,
      });
    }
  },

} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type LifecycleStartOperations = typeof lifecycleStartOperations;
