import { type Browser, type ClickPostcondition, inspectTargetState, type Locator, type Page, type SafeTargetState, type SanitizedActionDiagnostic, type SanitizedNativeWindowActivationEvidence, type SanitizedPageActivationEvidence, sanitizeUrlForJournal, Stage5BrowserError } from '../dependencies.js';
import { boundedValue, CLICK_REF_INCREMENTAL_SETTLE_MS, CLICK_REF_REBIND_SETTLE_MS, CLICK_ROLE_RESOLUTION_TIMEOUT_MS, type PageActivationObservation, type PreparedObservedClickTarget, remainingUntil, SCREENSHOT_MIN_COMPRESSED_BYTES_PER_PIXEL } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import type { ClickActivationPolicy } from '../action/click-plan.js';

export const inputClickTargetOperations = {
  async requireUniqueClickTarget(
    page: Page,
    locator: Locator,
    action: SanitizedActionDiagnostic['action'],
    role: string,
    name: string,
    timeoutMs: number,
  ): Promise<SafeTargetState | null> {
    const startedAt = Date.now();
    const deadline = startedAt + Math.min(timeoutMs, CLICK_ROLE_RESOLUTION_TIMEOUT_MS);
    const countWithinDeadline = (): Promise<number> => boundedValue(
      locator.count(),
      Math.max(1, deadline - Date.now()),
      -1,
    );
    let count = await countWithinDeadline();
    while (count === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
      count = await countWithinDeadline();
    }
    if (count === -1) {
      this.pageDiagnostics.recordAction(
        page,
        this.targetingFailureDiagnostic(action, page, 'target_missing'),
      );
      throw new Stage5BrowserError('OPERATION_FAILED', 'Role resolution exceeded the shared click deadline before any input was dispatched.', {
        recoverable: true,
        details: {
          role,
          name,
          reason: 'role_resolution_deadline_expired',
          actionDispatched: false,
          clickDispatched: false,
          resolutionWaitMs: Date.now() - startedAt,
          suggestedAction: 'Take one fresh semantic snapshot; Stage5 Browser confirmed that no click was dispatched.',
        },
      });
    }
    if (count === 0) {
      this.pageDiagnostics.recordAction(
        page,
        this.targetingFailureDiagnostic(action, page, 'target_missing'),
      );
      throw new Stage5BrowserError('TARGET_NOT_FOUND', 'No element matched the requested role and accessible name.', {
        recoverable: true,
        details: {
          role,
          name,
          actionDispatched: false,
          clickDispatched: false,
          resolutionWaitMs: Date.now() - startedAt,
          suggestedAction: 'The role action emitted no input. Take a fresh semantic snapshot because any visible state change came from earlier or autonomous page activity.',
        },
      });
    }
    if (count > 1) {
      this.pageDiagnostics.recordAction(
        page,
        this.targetingFailureDiagnostic(action, page, 'ambiguous_target'),
      );
      throw new Stage5BrowserError('AMBIGUOUS_TARGET', 'Multiple elements matched; Stage5 Browser will not choose one arbitrarily.', {
        details: { role, name, matchCount: count },
      });
    }
    return boundedValue(
      inspectTargetState(locator),
      Math.max(1, timeoutMs - (Date.now() - startedAt)),
      null,
    );
  },

  screenshotArtifactClassification(data: Buffer): 'contentful' | 'possibly_uniform' {
    const pngSignature = '89504e470d0a1a0a';
    if (data.byteLength < 24 || data.subarray(0, 8).toString('hex') !== pngSignature) {
      return 'possibly_uniform';
    }
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    const pixelCount = width * height;
    if (!Number.isSafeInteger(pixelCount) || pixelCount <= 0) {
      return 'possibly_uniform';
    }
    return data.byteLength / pixelCount >= SCREENSHOT_MIN_COMPRESSED_BYTES_PER_PIXEL
      ? 'contentful'
      : 'possibly_uniform';
  },

  async prepareRoleClickTarget(
    page: Page,
    locator: Locator,
    startedAt: string,
    actionDeadlineAt: number,
    role: string,
    name: string,
    postcondition: ClickPostcondition | null,
    activationAttemptCount = 1,
    priorNativeWindow?: SanitizedNativeWindowActivationEvidence,
    activationPolicy: ClickActivationPolicy = postcondition === null
      ? 'pointer_only'
      : 'postconditioned_native_keyboard',
  ): Promise<PreparedObservedClickTarget> {
    let lastTargetState = await this.requireUniqueClickTarget(
      page,
      locator,
      'click_by_role',
      role,
      name,
      remainingUntil(actionDeadlineAt),
    );
    const pageActivation = await this.primeSelectedPageForTargetPreparation(
      page,
      actionDeadlineAt,
      startedAt,
      'click_by_role',
      activationAttemptCount,
      priorNativeWindow,
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      lastTargetState = await this.requireUniqueClickTarget(
        page,
        locator,
        'click_by_role',
        role,
        name,
        remainingUntil(actionDeadlineAt),
      );
      const handle = await boundedValue(
        locator.elementHandle(),
        Math.max(1, remainingUntil(actionDeadlineAt)),
        null,
      );
      if (handle === null) {
        if (attempt === 0 && remainingUntil(actionDeadlineAt) > 0) {
          continue;
        }
        return this.failClickBeforeDispatch(
          page,
          startedAt,
          lastTargetState,
          'detached',
          'role_target_detached_before_dispatch',
          'The uniquely matched role target detached before exact-target dispatch began.',
          'Take one fresh semantic snapshot; Stage5 Browser confirmed that no input was dispatched.',
          'TARGET_NOT_FOUND',
          'click_by_role',
        );
      }

      try {
        await locator.scrollIntoViewIfNeeded({
          timeout: Math.max(1, remainingUntil(actionDeadlineAt)),
        });
      } catch {
        // The exact handle is inspected below; failure remains pre-dispatch.
      }
      const postScrollSettleMs = Math.min(
        CLICK_REF_INCREMENTAL_SETTLE_MS,
        remainingUntil(actionDeadlineAt),
      );
      if (postScrollSettleMs > 0) {
        await page.waitForTimeout(postScrollSettleMs);
      }
      const targetState = await boundedValue(
        inspectTargetState(handle),
        Math.max(1, remainingUntil(actionDeadlineAt)),
        null,
      );
      if (targetState === null) {
        await handle.dispose().catch(() => undefined);
        if (attempt === 0 && remainingUntil(actionDeadlineAt) > 0) {
          const settleMs = Math.min(CLICK_REF_INCREMENTAL_SETTLE_MS, remainingUntil(actionDeadlineAt));
          if (settleMs > 0) await page.waitForTimeout(settleMs);
          continue;
        }
        return this.failClickBeforeDispatch(
          page,
          startedAt,
          lastTargetState,
          'detached',
          'role_target_detached_before_dispatch',
          'The uniquely matched role target detached during pre-input viewport preparation.',
          'Take one fresh semantic snapshot; Stage5 Browser confirmed that no input was dispatched.',
          'TARGET_NOT_FOUND',
          'click_by_role',
        );
      }

      const activation = await this.preferredObservedClickActivation(
        handle,
        actionDeadlineAt,
        postcondition,
        activationPolicy,
        targetState.receivesPointerEvents,
      );
      const postconditionedKeyboardActivation = activation !== 'pointer';
      const failure = !targetState.visible || (!targetState.inViewport && !postconditionedKeyboardActivation)
        ? { diagnostic: 'not_visible' as const }
        : !targetState.enabled
          ? { diagnostic: 'not_enabled' as const }
          : targetState.receivesPointerEvents === false && !postconditionedKeyboardActivation
            ? { diagnostic: 'pointer_intercepted' as const }
            : null;
      if (failure !== null) {
        await handle.dispose().catch(() => undefined);
        return this.failClickBeforeDispatch(
          page,
          startedAt,
          targetState,
          failure.diagnostic,
          failure.diagnostic,
          'The uniquely matched role target was not safely actionable before exact-target dispatch.',
          'Take a fresh semantic snapshot and resolve the reported target state before another click.',
          'OPERATION_FAILED',
          'click_by_role',
        );
      }

      return {
        locator,
        handle,
        targetState,
        activation,
        pageActivation,
        viewportPreparation: null,
      };
    }

    return this.failClickBeforeDispatch(
      page,
      startedAt,
      lastTargetState,
      'detached',
      'role_target_detached_before_dispatch',
      'The uniquely matched role target could not be retained through pre-input preparation.',
      'Take one fresh semantic snapshot; Stage5 Browser confirmed that no input was dispatched.',
      'TARGET_NOT_FOUND',
      'click_by_role',
    );
  },

  async primeSelectedPageForTargetPreparation(
    page: Page,
    actionDeadlineAt: number,
    startedAt: string,
    action: SanitizedActionDiagnostic['action'],
    attemptCount = 1,
    priorNativeWindow?: SanitizedNativeWindowActivationEvidence,
  ): Promise<SanitizedPageActivationEvidence> {
    let pageActivation = await boundedValue(
      this.activateSelectedPageForInput(page, attemptCount, priorNativeWindow),
      Math.max(1, remainingUntil(actionDeadlineAt)),
      {
        attemptCount,
        controllerSelected: this.preferredPage() === page,
        bringToFrontAttempted: false,
        bringToFrontSucceeded: false,
        visibilityBefore: 'unknown',
        visibilityAfter: 'unknown',
        documentFocusedBefore: null,
        documentFocusedAfter: null,
        nativeWindow: priorNativeWindow?.attempted === true
          ? priorNativeWindow
          : this.nativeWindowActivationNotRequired(),
      },
    );
    const failBeforeTargetPreparation = (
      reason: string,
      message: string,
      suggestedAction: string,
    ): never => {
      const diagnostic: SanitizedActionDiagnostic = {
        action,
        outcome: 'blocked',
        reason: 'page_not_active',
        actionDispatched: false,
        clickDispatched: false,
        targetState: null,
        pageUrl: sanitizeUrlForJournal(page.url()) ?? null,
        startedAt,
        occurredAt: new Date().toISOString(),
      };
      this.pageDiagnostics.recordAction(page, diagnostic);
      throw new Stage5BrowserError('OPERATION_FAILED', message, {
        recoverable: true,
        details: {
          reason,
          actionDispatched: false,
          clickDispatched: false,
          pageActivation,
          suggestedAction,
        },
      });
    };

    if (!this.pageIsActivatedForInput(pageActivation)) {
      failBeforeTargetPreparation(
        'page_not_active',
        'The selected page could not become visible before target preparation.',
        'Inspect the selected tab and renderer visibility; Stage5 Browser did not resolve or dispatch the target action.',
      );
    }

    const activationCrossedBoundary = pageActivation.bringToFrontAttempted ||
      pageActivation.nativeWindow.attempted ||
      pageActivation.visibilityBefore !== pageActivation.visibilityAfter ||
      pageActivation.documentFocusedBefore !== pageActivation.documentFocusedAfter;
    if (!activationCrossedBoundary) return pageActivation;

    if (remainingUntil(actionDeadlineAt) < CLICK_REF_REBIND_SETTLE_MS) {
      failBeforeTargetPreparation(
        'page_activation_settle_deadline_expired',
        'The selected page became visible too late to settle before target preparation.',
        'Take one fresh semantic snapshot with a longer action timeout; Stage5 Browser did not resolve or dispatch the target action.',
      );
    }
    const settled = await boundedValue(
      page.waitForTimeout(CLICK_REF_REBIND_SETTLE_MS).then(() => true),
      Math.max(1, remainingUntil(actionDeadlineAt)),
      false,
    );
    if (!settled || remainingUntil(actionDeadlineAt) <= 0) {
      failBeforeTargetPreparation(
        'page_activation_settle_deadline_expired',
        'The selected page did not finish settling before the target-preparation deadline.',
        'Take one fresh semantic snapshot with a longer action timeout; Stage5 Browser did not resolve or dispatch the target action.',
      );
    }

    const settledObservation = await boundedValue(
      this.observePageActivation(page),
      Math.max(1, remainingUntil(actionDeadlineAt)),
      { documentFocused: null, visibility: 'unknown' } as PageActivationObservation,
    );
    pageActivation = {
      ...pageActivation,
      controllerSelected: this.preferredPage() === page,
      visibilityAfter: settledObservation.visibility,
      documentFocusedAfter: settledObservation.documentFocused,
    };
    if (!this.pageIsActivatedForInput(pageActivation)) {
      failBeforeTargetPreparation(
        'page_not_active_after_activation_settle',
        'The selected page lost visible activation while settling before target preparation.',
        'Inspect the selected tab and renderer visibility, then take one fresh semantic snapshot; Stage5 Browser did not resolve or dispatch the target action.',
      );
    }
    return pageActivation;
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type InputClickTargetOperations = typeof inputClickTargetOperations;
