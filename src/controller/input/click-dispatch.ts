import { type Browser, inspectTargetState, type Page, type SafeTargetState, type SanitizedActionDiagnostic, type SanitizedClickDispatchEvidence, type SanitizedPageActivationEvidence } from '../dependencies.js';
import { boundedValue, CLICK_REF_DISPATCH_PROBE_GRACE_MS, CLICK_REF_FORCED_DISPATCH_TIMEOUT_MS, CLICK_REF_NORMAL_DISPATCH_TIMEOUT_MS, type ClickDispatchConclusion, type PageActivationObservation, type PreparedObservedClickTarget, remainingUntil } from '../model.js';
import { mergeRawClickDispatchEvidence } from './click-dispatch-evidence.js';
import type { BrowserControllerContext } from '../runtime.js';

export const inputClickDispatchOperations = {
  async dispatchPreparedObservedClick(
    page: Page,
    preparedTarget: PreparedObservedClickTarget,
    startedAt: string,
    actionDeadlineAt: number,
    finalizationDeadlineAt: number,
    action: SanitizedActionDiagnostic['action'],
  ): Promise<SanitizedClickDispatchEvidence> {
    const targetStateWithinDeadline = (fallback: SafeTargetState | null): Promise<SafeTargetState | null> =>
      boundedValue(
        inspectTargetState(preparedTarget.handle),
        Math.max(1, remainingUntil(finalizationDeadlineAt)),
        fallback,
      );
    const probe = await boundedValue(
      this.installExactClickDispatchProbe(
        page,
        preparedTarget.handle,
        remainingUntil(finalizationDeadlineAt) + CLICK_REF_DISPATCH_PROBE_GRACE_MS,
      ),
      Math.max(1, remainingUntil(actionDeadlineAt)),
      null,
    );
    if (probe === null) {
      return this.failClickBeforeDispatch(
        page,
        startedAt,
        await targetStateWithinDeadline(preparedTarget.targetState),
        'unknown',
        'dispatch_probe_install_failed',
        'Stage5 Browser could not install the exact-target dispatch guard before clicking.',
        'Take one fresh semantic snapshot; Stage5 Browser did not dispatch the click.',
        'OPERATION_FAILED',
        action,
      );
    }

    let probeFinished = false;
    let finalEvidence: SanitizedClickDispatchEvidence | null = null;
    let forcedFallbackUsed = false;
    let pageMouseFallbackUsed = false;
    let pageActivation: SanitizedPageActivationEvidence = preparedTarget.pageActivation ?? {
      attemptCount: 0,
      controllerSelected: this.preferredPage() === page,
      bringToFrontAttempted: false,
      bringToFrontSucceeded: false,
      visibilityBefore: 'unknown',
      visibilityAfter: 'unknown',
      documentFocusedBefore: null,
      documentFocusedAfter: null,
      nativeWindow: this.nativeWindowActivationNotRequired(),
    };
    const retainActivationBoundary = (
      next: SanitizedPageActivationEvidence,
    ): SanitizedPageActivationEvidence => pageActivation.attemptCount === 0
      ? next
      : {
          ...next,
          bringToFrontAttempted: pageActivation.bringToFrontAttempted || next.bringToFrontAttempted,
          bringToFrontSucceeded: pageActivation.bringToFrontSucceeded || next.bringToFrontSucceeded,
          visibilityBefore: pageActivation.visibilityBefore,
          documentFocusedBefore: pageActivation.documentFocusedBefore,
          nativeWindow: next.nativeWindow.attempted
            ? next.nativeWindow
            : pageActivation.nativeWindow.attempted
              ? pageActivation.nativeWindow
              : next.nativeWindow,
        };
    const selectedPageRemainsActivated = async (): Promise<boolean> => {
      const controllerSelected = this.preferredPage() === page;
      const observed = controllerSelected
        ? await boundedValue(
          this.observePageActivation(page),
          Math.max(1, remainingUntil(actionDeadlineAt)),
          { documentFocused: null, visibility: 'unknown' } as PageActivationObservation,
        )
        : { documentFocused: null, visibility: 'unknown' } as PageActivationObservation;
      pageActivation = retainActivationBoundary({
        attemptCount: pageActivation.attemptCount,
        controllerSelected,
        bringToFrontAttempted: false,
        bringToFrontSucceeded: false,
        visibilityBefore: observed.visibility,
        visibilityAfter: observed.visibility,
        documentFocusedBefore: observed.documentFocused,
        documentFocusedAfter: observed.documentFocused,
        nativeWindow: pageActivation.nativeWindow,
      });
      return this.pageIsActivatedForInput(pageActivation);
    };
    const readProbe = async (finish: boolean): Promise<SanitizedClickDispatchEvidence | null> => {
      if (finish && probeFinished) {
        return finalEvidence;
      }
      try {
        const raw = await boundedValue(
          probe.controller.evaluate((controller, shouldFinish) =>
            shouldFinish ? controller.finish() : controller.snapshot(), finish),
          Math.max(1, remainingUntil(finish ? finalizationDeadlineAt : actionDeadlineAt)),
          null,
        );
        if (raw === null) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const external = this.externalClickDispatchObservations.get(probe.token)?.evidence ?? null;
        const retained = mergeRawClickDispatchEvidence(raw, external);
        if (retained === null) {
          if (finish) {
            probeFinished = true;
            finalEvidence = null;
          }
          return null;
        }
        const evidence: SanitizedClickDispatchEvidence = {
          ...retained,
          forcedFallbackUsed,
          pageMouseFallbackUsed,
          pageActivation,
        };
        if (finish) {
          probeFinished = true;
          finalEvidence = evidence;
        }
        return evidence;
      } catch {
        if (finish) {
          probeFinished = true;
          finalEvidence = null;
        }
        return null;
      } finally {
        if (finish) {
          this.externalClickDispatchObservations.delete(probe.token);
          await probe.controller.dispose().catch(() => undefined);
        }
      }
    };

    try {
      if (!await selectedPageRemainsActivated()) {
        const evidence = await readProbe(true);
        return this.throwObservedClickDispatchFailure(
          page,
          new Error('The controller-selected page did not remain the visible input target.'),
          await targetStateWithinDeadline(preparedTarget.targetState),
          startedAt,
          evidence,
          action,
        );
      }
      if (remainingUntil(actionDeadlineAt) <= 0) {
        const evidence = await readProbe(true);
        return this.throwObservedClickDispatchFailure(
          page,
          new Error('The click preparation deadline expired before input dispatch.'),
          await targetStateWithinDeadline(preparedTarget.targetState),
          startedAt,
          evidence,
          action,
        );
      }
      const normalAttemptTimeoutMs = Math.max(
        1,
        Math.min(
          CLICK_REF_NORMAL_DISPATCH_TIMEOUT_MS,
          Math.max(1, Math.floor(remainingUntil(actionDeadlineAt) * 0.35)),
        ),
      );
      if (preparedTarget.activation !== 'pointer') {
        let keyboardError: unknown = null;
        try {
          await preparedTarget.handle.press(
            preparedTarget.activation === 'keyboard_space' ? 'Space' : 'Enter',
            {
              noWaitAfter: true,
              timeout: normalAttemptTimeoutMs,
            },
          );
        } catch (error) {
          keyboardError = error;
        }

        const evidence = await readProbe(true);
        if (evidence?.clickOnTarget === true) {
          return evidence;
        }
        const keyboardDispatchObserved = evidence === null
          ? 'unknown'
          : evidence.guardExpired && !evidence.trustedEventObserved
            ? 'unknown'
            : evidence.keyDownOnTarget || evidence.keyUpOnTarget;
        const conclusion: ClickDispatchConclusion = {
          actionDispatched: keyboardDispatchObserved,
          clickDispatched: evidence === null ? 'unknown' : false,
        };
        return this.throwObservedClickDispatchFailure(
          page,
          keyboardError ?? new Error('The exact popup activation returned without a confirmed trusted target click event.'),
          await targetStateWithinDeadline(preparedTarget.targetState),
          startedAt,
          evidence,
          action,
          conclusion,
        );
      }

      let normalError: unknown = null;
      const normalPosition = preparedTarget.targetState.pointerHitPoint === 'alternate'
        ? await boundedValue(
          this.freshExactHandleClickPosition(preparedTarget.handle),
          Math.max(1, remainingUntil(actionDeadlineAt)),
          null,
        )
        : undefined;
      if (preparedTarget.targetState.pointerHitPoint === 'alternate' && normalPosition === null) {
        normalError = new Error('The alternate exact-target hit point was no longer available before dispatch.');
      } else {
        try {
          await this.dispatchExactHandleClick(preparedTarget.handle, {
            noWaitAfter: true,
            timeout: normalAttemptTimeoutMs,
            ...(normalPosition === undefined || normalPosition === null ? {} : { position: normalPosition }),
          });
        } catch (error) {
          normalError = error;
        }
      }

      let evidence = await readProbe(false);
      if (normalError === null) {
        evidence = await readProbe(true);
        if (evidence?.clickOnTarget === true) return evidence;
        return this.throwObservedClickDispatchFailure(
          page,
          new Error('The exact-target click returned without a confirmed trusted target click event.'),
          await targetStateWithinDeadline(preparedTarget.targetState),
          startedAt,
          evidence,
          action,
        );
      }
      if (evidence?.clickOnTarget === true) {
        const completedEvidence = await readProbe(true);
        if (completedEvidence !== null) return completedEvidence;
        return this.throwObservedClickDispatchFailure(
          page,
          new Error('The target click was observed, but final dispatch evidence could not be retained.'),
          await targetStateWithinDeadline(preparedTarget.targetState),
          startedAt,
          null,
          action,
        );
      }

      const targetState = await targetStateWithinDeadline(null);
      if (!this.canUseForcedClickFallback(evidence, targetState, normalError)) {
        evidence = await readProbe(true);
        return this.throwObservedClickDispatchFailure(
          page,
          normalError,
          targetState ?? preparedTarget.targetState,
          startedAt,
          evidence,
          action,
        );
      }
      if (remainingUntil(actionDeadlineAt) <= 0) {
        evidence = await readProbe(true);
        return this.throwObservedClickDispatchFailure(
          page,
          normalError,
          targetState ?? preparedTarget.targetState,
          startedAt,
          evidence,
          action,
        );
      }

      if (!await selectedPageRemainsActivated()) {
        evidence = await readProbe(true);
        return this.throwObservedClickDispatchFailure(
          page,
          new Error('The controller-selected page lost visible activation before guarded fallback input.'),
          await targetStateWithinDeadline(targetState ?? preparedTarget.targetState),
          startedAt,
          evidence,
          action,
        );
      }
      forcedFallbackUsed = true;
      const remainingTimeoutMs = Math.max(
        1,
        Math.min(
          CLICK_REF_FORCED_DISPATCH_TIMEOUT_MS,
          remainingUntil(actionDeadlineAt),
        ),
      );
      let forcedError: unknown = null;
      const forcedPosition = targetState?.pointerHitPoint === 'alternate'
        ? await boundedValue(
          this.freshExactHandleClickPosition(preparedTarget.handle),
          Math.max(1, remainingUntil(actionDeadlineAt)),
          null,
        )
        : undefined;
      if (targetState?.pointerHitPoint === 'alternate' && forcedPosition === null) {
        forcedError = new Error('The alternate exact-target hit point was no longer available before guarded fallback dispatch.');
      } else {
        try {
          await this.dispatchExactHandleClick(preparedTarget.handle, {
            force: true,
            noWaitAfter: true,
            timeout: remainingTimeoutMs,
            ...(forcedPosition === undefined || forcedPosition === null ? {} : { position: forcedPosition }),
          });
        } catch (error) {
          forcedError = error;
        }
      }

      evidence = await readProbe(false);
      if (evidence?.clickOnTarget === true) {
        const completedEvidence = await readProbe(true);
        if (completedEvidence !== null) return completedEvidence;
        return this.throwObservedClickDispatchFailure(
          page,
          new Error('The guarded fallback click was observed, but final dispatch evidence could not be retained.'),
          await targetStateWithinDeadline(preparedTarget.targetState),
          startedAt,
          null,
          action,
        );
      }
      if (forcedError === null && evidence === null) {
        const completedEvidence = await readProbe(true);
        return this.throwObservedClickDispatchFailure(
          page,
          new Error('The guarded fallback returned without definite dispatch evidence.'),
          await targetStateWithinDeadline(preparedTarget.targetState),
          startedAt,
          completedEvidence,
          action,
        );
      }

      const directTargetState = await targetStateWithinDeadline(null);
      if (!this.canUsePageMouseFallback(evidence, directTargetState)) {
        evidence = await readProbe(true);
        return this.throwObservedClickDispatchFailure(
          page,
          forcedError ?? new Error('The guarded exact-handle fallback did not emit a target click event.'),
          directTargetState ?? targetState ?? preparedTarget.targetState,
          startedAt,
          evidence,
          action,
        );
      }
      if (remainingUntil(actionDeadlineAt) <= 0) {
        evidence = await readProbe(true);
        return this.throwObservedClickDispatchFailure(
          page,
          forcedError ?? new Error('The guarded fallback deadline expired before page-level input.'),
          directTargetState ?? targetState ?? preparedTarget.targetState,
          startedAt,
          evidence,
          action,
        );
      }

      const point = await selectedPageRemainsActivated()
        ? await boundedValue(
          this.freshMainFrameTargetPoint(page, preparedTarget.handle),
          Math.max(1, remainingUntil(actionDeadlineAt)),
          null,
        )
        : null;
      if (point === null) {
        evidence = await readProbe(true);
        return this.throwObservedClickDispatchFailure(
          page,
          new Error('The controller-selected page or exact main-frame target was not ready for guarded page input.'),
          await targetStateWithinDeadline(directTargetState ?? preparedTarget.targetState),
          startedAt,
          evidence,
          action,
        );
      }

      pageMouseFallbackUsed = true;
      let pageMouseError: unknown = null;
      try {
        const completed = await boundedValue(
          page.mouse.click(point.x, point.y, {
            button: 'left',
            clickCount: 1,
            delay: 0,
          }).then(() => true),
          Math.max(1, remainingUntil(actionDeadlineAt)),
          false,
        );
        if (!completed) {
          pageMouseError = new Error('Page-level input exceeded the action deadline.');
        }
      } catch (error) {
        pageMouseError = error;
      }

      evidence = await readProbe(true);
      if (evidence?.clickOnTarget === true) {
        return evidence;
      }
      if (pageMouseError === null && evidence === null) {
        return this.throwObservedClickDispatchFailure(
          page,
          new Error('Page-level input returned without definite dispatch evidence.'),
          await targetStateWithinDeadline(preparedTarget.targetState),
          startedAt,
          null,
          action,
        );
      }
      return this.throwObservedClickDispatchFailure(
        page,
        pageMouseError ?? new Error('The guarded page-level fallback did not emit a target click event.'),
        await targetStateWithinDeadline(directTargetState ?? targetState ?? preparedTarget.targetState),
        startedAt,
        evidence,
        action,
      );
    } finally {
      if (!probeFinished) {
        await readProbe(true);
      }
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type InputClickDispatchOperations = typeof inputClickDispatchOperations;
