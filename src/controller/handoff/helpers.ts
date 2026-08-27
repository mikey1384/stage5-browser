import { type AuthenticationStatus, type Browser, BROWSER_ENGINES, type BrowserCommandOutput, type BrowserLaunchIdentity, type Frame, type Page, path, privacyFingerprint, profileBindingForBrowser, profileDirForBrowser, randomUUID, Stage5BrowserError, type UrlExpectation, validateNavigationUrl } from '../dependencies.js';
import { boundedValue } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const handoffHelpersOperations = {
  async authenticationStatus(page: Page | undefined): Promise<AuthenticationStatus> {
    const context = this.usableContext();
    const connected = context !== undefined;
    const handoff = this.authenticationHandoff;
    const pendingRelease = this.pendingHandoffRelease;
    const targetPageIndex = page === undefined || context === undefined
      ? -1
      : context.pages().filter((candidate) => !candidate.isClosed()).indexOf(page);
    const state = handoff?.state ?? pendingRelease?.state ?? (connected ? 'profile_ready' : 'browser_stopped');
    const processState = handoff?.session.state() ?? null;
    const profileBinding = handoff?.launchIdentity.profile
      ?? pendingRelease?.launchIdentity.profile
      ?? this.controlledLaunchIdentity?.profile
      ?? profileBindingForBrowser(
        profileDirForBrowser(this.config, this.selectedBrowser),
        BROWSER_ENGINES[this.selectedBrowser],
      );
    return {
      browser: this.selectedBrowser,
      browserConnected: connected,
      state,
      authenticated: 'unknown',
      persistentProfile: true,
      profileBinding,
      targetOrigin: handoff?.targetOrigin
        ?? pendingRelease?.targetOrigin
        ?? (page === undefined ? null : this.urlOrigin(page.url())),
      requestedAt: handoff?.requestedAt ?? pendingRelease?.requestedAt ?? null,
      resumedAt: handoff?.resumedAt ?? null,
      targetPageIndex: targetPageIndex < 0 ? null : targetPageIndex,
      targetPageAvailable: targetPageIndex >= 0,
      page: page === undefined ? null : await this.pageSummary(page),
      verificationRequired: state === 'ready_for_agent_verification',
      controlMode: handoff?.state === 'awaiting_user' || pendingRelease !== null
        ? 'human_bootstrap'
        : connected
          ? 'playwright'
          : 'none',
      handoffRelease: pendingRelease !== null
        ? {
            strategy: pendingRelease.releaseStrategy,
            phase: 'close_requested',
            closeRequestCompleted: pendingRelease.closeRequestCompleted,
            processReused: null,
            ownershipRetained: true,
          }
        : handoff !== null
          ? {
              strategy: handoff.releaseStrategy,
              phase: 'human_input',
              closeRequestCompleted: handoff.releaseCloseRequestCompleted,
              processReused: handoff.releaseStrategy === 'native_same_process',
              ownershipRetained: true,
            }
          : null,
      humanBootstrap: handoff === null || processState === null
        ? null
        : {
            running: processState.running,
            processId: processState.processId,
            launchedAt: processState.launchedAt,
            controlledByPlaywright:
              connected
              && handoff.state === 'ready_for_agent_verification'
              && handoff.session.controlChannel?.()?.kind === 'chromium_cdp',
            automationFlagsPresent: false,
            exactUserInteractionsObserved: false,
            launchIdentity: handoff.launchIdentity,
            handoffLabel: handoff.handoffLabel,
            profileShutdown: handoff.profileShutdown,
          },
      lastHandoffOutcome: this.lastHandoffOutcome,
    };
  },

  humanBootstrapInProgressError(
    message = 'A private human interaction is in progress for the dedicated Stage5 browser profile.',
  ): Stage5BrowserError {
    const applicationName = this.authenticationHandoff?.launchIdentity.applicationName
      ?? this.pendingHandoffRelease?.launchIdentity.applicationName
      ?? 'the dedicated browser';
    const continuousAttachment = this.authenticationHandoff?.session.controlChannel?.()?.kind === 'chromium_cdp';
    const releasePending = this.pendingHandoffRelease !== null;
    return new Stage5BrowserError('AUTH_HANDOFF_REQUIRED', message, {
      recoverable: true,
      details: {
        reason: releasePending ? 'handoff_release_pending' : 'human_authentication_in_progress',
        phase: this.pendingHandoffRelease?.state ?? this.authenticationHandoff?.state ?? null,
        suggestedAction: releasePending
          ? 'Call browser_request_login_handoff once more to resume the retained close → process exit → profile unlock phase. Do not relaunch the browser, switch backends, or delete profile locks.'
          : continuousAttachment
          ? `Finish authentication in ${applicationName}, leave that exact application open, then call browser_resume_after_login. Stage5 Browser will attach only after that explicit call.`
          : `Finish the private interaction and quit ${applicationName} normally so its process exits, then call browser_resume_after_login. On macOS, use Cmd-Q in that exact application; closing only a tab or window may leave it running. Stage5 Browser will not control or force-close it.`,
      },
    });
  },

  clearControlledBrowserState(): void {
    this.context = undefined;
    this.activePage = undefined;
    this.framesById.clear();
    this.observedTabsById.clear();
    this.discardAllObservedSnapshots();
    this.frameIds = new WeakMap<Frame, string>();
    this.tabIds = new WeakMap<Page, string>();
    this.frameDocumentVersions = new WeakMap<Frame, number>();
    this.boundPages = new WeakSet<Page>();
    this.runtimeProfileObservation = null;
    this.controlledStartBoundary = null;
    this.nativeAttachedBrowser = undefined;
    this.nativeControlRecord = null;
    this.nativeReattachObservation = null;
    this.controlledBrowserProcessId = null;
    this.controlledBrowserProcess = null;
    this.state = 'stopped';
  },

  humanBootstrapTargetUrl(value: string): string {
    if (value === 'about:blank') {
      return value;
    }
    return validateNavigationUrl(value);
  },

  authenticationHandoffLabel(
    identity: BrowserLaunchIdentity,
    targetOrigin: string | null,
  ): string {
    const target = targetOrigin === null ? 'local page' : new URL(targetOrigin).hostname;
    return `Stage5 ${identity.browser} · ${identity.applicationName} · ${target} · ${randomUUID().slice(0, 8).toLocaleUpperCase()}`;
  },

  validateAuthenticationUrlExpectation(expected: UrlExpectation): void {
    try {
      const parsed = new URL(expected.url);
      const originOnly = (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        && (parsed.pathname === '' || parsed.pathname === '/')
        && parsed.search.length === 0
        && parsed.hash.length === 0;
      if (!originOnly) {
        return;
      }
    } catch {
      return;
    }

    throw new Stage5BrowserError(
      'OPERATION_FAILED',
      'An origin-only URL is not strong enough to verify an authentication handoff.',
      {
        recoverable: true,
        details: {
          reason: 'auth_url_expectation_too_weak',
          expected: expected.url,
          match: expected.match,
          suggestedAction: 'Use a post-login path such as an account home route, or pass no URL expectation and verify the returned semantic preview plus a fresh snapshot.',
        },
      },
    );
  },

  async authenticationVerificationPreview(
    page: Page,
  ): Promise<BrowserCommandOutput<'resumeAfterLogin'>['verificationPreview']> {
    const depth = 6;
    const snapshot = await boundedValue(
      page.locator('body').ariaSnapshot({ mode: 'ai', depth, boxes: false, timeout: 1_000 }),
      1_500,
      null,
    );
    if (snapshot === null) {
      return {
        observation: 'bounded_semantic_preview',
        available: false,
        depth,
        snapshot: null,
      };
    }

    const privacyMinimizedSnapshot = snapshot
      .split('\n')
      .filter((line) => !/\b(textbox|searchbox|combobox)\b/i.test(line))
      .slice(0, 200)
      .join('\n')
      .slice(0, 20_000);
    return {
      observation: 'bounded_semantic_preview',
      available: true,
      depth,
      snapshot: privacyMinimizedSnapshot,
    };
  },

  isWebUrl(value: string): boolean {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  },

  async semanticFingerprint(page: Page): Promise<string | null> {
    const snapshot = await boundedValue(
      page.locator('body').ariaSnapshot({ mode: 'ai', depth: 10, boxes: false, timeout: 1_000 }),
      1_500,
      null,
    );
    if (snapshot === null) {
      return null;
    }
    const normalized = snapshot
      .replaceAll(/\[ref=[^\]]+\]/g, '')
      .replaceAll(/\s+/g, ' ')
      .trim()
      .slice(0, 500_000);
    return privacyFingerprint(normalized);
  },

  urlOrigin(value: string): string | null {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
    } catch {
      return null;
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type HandoffHelpersOperations = typeof handoffHelpersOperations;
