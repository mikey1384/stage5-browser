import { type Browser, type BrowserCommandInput, type BrowserCommandOutput, humanBrowserLaunchPolicy, launchIdentityForTarget, profileDirForBrowser, resolveBrowserLaunchTarget, sameLaunchIdentity, sanitizeUrlForJournal, Stage5BrowserError } from '../dependencies.js';
import { boundedValue, remainingHandoffWorkBudget } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const handoffRequestOperations = {
  async authStatus(): Promise<BrowserCommandOutput<'authStatus'>> {
    await this.restoreDurableAuthenticationHandoff();
    const context = this.usableContext();
    if (context !== undefined) {
      await this.reconcileVisiblePage(context);
    }
    const page = context === undefined ? undefined : this.preferredPage();
    return this.authenticationStatus(page);
  },

  async requestLoginHandoff(
    input: BrowserCommandInput<'requestLoginHandoff'>,
  ): Promise<BrowserCommandOutput<'requestLoginHandoff'>> {
    const deadlineAt = Date.now() + input.timeoutMs;
    if (this.pendingHandoffRelease !== null) {
      return this.continuePendingHandoffRelease(deadlineAt);
    }
    await this.restoreDurableAuthenticationHandoff();

    if (this.authenticationHandoff !== null) {
      throw new Stage5BrowserError(
        'AUTH_HANDOFF_REQUIRED',
        'An authentication handoff is already active.',
        {
          recoverable: true,
          details: {
            reason: 'handoff_already_active',
            suggestedAction: this.authenticationHandoff.state === 'awaiting_user'
              ? this.authenticationHandoff.session.controlChannel?.()?.kind === 'chromium_cdp'
                ? 'Finish authentication, leave the dedicated browser open, then call browser_resume_after_login so Stage5 attaches to that same process.'
                : 'Finish authentication and quit the dedicated browser normally so its process exits, then call browser_resume_after_login.'
              : 'Take the required fresh semantic snapshot before requesting another handoff.',
          },
        },
      );
    }
    if (this.config.headless) {
      throw new Stage5BrowserError(
        'AUTH_HANDOFF_UNAVAILABLE',
        'Login handoff requires a visible Stage5 Browser window.',
        {
          recoverable: true,
          details: {
            reason: 'headless_profile',
            suggestedAction: 'Run the persistent Stage5 Browser profile in headed mode, then request the handoff again.',
          },
        },
      );
    }

    const launchTarget = await resolveBrowserLaunchTarget(this.selectionFor(this.selectedBrowser));
    const profileDir = profileDirForBrowser(this.config, this.selectedBrowser);
    const launchIdentity = launchIdentityForTarget(launchTarget, profileDir);
    if (
      this.controlledLaunchIdentity !== null
      && !sameLaunchIdentity(this.controlledLaunchIdentity, launchIdentity)
    ) {
      throw new Stage5BrowserError(
        'AUTH_NOT_PERSISTED',
        'The controlled browser identity changed before authentication handoff.',
        {
          recoverable: true,
          details: {
            reason: 'auth_launch_identity_mismatch',
            controlledIdentity: this.controlledLaunchIdentity,
            requestedIdentity: launchIdentity,
            suggestedAction: 'Stop before entering credentials. Start the intended backend once, then request a new handoff from that same backend.',
          },
        },
      );
    }
    const humanPolicy = humanBrowserLaunchPolicy(launchTarget);
    if (!humanPolicy.supported) {
      throw new Stage5BrowserError(
        'AUTH_HANDOFF_UNAVAILABLE',
        'Human authentication bootstrap is not available for the selected browser engine.',
        {
          recoverable: true,
          details: {
            reason: 'human_bootstrap_engine_unsupported',
            browser: this.selectedBrowser,
            engine: launchTarget.engine,
            suggestedAction: 'Select Brave, Chrome, Edge, Chromium, or Firefox for authentication.',
          },
        },
      );
    }

    let page = await this.ensureActivePage(await this.ensureContext());
    if (input.url !== null) {
      const navigationBudgetMs = remainingHandoffWorkBudget(deadlineAt);
      if (navigationBudgetMs === 0) {
        throw this.handoffReleasePendingError('close_requested', []);
      }
      await this.open({ url: input.url, newTab: false, stabilizationMs: 750, timeoutMs: navigationBudgetMs });
      page = await this.ensureActivePage(await this.ensureContext());
    }
    await page.bringToFront();

    const targetUrl = this.humanBootstrapTargetUrl(page.url());
    const targetOrigin = this.urlOrigin(targetUrl);
    const beforeUrl = sanitizeUrlForJournal(page.url()) ?? null;
    const beforeSemanticFingerprint = await this.semanticFingerprint(page);
    const context = this.usableContext();
    if (context === undefined) {
      throw new Stage5BrowserError('BROWSER_NOT_READY', 'The controlled profile disappeared before handoff.');
    }

    const handoffLabel = this.authenticationHandoffLabel(launchIdentity, targetOrigin);
    const controlledBrowserProcess = this.controlledBrowserProcess;
    if (controlledBrowserProcess === null) {
      throw new Stage5BrowserError(
        'BROWSER_NOT_READY',
        'Stage5 Browser cannot release this profile for private input without an exact durable browser-process identity.',
        {
          recoverable: true,
          details: {
            reason: 'ownership_unverified',
            suggestedAction: 'Stop before entering private information. Run browser_diagnostics and correct the ownership evidence before requesting a private handoff.',
          },
        },
      );
    }
    this.pendingHandoffRelease = {
      mode: 'human_bootstrap',
      state: 'releasing_control',
      requestedAt: new Date().toISOString(),
      launchTarget,
      profileDir,
      launchIdentity,
      handoffLabel,
      targetUrl,
      targetOrigin,
      beforeUrl,
      beforeSemanticFingerprint,
      controlledBrowserProcess,
      closeRequestCompleted: false,
    };
    await this.ownershipLease.updatePhase('close_requested');
    const closeBudgetMs = remainingHandoffWorkBudget(deadlineAt);
    const closeCompleted = closeBudgetMs > 0 && await boundedValue(
      context.close({ reason: 'Stage5 Browser released the profile for private human interaction.' })
        .then(() => true),
      closeBudgetMs,
      false,
    );
    if (this.pendingHandoffRelease !== null) {
      this.pendingHandoffRelease.closeRequestCompleted = closeCompleted;
    }
    this.clearControlledBrowserState();
    return this.continuePendingHandoffRelease(deadlineAt);
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type HandoffRequestOperations = typeof handoffRequestOperations;
