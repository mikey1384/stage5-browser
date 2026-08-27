import {
  type BrowserMotionDispatchEvidence,
  type ElementHandle,
  type Frame,
  inspectTargetState,
  type Page,
  sanitizeUrlForJournal,
  Stage5BrowserError,
} from '../dependencies.js';
import { boundedValue, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import { resolveControlPopupOwner } from './popup-ownership.js';
import { discoverControlPopupSurfaces } from './popup-surfaces.js';
import { popupRendered } from './rendering.js';

interface PopupPreparationResult {
  competingPopupDismissed: boolean;
  preparationActionDispatched: boolean | 'unknown';
  targetPopupAlreadyOpen: boolean;
}

export const popupPreparationOperations = {
  async dismissCompetingControlPopup(
    page: Page,
    frame: Frame,
    targetControl: ElementHandle<HTMLElement>,
    deadlineAt: number,
  ): Promise<PopupPreparationResult> {
    const discovery = await discoverControlPopupSurfaces(frame, deadlineAt);
    if (discovery.kind === 'unbounded') {
      throw new Stage5BrowserError('AMBIGUOUS_TARGET', 'The visible popup environment could not be bounded.', {
        recoverable: true,
        details: { reason: 'popup_environment_unbounded', actionDispatched: false },
      });
    }
    const renderedPopups: ElementHandle<HTMLElement>[] = [];
    for (const { handle } of discovery.surfaces) {
      if (await popupRendered(handle, deadlineAt)) renderedPopups.push(handle);
      else await handle.dispose().catch(() => undefined);
    }
    if (renderedPopups.length === 0) {
      return {
        competingPopupDismissed: false,
        preparationActionDispatched: false,
        targetPopupAlreadyOpen: false,
      };
    }

    const owners: ElementHandle<HTMLElement>[] = [];
    try {
      for (const popup of renderedPopups) {
        const ownership = await resolveControlPopupOwner(
          frame,
          popup,
          targetControl,
          deadlineAt,
        );
        if (ownership.kind !== 'resolved') {
          throw new Stage5BrowserError('AMBIGUOUS_TARGET', 'The popup owner set could not be bounded.', {
            recoverable: true,
            details: {
              reason: ownership.kind === 'unbounded'
                ? 'popup_owner_set_unbounded'
                : ownership.kind === 'ambiguous'
                  ? 'ambiguous_competing_popup_owner'
                  : 'competing_popup_owner_missing',
              actionDispatched: false,
              renderedPopupCount: renderedPopups.length,
              popupOwnership: ownership.diagnostics,
            },
          });
        }
        owners.push(ownership.owner);
        if (ownership.targetMatch) {
          return {
            competingPopupDismissed: false,
            preparationActionDispatched: false,
            targetPopupAlreadyOpen: true,
          };
        }
      }
      const source = owners[0]!;
      for (const owner of owners.slice(1)) {
        const sameOwner = await boundedValue(
          source.evaluate((first, candidate) => first.isConnected && first === candidate, owner),
          Math.max(1, remainingUntil(deadlineAt)),
          null,
        );
        if (sameOwner !== true) {
          throw new Stage5BrowserError('AMBIGUOUS_TARGET', 'Several open popup surfaces did not share one exact competing owner.', {
            recoverable: true,
            details: {
              reason: 'multiple_competing_popup_owners',
              actionDispatched: false,
              renderedPopupCount: renderedPopups.length,
              suggestedAction: 'Inspect the current modal or page before choosing a new action.',
            },
          });
        }
      }
      return await this.dispatchPopupEscape(page, renderedPopups, source, deadlineAt);
    } finally {
      await Promise.allSettled([
        ...renderedPopups.map((popup) => popup.dispose()),
        ...owners.map((owner) => owner.dispose()),
      ]);
    }
  },

  async dispatchPopupEscape(
    page: Page,
    popups: ElementHandle<HTMLElement>[],
    source: ElementHandle<HTMLElement>,
    deadlineAt: number,
  ): Promise<PopupPreparationResult> {
    const phases = this.actionPhases.begin('dismiss_competing_popup', Math.max(1, remainingUntil(deadlineAt)));
    const startedAt = new Date(phases.startedAtMs).toISOString();
    let probe: Awaited<ReturnType<BrowserControllerContext['installMotionProbe']>> = null;
    let dispatch: BrowserMotionDispatchEvidence['actionDispatched'] = false;
    try {
      phases.enter('observe');
      const before = await anyPopupRendered(popups, deadlineAt);
      phases.enter('plan');
      if (!before) {
        phases.enter('preflight');
        phases.enter('prepare');
        phases.beginDispatch();
        phases.concludeDispatch({ actionDispatched: false });
        phases.enter('reconcile');
        phases.beginFinalization();
        phases.complete('succeeded');
        return {
          competingPopupDismissed: false,
          preparationActionDispatched: false,
          targetPopupAlreadyOpen: false,
        };
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
      while (await anyPopupRendered(popups, observationDeadline)) {
        if (remainingUntil(observationDeadline) <= 0) break;
        await page.waitForTimeout(Math.min(50, remainingUntil(observationDeadline)));
      }
      if (await anyPopupRendered(popups, deadlineAt)) {
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
      return {
        competingPopupDismissed: true,
        preparationActionDispatched: dispatch,
        targetPopupAlreadyOpen: false,
      };
    } finally {
      await probe?.dispose().catch(() => undefined);
      phases.ensureFailed();
      this.actionPhases.finish(phases);
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

async function anyPopupRendered(
  popups: ElementHandle<HTMLElement>[],
  deadlineAt: number,
): Promise<boolean> {
  for (const popup of popups) {
    if (await popupRendered(popup, deadlineAt)) return true;
  }
  return false;
}

export type PopupPreparationOperations = typeof popupPreparationOperations;
