import { type ControlRevealMethod, type ControlTarget, type ElementHandle, type Frame, type Locator, type Page, type PostconditionResult, type SanitizedNativeWindowActivationEvidence, Stage5BrowserError } from '../dependencies.js';
import { boundedValue, type ObservedControlPopupSurface, type PreparedObservedClickTarget, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import type { ClickActivationPolicy } from '../action/click-plan.js';
import type { ControlPopupAssociation } from './popup-association.js';
import { renderedControlPopupSurfaceCount } from './popup-surfaces.js';
import { disposePopupSurfaces, inspectPopupSurfaceSetRendering } from './popup-set.js';

export interface ControlPopupRevealEvidence {
  zeroRenderedSurfaceBaseline: boolean;
}

export interface ControlPopupRevealResult {
  actionDispatched: boolean | 'unknown';
}

export const controlRevealOperations = {
  async revealControlPopup(
    page: Page,
    frame: Frame,
    controlLocator: Locator,
    controlHandle: ElementHandle<HTMLElement>,
    control: ControlTarget,
    interaction: ControlRevealMethod,
    documentVersion: number,
    deadlineAt: number,
    evidence: ControlPopupRevealEvidence,
  ): Promise<ControlPopupRevealResult> {
    if (interaction === 'keyboard') {
      return this.revealControlPopupWithKeyboard(
        page,
        frame,
        controlLocator,
        controlHandle,
        control,
        documentVersion,
        deadlineAt,
        evidence,
      );
    }
    const result = await this.executeClickAction({
      action: 'click_by_role',
      timeoutMs: Math.max(1, remainingUntil(deadlineAt)),
      observe: async () => ({ page, frame }),
      plan: () => ({
        action: 'click_by_role',
        activationPolicy: 'postconditioned_native_keyboard_fallback',
        page,
        frame,
        postcondition: null,
        prepare: async (
          priorNativeActivation: SanitizedNativeWindowActivationEvidence | null,
          activationAttemptCount: number,
          actionStartedAt: string,
          actionDeadlineAt: number,
          activationPolicy: ClickActivationPolicy,
        ): Promise<PreparedObservedClickTarget> => {
          const pageActivation = await this.primeSelectedPageForTargetPreparation(
            page,
            actionDeadlineAt,
            actionStartedAt,
            'click_by_role',
            activationAttemptCount,
            priorNativeActivation ?? undefined,
          );
          const prepared = await this.prepareObservedClickTarget(
            page,
            frame,
            controlLocator,
            actionStartedAt,
            actionDeadlineAt,
            null,
            pageActivation,
            controlHandle,
            activationPolicy,
          );
          const renderedSurfaceCount = await renderedControlPopupSurfaceCount(
            frame,
            actionDeadlineAt,
          );
          if (renderedSurfaceCount !== 0) {
            await prepared.handle.dispose().catch(() => undefined);
            throw new Stage5BrowserError(
              renderedSurfaceCount === null ? 'AMBIGUOUS_TARGET' : 'OPERATION_FAILED',
              'The popup environment changed during reversible opener preparation.',
              {
                recoverable: true,
                details: {
                  reason: renderedSurfaceCount === null
                    ? 'popup_surface_baseline_unknown_before_reveal'
                    : 'popup_surface_present_before_reveal',
                  actionDispatched: false,
                  renderedPopupCount: renderedSurfaceCount,
                  suggestedAction: 'Inspect the current control state passively. No opener input was dispatched.',
                },
              },
            );
          }
          evidence.zeroRenderedSurfaceBaseline = true;
          return prepared;
        },
        reconciliationLocator: (prepared) => prepared.locator,
        reconcile: (_prepared, remainingTimeoutMs) => this.reconcileControlPopupReveal(
          frame,
          controlLocator,
          Date.now() + Math.max(1, remainingTimeoutMs),
          evidence.zeroRenderedSurfaceBaseline,
        ),
        discardCapabilities: () => undefined,
      }),
      preflight: () => {
        if (frame.isDetached() || this.documentVersion(frame) !== documentVersion) {
          throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The control document changed before popup reveal.', {
            recoverable: true,
            details: {
              reason: 'control_document_changed_before_reveal',
              actionDispatched: false,
              suggestedAction: 'Read page events and inspect the replacement document. No opener input was dispatched.',
            },
          });
        }
      },
    });
    return { actionDispatched: result.dispatch.actionDispatched };
  },

  async revealControlPopupWithKeyboard(
    page: Page,
    frame: Frame,
    controlLocator: Locator,
    controlHandle: ElementHandle<HTMLElement>,
    control: ControlTarget,
    documentVersion: number,
    deadlineAt: number,
    evidence: ControlPopupRevealEvidence,
  ): Promise<ControlPopupRevealResult> {
    const phases = this.actionPhases.begin('press', Math.max(1, remainingUntil(deadlineAt)));
    const startedAt = new Date(phases.startedAtMs).toISOString();
    let prepared: Awaited<ReturnType<BrowserControllerContext['prepareMotionTarget']>> | null = null;
    let probe: Awaited<ReturnType<BrowserControllerContext['installMotionProbe']>> = null;
    let actionDispatched: boolean | 'unknown' = false;
    let dispatchError: unknown = null;
    try {
      phases.enter('observe');
      phases.enter('plan');
      phases.enter('preflight');
      await this.primeSelectedPageForTargetPreparation(page, deadlineAt, startedAt, 'press');
      if (frame.isDetached() || this.documentVersion(frame) !== documentVersion) {
        throw keyboardRevealFailure('control_document_changed_before_reveal', false);
      }
      phases.enter('prepare');
      prepared = await this.prepareMotionTarget(
        page,
        frame,
        { kind: 'role', ...control },
        null,
        null,
        false,
        deadlineAt,
      );
      const retained = await boundedValue(
        controlHandle.evaluate((original, current) => original === current, prepared.handle),
        Math.max(1, remainingUntil(deadlineAt)),
        false,
      );
      if (!retained) throw keyboardRevealFailure('control_changed_before_keyboard_reveal', false);
      const renderedSurfaceCount = await renderedControlPopupSurfaceCount(frame, deadlineAt);
      if (renderedSurfaceCount !== 0) {
        throw keyboardRevealFailure(
          renderedSurfaceCount === null
            ? 'popup_surface_baseline_unknown_before_reveal'
            : 'popup_surface_present_before_reveal',
          false,
          renderedSurfaceCount,
        );
      }
      evidence.zeroRenderedSurfaceBaseline = true;
      probe = await this.installMotionProbe(prepared.handle, null);
      if (probe === null) throw keyboardRevealFailure('keyboard_reveal_probe_unavailable', false);
      phases.beginDispatch();
      try {
        await prepared.handle.press('Enter', { timeout: Math.max(1, remainingUntil(deadlineAt)) });
      } catch (error) {
        dispatchError = error;
      }
      const observed = await probe.evaluate((controller) => controller.finish()).catch(() => null);
      await probe.dispose().catch(() => undefined);
      probe = null;
      actionDispatched = observed?.keyDownObserved === true || observed?.keyUpObserved === true
        ? true
        : dispatchError === null ? 'unknown' : false;
      phases.concludeDispatch({ actionDispatched });
      phases.enter('reconcile');
      await this.reconcileControlPopupReveal(
        frame,
        controlLocator,
        deadlineAt,
        evidence.zeroRenderedSurfaceBaseline,
        actionDispatched,
        false,
      );
      phases.beginFinalization();
      phases.complete('succeeded');
      return { actionDispatched };
    } catch (error) {
      if (phases.snapshot().currentPhase === 'dispatch') {
        phases.concludeDispatch({ actionDispatched: actionDispatched === false ? 'unknown' : actionDispatched });
        phases.enter('reconcile');
      }
      phases.beginFinalization();
      phases.complete('failed');
      throw error;
    } finally {
      await probe?.dispose().catch(() => undefined);
      await prepared?.handle.dispose().catch(() => undefined);
      phases.ensureFailed();
      this.actionPhases.finish(phases);
    }
  },

  async reconcileControlPopupReveal(
    frame: Frame,
    controlLocator: Locator,
    deadlineAt: number,
    allowPostDispatchUnique: boolean,
    actionDispatched: boolean | 'unknown' = true,
    clickDispatched: boolean | 'unknown' = 'unknown',
  ): Promise<PostconditionResult> {
    let controlHandle: ElementHandle<HTMLElement> | null = null;
    let popupSurfaces: ObservedControlPopupSurface[] = [];
    try {
      const count = await boundedValue(
        controlLocator.count(),
        Math.max(1, remainingUntil(deadlineAt)),
        -1,
      );
      if (count !== 1) return failPopupReveal(count > 1 ? 'ambiguous_control_after_reveal' : 'control_missing_after_reveal', null, actionDispatched, clickDispatched);
      controlHandle = await boundedValue(
        controlLocator.elementHandle() as Promise<ElementHandle<HTMLElement> | null>,
        Math.max(1, remainingUntil(deadlineAt)),
        null,
      );
      if (controlHandle === null) return failPopupReveal('control_missing_after_reveal', null, actionDispatched, clickDispatched);
      const associated = await this.associatedControlPopup(
        frame,
        controlHandle,
        deadlineAt,
        { allowUniqueRenderedAfterDispatch: allowPostDispatchUnique, requireRendered: true },
      );
      if (associated.kind === 'ambiguous') return failPopupReveal('ambiguous_control_popup_after_reveal', null, actionDispatched, clickDispatched, associated);
      if (associated.kind === 'missing') return failPopupReveal('control_popup_not_observed', false, actionDispatched, clickDispatched, associated);
      popupSurfaces = associated.surfaces;
      const rendered = (await inspectPopupSurfaceSetRendering(popupSurfaces, deadlineAt))?.allRendered === true;
      if (!rendered) return failPopupReveal('control_popup_not_observed', false, actionDispatched, clickDispatched, associated);
      return {
        passed: true,
        checks: [{ kind: 'visible', passed: true, expected: true, observed: true }],
      };
    } finally {
      await Promise.allSettled([
        controlHandle?.dispose() ?? Promise.resolve(),
        disposePopupSurfaces(popupSurfaces),
      ]);
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

function failPopupReveal(
  reason: string,
  observed: boolean | null,
  actionDispatched: boolean | 'unknown',
  clickDispatched: boolean | 'unknown',
  association: ControlPopupAssociation | null = null,
): never {
  throw new Stage5BrowserError('POSTCONDITION_FAILED', 'The opener may have received input, but one associated popup was not proven visible.', {
    recoverable: true,
    details: {
      reason,
      actionDispatched,
      clickDispatched,
      checks: [{ kind: 'visible', passed: false, expected: true, observed }],
      renderedPopupCount: association?.renderedSurfaceCount ?? null,
      popupOwnership: association?.popupOwnership ?? null,
      suggestedAction: 'Inspect authoritative control state. Possible opener input occurred; do not replay it.',
    },
  });
}

function keyboardRevealFailure(
  reason: string,
  actionDispatched: boolean | 'unknown',
  renderedPopupCount: number | null = null,
): Stage5BrowserError {
  return new Stage5BrowserError('OPERATION_FAILED', 'The exact control was not ready for one keyboard reveal.', {
    recoverable: true,
    details: {
      reason,
      actionDispatched,
      clickDispatched: false,
      renderedPopupCount,
      revealInteraction: 'keyboard',
      suggestedAction: actionDispatched === false
        ? 'Inspect current control state before choosing one new reveal technique.'
        : 'Inspect authoritative control state. Possible key input occurred; do not replay it.',
    },
  });
}

export type ControlRevealOperations = typeof controlRevealOperations;
