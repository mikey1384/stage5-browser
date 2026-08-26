import {
  type AvailableBrowsers,
  browserAvailability,
  type BrowserDiagnostics,
  browserLaunchPolicyDiagnostics,
  type BrowserOperationalAvailability,
  type BrowserProduct,
  type BrowserStatus,
  inspectProfile,
  inspectProfileOwnershipLease,
  launchIdentityForTarget,
  profileBindingForBrowser,
  profileDirForBrowser,
  proveExitedPlaywrightSingleton,
  resolveBrowserLaunchTarget,
  suggestedActionForReason,
  SUPPORTED_BROWSER_PRODUCTS,
} from '../dependencies.js';
import { boundedValue } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const lifecycleAvailabilityOperations = {
  async availableBrowsers(): Promise<AvailableBrowsers> {
    await this.restoreDurableAuthenticationHandoff();
    const browsers = await Promise.all(
      SUPPORTED_BROWSER_PRODUCTS.map(async (browser) =>
        this.operationalBrowserAvailability(browser)),
    );
    return {
      defaultBrowser: this.config.browser,
      currentBrowser: this.selectedBrowser,
      browsers,
    };
  },

  async operationalBrowserAvailability(
    browser: BrowserProduct,
  ): Promise<BrowserOperationalAvailability> {
    const executableAvailability = await browserAvailability(this.selectionFor(browser));
    if (!executableAvailability.available) {
      return {
        ...executableAvailability,
        installed: false,
        profileState: 'unavailable',
        startable: false,
        recoverable: false,
        suggestedAction: suggestedActionForReason(executableAvailability.reason),
      };
    }

    const target = await resolveBrowserLaunchTarget(this.selectionFor(browser));
    const profileRoot = profileDirForBrowser(this.config, browser);
    const identity = launchIdentityForTarget(target, profileRoot);
    const profile = await inspectProfile(
      profileRoot,
      browser === this.selectedBrowser && (
        this.usableContext() !== undefined
        || this.authenticationHandoff?.session.state().running === true
        || this.pendingHandoffRelease !== null
      ),
    );
    const lease = await inspectProfileOwnershipLease(
      profileRoot,
      identity,
      this.ownershipLease.leaseId,
    );

    if (lease.state === 'current_owner') {
      const privateHandoff = lease.lease?.controlMode === 'human_handoff';
      const releasePending = lease.lease?.phase === 'close_requested'
        || lease.lease?.phase === 'process_exited'
        || lease.lease?.phase === 'profile_unlocked';
      return {
        ...executableAvailability,
        installed: true,
        available: !privateHandoff && !releasePending,
        profileState: 'owned_active',
        startable: !privateHandoff && !releasePending,
        recoverable: privateHandoff || releasePending,
        suggestedAction: privateHandoff
          ? 'Complete the active private handoff, then call browser_resume_after_login. Do not start another backend or delete profile locks.'
          : releasePending
            ? 'Call browser_request_login_handoff once more to continue the retained release phase.'
            : browser === this.selectedBrowser && this.usableContext() !== undefined
              ? 'This backend is already controlled by the current Stage5 session.'
              : 'Call browser_start once to reconnect the current Stage5-owned backend.',
      };
    }
    if (lease.state === 'busy_other_stage5_session') {
      return {
        ...executableAvailability,
        installed: true,
        available: false,
        profileState: 'busy_other_stage5_session',
        startable: false,
        recoverable: false,
        suggestedAction: `Continue in the live Stage5 session that owns ${identity.applicationName}, or ask it to call browser_stop. Do not retry, kill the browser, or delete locks.`,
      };
    }
    if (lease.state === 'owned_orphaned') {
      const privateHandoff = lease.lease?.controlMode === 'human_handoff';
      const durableHandoffRecovered = privateHandoff
        && browser === this.selectedBrowser
        && this.authenticationHandoff?.state === 'awaiting_user';
      return {
        ...executableAvailability,
        installed: true,
        available: !privateHandoff,
        profileState: 'owned_orphaned',
        startable: !privateHandoff,
        recoverable: true,
        suggestedAction: privateHandoff
          ? durableHandoffRecovered
            ? 'The exact private handoff was recovered from durable ownership evidence. Complete the private step, leave the dedicated Chromium-family browser open, then call browser_resume_after_login once.'
            : `The private handoff outlived its worker but could not yet be rebound safely. Leave the dedicated ${identity.applicationName} open, call browser_auth_status once, and do not attach, terminate, or delete locks.`
          : 'Call browser_start once. Stage5 will reattach or restart only after re-proving the exact orphaned ownership lease.',
      };
    }
    if (lease.state === 'invalid') {
      return {
        ...executableAvailability,
        installed: true,
        available: false,
        profileState: 'external_owner',
        startable: false,
        recoverable: false,
        suggestedAction: `The profile has an invalid or mismatched Stage5 ownership record. Do not overwrite it, kill a process, or delete locks; inspect ${identity.applicationName} ownership first.`,
      };
    }
    if (
      lease.state === 'abandoned'
      && lease.lease?.controlMode === 'human_handoff'
      && browser === this.selectedBrowser
      && this.authenticationHandoff?.state === 'awaiting_user'
    ) {
      return {
        ...executableAvailability,
        installed: true,
        available: false,
        profileState: 'owned_orphaned',
        startable: false,
        recoverable: true,
        suggestedAction: 'The exact private handoff was recovered across the worker crash window. Complete the private step, leave the dedicated Chromium-family browser open, then call browser_resume_after_login once.',
      };
    }
    if (
      lease.state === 'abandoned'
      && await proveExitedPlaywrightSingleton(profileRoot, identity, lease) !== null
    ) {
      return {
        ...executableAvailability,
        installed: true,
        available: true,
        profileState: 'owned_orphaned',
        startable: true,
        recoverable: true,
        suggestedAction: 'Call browser_start once. Stage5 will remove only the revalidated singleton entries bound to its exact proven exited process, then launch the intended profile.',
      };
    }
    if (lease.state === 'abandoned' && profile.lockFiles.length === 0) {
      return {
        ...executableAvailability,
        installed: true,
        available: true,
        profileState: 'startable',
        startable: true,
        recoverable: true,
        suggestedAction: 'Call browser_start once; Stage5 can safely replace the abandoned record because the profile is unlocked.',
      };
    }
    if (lease.state === 'abandoned') {
      return {
        ...executableAvailability,
        installed: true,
        available: false,
        profileState: 'external_owner',
        startable: false,
        recoverable: false,
        suggestedAction: `The old record no longer proves ownership of the live lock. Close only the visibly identified dedicated ${identity.applicationName} normally; never delete locks or kill an unknown owner.`,
      };
    }
    if (profile.lockFiles.length === 0) {
      return {
        ...executableAvailability,
        installed: true,
        available: true,
        profileState: 'startable',
        startable: true,
        recoverable: false,
        suggestedAction: null,
      };
    }
    if (target.engine === 'chromium') {
      const owner = await this.profileOwnerInspector(profileRoot, identity);
      const recoverable = owner.reconnectRecord !== null;
      return {
        ...executableAvailability,
        installed: true,
        available: recoverable,
        profileState: recoverable ? 'owned_orphaned' : 'external_owner',
        startable: recoverable,
        recoverable,
        suggestedAction: owner.evidence.suggestedAction,
      };
    }
    return {
      ...executableAvailability,
      installed: true,
      available: false,
      profileState: 'external_owner',
      startable: false,
      recoverable: false,
      suggestedAction: `The ${identity.applicationName} profile is locked without a conclusive Stage5 lease. Close only that visibly identified dedicated browser normally; do not kill a process or delete lock files.`,
    };
  },

  async diagnostics(status?: BrowserStatus): Promise<BrowserDiagnostics> {
    const currentStatus = status ?? (await this.status());
    const availability = await browserAvailability(this.selectionFor(this.selectedBrowser));
    const profilePath = profileDirForBrowser(this.config, this.selectedBrowser);
    const profileBinding = currentStatus.launchIdentity?.profile
      ?? profileBindingForBrowser(profilePath, availability.engine);
    const page = this.preferredPage();
    const humanBootstrapRunning = this.authenticationHandoff?.state === 'awaiting_user';
    const handoffReleasePending = this.pendingHandoffRelease !== null;
    const controlMode = humanBootstrapRunning
      ? 'human_bootstrap'
      : this.usableContext() === undefined
        ? 'none'
        : 'playwright';
    const navigatorWebdriver = controlMode === 'playwright' && page !== undefined
      ? await boundedValue(page.evaluate(() => navigator.webdriver), 500, null)
      : null;
    const nativeChromiumProcess = this.nativeAttachedBrowser !== undefined
      || this.authenticationHandoff?.session.controlChannel?.()?.kind === 'chromium_cdp';
    const profile = await inspectProfile(
      profilePath,
      currentStatus.browserConnected || humanBootstrapRunning || handoffReleasePending,
    );
    return {
      browser: this.selectedBrowser,
      engine: availability.engine,
      availability,
      preflightSuggestedAction: availability.available
        ? null
        : suggestedActionForReason(availability.reason),
      profile,
      profileOwner: await this.profileOwnerEvidence(
        profile,
        currentStatus.launchIdentity,
        humanBootstrapRunning || handoffReleasePending,
      ),
      profileBinding,
      launchIdentity: currentStatus.launchIdentity,
      runtimeProfile: currentStatus.runtimeProfile,
      authenticationStorageBoundary: this.lastHandoffOutcome?.storageContinuity ?? null,
      lastLaunchFailure: this.lastLaunchFailure,
      launchPolicy: browserLaunchPolicyDiagnostics(
        this.selectedBrowser,
        this.config.headless,
        availability.source,
        process.platform,
        nativeChromiumProcess,
      ),
      automationExposure: {
        controlMode,
        controlledByPlaywright: controlMode === 'playwright',
        enableAutomationArgument: controlMode === 'human_bootstrap' || nativeChromiumProcess
          ? 'absent'
          : controlMode === 'playwright' && availability.engine === 'chromium'
            ? 'present'
            : 'not_applicable',
        navigatorWebdriver,
        navigatorWebdriverObserved: controlMode === 'playwright' && page !== undefined,
        observation: controlMode === 'human_bootstrap'
          ? 'uncontrolled_browser_not_instrumented'
          : controlMode === 'playwright'
            ? 'controlled_page_runtime'
            : 'no_browser_running',
      },
      page: page === undefined ? null : this.pageDiagnostics.snapshot(page),
    };
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type LifecycleAvailabilityOperations = typeof lifecycleAvailabilityOperations;
