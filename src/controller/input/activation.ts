import { type Browser, type BrowserContext, type ElementHandle, type Page, type SanitizedClickDispatchEvidence, type SanitizedNativeWindowActivationEvidence, type SanitizedPageActivationEvidence, Stage5BrowserError } from '../dependencies.js';
import { boundedValue, type ChromiumTargetWindowPreparation, CLICK_REF_REBIND_SETTLE_MS, NATIVE_WINDOW_ACTIVATION_TIMEOUT_MS, NATIVE_WINDOW_NORMALIZATION_WAIT_MS, NATIVE_WINDOW_VISIBILITY_POLL_MS, NATIVE_WINDOW_VISIBILITY_WAIT_MS, type PageActivationObservation, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const inputActivationOperations = {
  async dispatchExactHandleClick(
    handle: ElementHandle<HTMLElement | SVGElement>,
    options: {
      force?: boolean;
      noWaitAfter: boolean;
      timeout: number;
      position?: { x: number; y: number };
    },
  ): Promise<void> {
    await handle.click(options);
  },

  async dispatchExactHandleFill(
    handle: ElementHandle<HTMLElement>,
    value: string,
    timeoutMs: number,
  ): Promise<void> {
    await handle.fill(value, { timeout: timeoutMs });
  },

  async activateSelectedPageForInput(
    page: Page,
    attemptCount: number,
    priorNativeWindow?: SanitizedNativeWindowActivationEvidence,
  ): Promise<SanitizedPageActivationEvidence> {
    const before = await this.observePageActivation(page);
    const controllerSelected = this.preferredPage() === page;
    if (controllerSelected && before.visibility === 'visible') {
      return {
        attemptCount,
        controllerSelected,
        bringToFrontAttempted: false,
        bringToFrontSucceeded: false,
        visibilityBefore: before.visibility,
        visibilityAfter: before.visibility,
        documentFocusedBefore: before.documentFocused,
        documentFocusedAfter: before.documentFocused,
        nativeWindow: priorNativeWindow?.attempted === true
          ? priorNativeWindow
          : this.nativeWindowActivationNotRequired(),
      };
    }
    let bringToFrontSucceeded = false;
    try {
      await page.bringToFront();
      bringToFrontSucceeded = true;
    } catch {
      bringToFrontSucceeded = false;
    }
    let after = await this.observePageActivation(page);
    let nativeWindow = priorNativeWindow?.attempted === true
      ? priorNativeWindow
      : this.nativeWindowActivationNotRequired();
    if (
      controllerSelected &&
      bringToFrontSucceeded &&
      after.visibility !== 'visible'
    ) {
      nativeWindow = await this.activateOwnedNativeWindow(page);
      const applicationReadyForRendererSelection =
        nativeWindow.applicationHiddenAfter === false &&
        (nativeWindow.activationRequestAccepted === true ||
          nativeWindow.applicationFrontmostAfter === true);
      if (applicationReadyForRendererSelection) {
        try {
          await page.bringToFront();
        } catch {
          bringToFrontSucceeded = false;
        }
      }
      after = await this.waitForVisiblePageActivation(page, after);
      if (after.visibility === 'visible') {
        nativeWindow = { ...nativeWindow, result: 'activated' };
      } else if (nativeWindow.result === 'activated' || applicationReadyForRendererSelection) {
        nativeWindow = { ...nativeWindow, result: 'visibility_unchanged' };
      }
    }
    return {
      attemptCount,
      controllerSelected,
      bringToFrontAttempted: true,
      bringToFrontSucceeded,
      visibilityBefore: before.visibility,
      visibilityAfter: after.visibility,
      documentFocusedBefore: before.documentFocused,
      documentFocusedAfter: after.documentFocused,
      nativeWindow,
    };
  },

  nativeWindowActivationNotRequired(): SanitizedNativeWindowActivationEvidence {
    const supported = !this.config.headless &&
      this.controlledLaunchIdentity?.engine === 'chromium' &&
      this.nativeWindowActivator.supported;
    return {
      required: false,
      attempted: false,
      supported,
      ownedProcessAvailable: this.controlledBrowserProcessId !== null,
      ownedProcessRunning: null,
      targetWindowResolved: null,
      windowStateBefore: 'unknown',
      normalizationAttempted: false,
      normalizationSucceeded: null,
      applicationActivationAttempted: false,
      applicationActivationSucceeded: null,
      applicationHiddenBefore: null,
      unhideAttempted: false,
      unhideSucceeded: null,
      activationRequestAccepted: null,
      frontProcessFallbackAttempted: false,
      frontProcessFallbackProcessResolved: null,
      frontProcessFallbackRequestSucceeded: null,
      applicationFrontmostAfter: null,
      applicationHiddenAfter: null,
      result: 'not_required',
    };
  },

  async activateOwnedNativeWindow(
    page: Page,
  ): Promise<SanitizedNativeWindowActivationEvidence> {
    const supported = !this.config.headless &&
      this.controlledLaunchIdentity?.engine === 'chromium' &&
      this.nativeWindowActivator.supported;
    const base: SanitizedNativeWindowActivationEvidence = {
      required: true,
      attempted: true,
      supported,
      ownedProcessAvailable: this.controlledBrowserProcessId !== null,
      ownedProcessRunning: null,
      targetWindowResolved: null,
      windowStateBefore: 'unknown',
      normalizationAttempted: false,
      normalizationSucceeded: null,
      applicationActivationAttempted: false,
      applicationActivationSucceeded: null,
      applicationHiddenBefore: null,
      unhideAttempted: false,
      unhideSucceeded: null,
      activationRequestAccepted: null,
      frontProcessFallbackAttempted: false,
      frontProcessFallbackProcessResolved: null,
      frontProcessFallbackRequestSucceeded: null,
      applicationFrontmostAfter: null,
      applicationHiddenAfter: null,
      result: 'native_activation_unsupported',
    };
    if (this.config.headless) {
      return { ...base, result: 'headless_not_applicable' };
    }
    if (this.controlledLaunchIdentity?.engine !== 'chromium') {
      return base;
    }
    const processId = this.controlledBrowserProcessId;
    if (processId === null) {
      return { ...base, result: 'owned_process_unavailable' };
    }

    const prepared = await this.prepareChromiumTargetWindow(page);
    const withWindow: SanitizedNativeWindowActivationEvidence = {
      ...base,
      targetWindowResolved: prepared.targetWindowResolved,
      windowStateBefore: prepared.windowStateBefore,
      normalizationAttempted: prepared.normalizationAttempted,
      normalizationSucceeded: prepared.normalizationSucceeded,
    };
    if (!prepared.targetWindowResolved) {
      return { ...withWindow, result: 'target_window_unavailable' };
    }
    if (prepared.normalizationAttempted && prepared.normalizationSucceeded !== true) {
      return { ...withWindow, result: 'window_normalization_failed' };
    }

    const activated = await this.nativeWindowActivator.activateOwnedProcess(
      processId,
      NATIVE_WINDOW_ACTIVATION_TIMEOUT_MS,
    );
    return {
      ...withWindow,
      supported: activated.supported,
      ownedProcessRunning: activated.ownedProcessRunning,
      applicationActivationAttempted: activated.attempted,
      applicationActivationSucceeded: activated.applicationActivated,
      applicationHiddenBefore: activated.applicationHiddenBefore,
      unhideAttempted: activated.unhideAttempted,
      unhideSucceeded: activated.unhideSucceeded,
      activationRequestAccepted: activated.activationRequestAccepted,
      frontProcessFallbackAttempted: activated.frontProcessFallbackAttempted,
      frontProcessFallbackProcessResolved: activated.frontProcessFallbackProcessResolved,
      frontProcessFallbackRequestSucceeded: activated.frontProcessFallbackRequestSucceeded,
      applicationFrontmostAfter: activated.applicationFrontmostAfter,
      applicationHiddenAfter: activated.applicationHiddenAfter,
      result: activated.applicationActivated
        ? 'activated'
        : activated.reason === 'owned_process_not_running'
          ? 'owned_process_not_running'
          : activated.reason === 'platform_unsupported'
            ? 'native_activation_unsupported'
            : activated.reason === 'activation_state_unverified'
              ? 'application_activation_unverified'
              : 'application_activation_failed',
    };
  },

  async prepareChromiumTargetWindow(
    page: Page,
  ): Promise<ChromiumTargetWindowPreparation> {
    const unavailable: ChromiumTargetWindowPreparation = {
      targetWindowResolved: false,
      windowStateBefore: 'unknown',
      normalizationAttempted: false,
      normalizationSucceeded: null,
    };
    let session: Awaited<ReturnType<BrowserContext['newCDPSession']>> | null = null;
    try {
      session = await page.context().newCDPSession(page);
      const observed = await session.send('Browser.getWindowForTarget') as {
        windowId?: unknown;
        bounds?: { windowState?: unknown };
      };
      if (
        typeof observed.windowId !== 'number' ||
        !Number.isSafeInteger(observed.windowId) ||
        observed.windowId < 0
      ) {
        return unavailable;
      }
      const observedState = observed.bounds?.windowState;
      const windowStateBefore = observedState === 'fullscreen' ||
        observedState === 'maximized' ||
        observedState === 'minimized' ||
        observedState === 'normal'
        ? observedState
        : 'unknown';
      if (windowStateBefore !== 'minimized') {
        return {
          targetWindowResolved: true,
          windowStateBefore,
          normalizationAttempted: false,
          normalizationSucceeded: null,
        };
      }
      try {
        await session.send('Browser.setWindowBounds', {
          windowId: observed.windowId,
          bounds: { windowState: 'normal' },
        });
        let normalizationSucceeded = false;
        const deadline = Date.now() + NATIVE_WINDOW_NORMALIZATION_WAIT_MS;
        while (!normalizationSucceeded && Date.now() < deadline) {
          const normalized = await session.send('Browser.getWindowForTarget') as {
            bounds?: { windowState?: unknown };
          };
          normalizationSucceeded = normalized.bounds?.windowState !== 'minimized';
          if (!normalizationSucceeded) {
            await new Promise((resolve) => setTimeout(
              resolve,
              Math.min(NATIVE_WINDOW_VISIBILITY_POLL_MS, Math.max(1, deadline - Date.now())),
            ));
          }
        }
        return {
          targetWindowResolved: true,
          windowStateBefore,
          normalizationAttempted: true,
          normalizationSucceeded,
        };
      } catch {
        return {
          targetWindowResolved: true,
          windowStateBefore,
          normalizationAttempted: true,
          normalizationSucceeded: false,
        };
      }
    } catch {
      return unavailable;
    } finally {
      await session?.detach().catch(() => undefined);
    }
  },

  async waitForVisiblePageActivation(
    page: Page,
    initial: PageActivationObservation,
    maximumWaitMs = NATIVE_WINDOW_VISIBILITY_WAIT_MS,
  ): Promise<PageActivationObservation> {
    let observed = initial;
    const deadline = Date.now() + Math.min(
      NATIVE_WINDOW_VISIBILITY_WAIT_MS,
      Math.max(0, maximumWaitMs),
    );
    while (observed.visibility !== 'visible' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(NATIVE_WINDOW_VISIBILITY_POLL_MS, Math.max(1, deadline - Date.now())),
      ));
      observed = await this.observePageActivation(page);
    }
    return observed;
  },

  async observePageActivation(page: Page): Promise<PageActivationObservation> {
    const observed = await boundedValue<PageActivationObservation>(
      page.evaluate(() => ({
        documentFocused: document.hasFocus(),
        visibility: document.visibilityState,
      }) as PageActivationObservation),
      300,
      { documentFocused: null, visibility: 'unknown' },
    );
    const visibility = observed.visibility === 'hidden' ||
      observed.visibility === 'visible' ||
      observed.visibility === 'prerender'
      ? observed.visibility
      : 'unknown';
    return {
      documentFocused: typeof observed.documentFocused === 'boolean' ? observed.documentFocused : null,
      visibility,
    };
  },

  pageIsActivatedForInput(evidence: SanitizedPageActivationEvidence): boolean {
    return evidence.controllerSelected &&
      (!evidence.bringToFrontAttempted || evidence.bringToFrontSucceeded) &&
      evidence.visibilityAfter === 'visible';
  },

  canRecoverDispatchTimeActivationLoss(
    error: unknown,
    actionDeadlineAt: number,
  ): error is Stage5BrowserError {
    if (
      remainingUntil(actionDeadlineAt) <= CLICK_REF_REBIND_SETTLE_MS ||
      !(error instanceof Stage5BrowserError) ||
      error.code !== 'OPERATION_FAILED' ||
      error.details?.reason !== 'page_not_active' ||
      error.details.actionDispatched !== false ||
      error.details.clickDispatched !== false
    ) {
      return false;
    }
    const rawEvidence = error.details.dispatchEvidence;
    if (rawEvidence === null || typeof rawEvidence !== 'object') return false;
    const evidence = rawEvidence as Partial<SanitizedClickDispatchEvidence>;
    return evidence.guardExpired === false &&
      evidence.trustedEventObserved === false &&
      evidence.keyDownOnTarget === false &&
      evidence.keyUpOnTarget === false &&
      evidence.pointerDownOnTarget === false &&
      evidence.mouseDownOnTarget === false &&
      evidence.pointerUpOnTarget === false &&
      evidence.mouseUpOnTarget === false &&
      evidence.clickOnTarget === false &&
      evidence.misdirectedEventBlocked === false &&
      evidence.targetStateChangeBlocked === false;
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type InputActivationOperations = typeof inputActivationOperations;
