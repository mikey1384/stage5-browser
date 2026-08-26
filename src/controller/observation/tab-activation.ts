import { type BrowserCommandInput, type BrowserCommandOutput, type Page, Stage5BrowserError } from '../dependencies.js';
import { remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const observationTabActivationOperations = {
  async activateSelectedPage(
    input: BrowserCommandInput<'activateSelectedPage'>,
  ): Promise<BrowserCommandOutput<'activateSelectedPage'>> {
    const context = this.requireContext();
    const page = await this.ensureActivePage(context);
    const phases = this.actionPhases.begin('activate_selected_page', input.timeoutMs);
    try {
      phases.enter('observe');
      const pages = context.pages().filter((candidate) => !candidate.isClosed());
      phases.enter('plan');
      if (this.preferredPage() !== page) {
        throw new Stage5BrowserError('BROWSER_NOT_READY', 'The controller-selected page changed before activation.', {
          recoverable: true,
          details: { reason: 'selected_page_changed', elementActionDispatched: false },
        });
      }
      phases.enter('preflight');
      phases.enter('prepare');
      phases.beginDispatch();
      const activation = await this.activateSelectedPageForInput(page, 1);
      const viewActionDispatched = activation.bringToFrontAttempted || activation.nativeWindow.attempted;
      phases.concludeDispatch({ actionDispatched: viewActionDispatched });
      phases.enter('reconcile');
      const controllerSelected = activation.controllerSelected && this.preferredPage() === page;
      const rendererVisible = activation.visibilityAfter === 'visible';
      const documentFocused = activation.documentFocusedAfter;
      const nativeApplicationFrontmost = activation.nativeWindow.attempted
        ? activation.nativeWindow.applicationFrontmostAfter === true
        : null;
      if (
        !controllerSelected ||
        !rendererVisible ||
        !documentFocused ||
        nativeApplicationFrontmost === false
      ) {
        throw new Stage5BrowserError('POSTCONDITION_FAILED', 'The exact selected page did not satisfy the bounded activation postcondition.', {
          recoverable: true,
          details: {
            reason: 'selected_page_activation_unproven',
            elementActionDispatched: false,
            viewActionDispatched,
            activation,
            suggestedAction: 'Inspect browser_status and the exact sanitized activation evidence. No element input was dispatched; do not bypass the visibility gate.',
          },
        });
      }
      await this.persistNativeSelectedPage(page);
      phases.beginFinalization();
      const result: BrowserCommandOutput<'activateSelectedPage'> = {
        page: await this.tabSummary(page, pages.indexOf(page)),
        activation,
        postcondition: {
          controllerSelected: true,
          rendererVisible: true,
          documentFocused: true,
          nativeApplicationFrontmost,
        },
      };
      phases.complete('succeeded');
      return result;
    } catch (error) {
      phases.ensureFailed();
      throw error;
    } finally {
      phases.ensureFailed();
      this.actionPhases.finish(phases);
    }
  },

  async restoreTemporarilyActivatedTab(
    page: Page,
    deadlineAt: number,
  ): Promise<{ restored: boolean; recoveryUsed: boolean }> {
    const restore = async (timeoutMs: number): Promise<boolean> => {
      await page.bringToFront();
      const observed = await this.observePageActivation(page);
      const restored = await this.waitForVisiblePageActivation(page, observed, timeoutMs);
      return restored.visibility === 'visible' && this.preferredPage() === page;
    };

    try {
      const firstBudget = Math.max(1, Math.min(500, Math.floor(remainingUntil(deadlineAt) / 2)));
      if (await restore(firstBudget)) {
        await this.persistNativeSelectedPage(page);
        return { restored: true, recoveryUsed: false };
      }
      if (page.isClosed() || this.preferredPage() !== page || remainingUntil(deadlineAt) <= 0) {
        return { restored: false, recoveryUsed: false };
      }
      const restored = await restore(Math.max(1, remainingUntil(deadlineAt)));
      if (restored) await this.persistNativeSelectedPage(page);
      return { restored, recoveryUsed: true };
    } catch {
      return { restored: false, recoveryUsed: false };
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type ObservationTabActivationOperations = typeof observationTabActivationOperations;
