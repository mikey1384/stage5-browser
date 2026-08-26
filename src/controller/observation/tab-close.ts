import { type BrowserCommandInput, type BrowserCommandOutput, type Page, Stage5BrowserError } from '../dependencies.js';
import type { BrowserControllerContext } from '../runtime.js';

export const observationTabCloseOperations = {
  async closeTab(input: BrowserCommandInput<'closeTab'>): Promise<BrowserCommandOutput<'closeTab'>> {
    const context = this.requireContext();
    const phases = this.actionPhases.begin('close_tab', input.timeoutMs);
    let page: Page | null = null;
    let wasSelected = false;
    try {
      phases.enter('observe');
      page = this.observedTab(input.tabId, context);
      wasSelected = this.preferredPage() === page;
      phases.enter('plan');
      phases.enter('preflight');
      if (page.isClosed()) {
        throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The exact tab closed before the close dispatch gate.', {
          recoverable: true,
          details: { reason: 'tab_closed_before_dispatch', actionDispatched: false },
        });
      }
      phases.enter('prepare');
      phases.beginDispatch();
      await page.close({ runBeforeUnload: false });
      phases.concludeDispatch({ actionDispatched: true });
      phases.enter('reconcile');
      if (!page.isClosed()) {
        throw new Stage5BrowserError('POSTCONDITION_FAILED', 'The exact tab was not observed closed.', {
          recoverable: true,
          details: {
            reason: 'tab_close_not_observed',
            actionDispatched: 'unknown',
            suggestedAction: 'Call browser_tabs once. Do not repeat the close unless that exact tab is still present.',
          },
        });
      }
      this.discardObservedTab(page);
      await this.reconcileVisiblePage(context);
      const livePages = context.pages().filter((candidate) => !candidate.isClosed());
      const selected = this.preferredPage();
      const pages = await Promise.all(livePages.map((candidate, index) => this.tabSummary(candidate, index)));
      phases.beginFinalization();
      const result = {
        closedTabId: input.tabId,
        wasSelected,
        actionDispatched: true as const,
        pages,
        selectedTabId: selected === undefined ? null : this.tabId(selected),
      };
      phases.complete('succeeded');
      return result;
    } catch (error) {
      if (phases.snapshot().currentPhase === 'dispatch') {
        phases.concludeDispatch({ actionDispatched: page?.isClosed() === true ? true : 'unknown' });
        phases.enter('reconcile');
      }
      phases.beginFinalization();
      phases.complete('failed');
      throw error;
    } finally {
      phases.ensureFailed();
      this.actionPhases.finish(phases);
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type ObservationTabCloseOperations = typeof observationTabCloseOperations;
