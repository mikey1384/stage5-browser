import {
  type BrowserMotionDispatchEvidence,
  type ElementHandle,
  type Frame,
  inspectTargetState,
  type Page,
  sanitizeUrlForJournal,
  Stage5BrowserError,
} from '../dependencies.js';
import { boundedValue, CONTROL_POPUP_SELECTOR, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import { popupRendered } from './rendering.js';

interface PopupPreparationResult {
  competingPopupDismissed: boolean;
  preparationActionDispatched: boolean | 'unknown';
}

export const popupPreparationOperations = {
  async dismissCompetingControlPopup(
    page: Page,
    frame: Frame,
    targetControl: ElementHandle<HTMLElement>,
    deadlineAt: number,
  ): Promise<PopupPreparationResult> {
    const popupLocator = frame.locator(CONTROL_POPUP_SELECTOR);
    const popupCount = await boundedValue(popupLocator.count(), Math.max(1, remainingUntil(deadlineAt)), -1);
    if (popupCount < 0 || popupCount > 50) {
      throw new Stage5BrowserError('AMBIGUOUS_TARGET', 'The visible popup environment could not be bounded.', {
        recoverable: true,
        details: { reason: 'popup_environment_unbounded', actionDispatched: false },
      });
    }
    const renderedPopups: ElementHandle<HTMLElement>[] = [];
    for (let index = 0; index < popupCount; index += 1) {
      const handle = await boundedValue(
        popupLocator.nth(index).elementHandle() as Promise<ElementHandle<HTMLElement> | null>,
        Math.max(1, remainingUntil(deadlineAt)),
        null,
      );
      if (handle === null) continue;
      if (await popupRendered(handle, deadlineAt)) renderedPopups.push(handle);
      else await handle.dispose().catch(() => undefined);
    }
    if (renderedPopups.length === 0) {
      return { competingPopupDismissed: false, preparationActionDispatched: false };
    }
    if (renderedPopups.length > 1) {
      await Promise.allSettled(renderedPopups.map((handle) => handle.dispose()));
      throw new Stage5BrowserError('AMBIGUOUS_TARGET', 'Multiple rendered popup surfaces were open before control inspection.', {
        recoverable: true,
        details: {
          reason: 'multiple_competing_popups',
          actionDispatched: false,
          suggestedAction: 'Inspect the current modal or page and choose one exact popup owner before dispatch.',
        },
      });
    }

    const popup = renderedPopups[0]!;
    let source: ElementHandle<HTMLElement> | null = null;
    const ownerHandles: ElementHandle<HTMLElement>[] = [];
    try {
      const targetOwnsPopup = await targetControl.evaluate((control, surface) => {
        const ids = [
          ...(control.getAttribute('aria-controls') ?? '').split(/\s+/),
          ...(control.getAttribute('aria-owns') ?? '').split(/\s+/),
        ].filter(Boolean);
        const labelledBy = (surface.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
        return (surface.id.length > 0 && ids.includes(surface.id))
          || control.contains(surface)
          || (control.id.length > 0 && labelledBy.includes(control.id))
          || control.getAttribute('aria-expanded') === 'true'
          || control.ownerDocument.activeElement === control
          || control.contains(control.ownerDocument.activeElement);
      }, popup).catch(() => false);
      if (targetOwnsPopup) {
        return { competingPopupDismissed: false, preparationActionDispatched: false };
      }

      const owners = frame.locator('[aria-controls], [aria-owns], [aria-haspopup]');
      const ownerCount = await boundedValue(owners.count(), Math.max(1, remainingUntil(deadlineAt)), -1);
      if (ownerCount < 0 || ownerCount > 100) {
        throw new Stage5BrowserError('AMBIGUOUS_TARGET', 'The popup owner set could not be bounded.', {
          recoverable: true,
          details: { reason: 'popup_owner_set_unbounded', actionDispatched: false },
        });
      }
      for (let index = 0; index < ownerCount; index += 1) {
        const owner = await boundedValue(
          owners.nth(index).elementHandle() as Promise<ElementHandle<HTMLElement> | null>,
          Math.max(1, remainingUntil(deadlineAt)),
          null,
        );
        if (owner === null) continue;
        const related = await owner.evaluate((control, surface) => {
          const ids = [
            ...(control.getAttribute('aria-controls') ?? '').split(/\s+/),
            ...(control.getAttribute('aria-owns') ?? '').split(/\s+/),
          ].filter(Boolean);
          const labelledBy = (surface.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
          return (surface.id.length > 0 && ids.includes(surface.id))
            || control.contains(surface)
            || (control.id.length > 0 && labelledBy.includes(control.id))
            || control.getAttribute('aria-expanded') === 'true'
            || control.ownerDocument.activeElement === control
            || control.contains(control.ownerDocument.activeElement);
        }, popup).catch(() => false);
        if (related) ownerHandles.push(owner);
        else await owner.dispose().catch(() => undefined);
      }
      if (ownerHandles.length !== 1) {
        throw new Stage5BrowserError(
          ownerHandles.length > 1 ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND',
          'The rendered competing popup did not have one exact structural owner.',
          {
            recoverable: true,
            details: {
              reason: ownerHandles.length > 1 ? 'ambiguous_competing_popup_owner' : 'competing_popup_owner_missing',
              actionDispatched: false,
            },
          },
        );
      }
      source = ownerHandles[0]!;
      return await this.dispatchPopupEscape(page, popup, source, deadlineAt);
    } finally {
      await popup.dispose().catch(() => undefined);
      await Promise.allSettled(ownerHandles.map((handle) => handle.dispose()));
      if (source !== null && !ownerHandles.includes(source)) await source.dispose().catch(() => undefined);
    }
  },

  async dispatchPopupEscape(
    page: Page,
    popup: ElementHandle<HTMLElement>,
    source: ElementHandle<HTMLElement>,
    deadlineAt: number,
  ): Promise<PopupPreparationResult> {
    const phases = this.actionPhases.begin('dismiss_competing_popup', Math.max(1, remainingUntil(deadlineAt)));
    const startedAt = new Date(phases.startedAtMs).toISOString();
    let probe: Awaited<ReturnType<BrowserControllerContext['installMotionProbe']>> = null;
    let dispatch: BrowserMotionDispatchEvidence['actionDispatched'] = false;
    try {
      phases.enter('observe');
      const before = await popupRendered(popup, deadlineAt);
      phases.enter('plan');
      if (!before) {
        phases.enter('preflight');
        phases.enter('prepare');
        phases.beginDispatch();
        phases.concludeDispatch({ actionDispatched: false });
        phases.enter('reconcile');
        phases.beginFinalization();
        phases.complete('succeeded');
        return { competingPopupDismissed: false, preparationActionDispatched: false };
      }
      phases.enter('preflight');
      await this.primeSelectedPageForTargetPreparation(page, deadlineAt, startedAt, 'dismiss_popup');
      const state = await inspectTargetState(source);
      if (state === null || !state.visible || !state.enabled) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The competing popup owner was not safely keyboard-actionable.', {
          recoverable: true,
          details: { reason: 'competing_popup_owner_not_actionable', actionDispatched: false, targetState: state },
        });
      }
      phases.enter('prepare');
      probe = await this.installMotionProbe(source, null);
      if (probe === null) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'Popup-dismiss keyboard evidence could not be installed.', {
          recoverable: true,
          details: { reason: 'popup_dismiss_probe_unavailable', actionDispatched: false },
        });
      }
      phases.beginDispatch();
      let dispatchError: unknown = null;
      try {
        await source.press('Escape', { timeout: Math.max(1, remainingUntil(deadlineAt)) });
      } catch (error) {
        dispatchError = error;
      }
      const observed = await probe.evaluate((controller) => controller.finish()).catch(() => null);
      await probe.dispose().catch(() => undefined);
      probe = null;
      dispatch = observed?.keyDownObserved === true || observed?.keyUpObserved === true
        ? true
        : dispatchError === null ? 'unknown' : false;
      phases.concludeDispatch({ actionDispatched: dispatch });
      phases.enter('reconcile');
      const observationDeadline = Math.min(deadlineAt, Date.now() + 1_000);
      while (await popupRendered(popup, observationDeadline)) {
        if (remainingUntil(observationDeadline) <= 0) break;
        await page.waitForTimeout(Math.min(50, remainingUntil(observationDeadline)));
      }
      if (await popupRendered(popup, deadlineAt)) {
        throw new Stage5BrowserError('POSTCONDITION_FAILED', 'Escape input did not close the exact competing popup.', {
          recoverable: true,
          details: {
            reason: 'competing_popup_remained_open',
            actionDispatched: dispatch,
            suggestedAction: dispatch === false
              ? 'Inspect the popup owner before one new plan.'
              : 'Inspect authoritative control state. Possible input occurred; do not replay the dismissal.',
          },
          cause: dispatchError,
        });
      }
      phases.beginFinalization();
      this.pageDiagnostics.recordAction(page, {
        action: 'dismiss_popup',
        outcome: 'succeeded',
        reason: null,
        actionDispatched: dispatch,
        clickDispatched: null,
        targetState: state,
        pageUrl: sanitizeUrlForJournal(page.url()) ?? null,
        startedAt,
        occurredAt: new Date().toISOString(),
      });
      phases.complete('succeeded');
      return { competingPopupDismissed: true, preparationActionDispatched: dispatch };
    } finally {
      await probe?.dispose().catch(() => undefined);
      phases.ensureFailed();
      this.actionPhases.finish(phases);
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type PopupPreparationOperations = typeof popupPreparationOperations;
