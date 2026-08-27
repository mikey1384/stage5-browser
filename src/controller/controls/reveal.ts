import { type BrowserCommandOutput, type ElementHandle, type Frame, type Locator, type Page, type PostconditionResult, type SanitizedNativeWindowActivationEvidence, Stage5BrowserError } from '../dependencies.js';
import { boundedValue, type PreparedObservedClickTarget, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import { popupRendered } from './rendering.js';

export const controlRevealOperations = {
  async revealControlPopup(
    page: Page,
    frame: Frame,
    controlLocator: Locator,
    controlHandle: ElementHandle<HTMLElement>,
    documentVersion: number,
    deadlineAt: number,
  ): Promise<BrowserCommandOutput<'clickByRole'>> {
    return await this.executeClickAction({
      action: 'click_by_role',
      timeoutMs: Math.max(1, remainingUntil(deadlineAt)),
      observe: async () => ({ page, frame }),
      plan: () => ({
        action: 'click_by_role',
        page,
        frame,
        postcondition: null,
        prepare: async (
          priorNativeActivation: SanitizedNativeWindowActivationEvidence | null,
          activationAttemptCount: number,
          actionStartedAt: string,
          actionDeadlineAt: number,
        ): Promise<PreparedObservedClickTarget> => {
          const pageActivation = await this.primeSelectedPageForTargetPreparation(
            page,
            actionDeadlineAt,
            actionStartedAt,
            'click_by_role',
            activationAttemptCount,
            priorNativeActivation ?? undefined,
          );
          return this.prepareObservedClickTarget(
            page,
            frame,
            controlLocator,
            actionStartedAt,
            actionDeadlineAt,
            null,
            pageActivation,
            controlHandle,
          );
        },
        reconciliationLocator: (prepared) => prepared.locator,
        reconcile: (_prepared, remainingTimeoutMs) => this.reconcileControlPopupReveal(
          frame,
          controlLocator,
          Date.now() + Math.max(1, remainingTimeoutMs),
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
    }) as BrowserCommandOutput<'clickByRole'>;
  },

  async reconcileControlPopupReveal(
    frame: Frame,
    controlLocator: Locator,
    deadlineAt: number,
  ): Promise<PostconditionResult> {
    let controlHandle: ElementHandle<HTMLElement> | null = null;
    let popupHandle: ElementHandle<HTMLElement> | null = null;
    try {
      const count = await boundedValue(
        controlLocator.count(),
        Math.max(1, remainingUntil(deadlineAt)),
        -1,
      );
      if (count !== 1) return failPopupReveal(count > 1 ? 'ambiguous_control_after_reveal' : 'control_missing_after_reveal', null);
      controlHandle = await boundedValue(
        controlLocator.elementHandle() as Promise<ElementHandle<HTMLElement> | null>,
        Math.max(1, remainingUntil(deadlineAt)),
        null,
      );
      if (controlHandle === null) return failPopupReveal('control_missing_after_reveal', null);
      const associated = await this.associatedControlPopup(
        frame,
        controlHandle,
        deadlineAt,
        { allowUniqueRenderedAfterDispatch: true, requireRendered: true },
      );
      if (associated.kind === 'ambiguous') return failPopupReveal('ambiguous_control_popup_after_reveal', null);
      if (associated.kind === 'missing') return failPopupReveal('control_popup_not_observed', false);
      popupHandle = associated.handle;
      const rendered = await popupRendered(popupHandle, deadlineAt);
      if (!rendered) return failPopupReveal('control_popup_not_observed', false);
      return {
        passed: true,
        checks: [{ kind: 'visible', passed: true, expected: true, observed: true }],
      };
    } finally {
      await Promise.allSettled([
        controlHandle?.dispose() ?? Promise.resolve(),
        popupHandle?.dispose() ?? Promise.resolve(),
      ]);
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

function failPopupReveal(reason: string, observed: boolean | null): never {
  throw new Stage5BrowserError('POSTCONDITION_FAILED', 'The opener may have received input, but one associated popup was not proven visible.', {
    recoverable: true,
    details: {
      reason,
      actionDispatched: true,
      clickDispatched: 'unknown',
      checks: [{ kind: 'visible', passed: false, expected: true, observed }],
      suggestedAction: 'Inspect authoritative control state. Possible opener input occurred; do not replay it.',
    },
  });
}

export type ControlRevealOperations = typeof controlRevealOperations;
