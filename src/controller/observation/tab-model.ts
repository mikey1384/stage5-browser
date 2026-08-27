import { type Browser, type BrowserContext, type BrowserTabSummary, type Page, type PageSummary, randomUUID, Stage5BrowserError } from '../dependencies.js';
import { boundedValue, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const observationTabModelOperations = {
  async pageSummary(
    page: Page,
    suppliedIndex?: number,
    timeoutMs = 1_000,
  ): Promise<PageSummary> {
    const context = this.usableContext();
    const pages = context?.pages().filter((candidate) => !candidate.isClosed()) ?? [];
    const index = suppliedIndex ?? Math.max(0, pages.indexOf(page));
    const deadlineAt = Date.now() + Math.max(1, timeoutMs);
    const title = await boundedValue(
      page.title(),
      Math.max(1, remainingUntil(deadlineAt)),
      '<unavailable>',
    );
    const readyState = await boundedValue(
      page.evaluate(() => document.readyState),
      Math.max(1, remainingUntil(deadlineAt)),
      'unknown',
    );

    return {
      index,
      url: page.url(),
      title,
      readyState,
      stateRisk: this.pageStateRiskManager.current(page),
    };
  },

  tabId(page: Page): string {
    const existing = this.tabIds.get(page);
    if (existing !== undefined) return existing;
    const tabId = `tab-${randomUUID()}`;
    this.tabIds.set(page, tabId);
    return tabId;
  },

  async tabSummary(page: Page, suppliedIndex?: number): Promise<BrowserTabSummary> {
    const tabId = this.tabId(page);
    this.observedTabsById.set(tabId, page);
    const opener = await boundedValue(page.opener(), 250, null);
    const openerTabId = opener === null || opener.isClosed() || opener.context() !== page.context()
      ? null
      : this.tabId(opener);
    if (opener !== null && openerTabId !== null) this.observedTabsById.set(openerTabId, opener);
    return {
      ...await this.pageSummary(page, suppliedIndex),
      tabId,
      openerTabId,
    };
  },

  observedTab(tabId: string, context: BrowserContext): Page {
    const page = this.observedTabsById.get(tabId);
    if (page === undefined || page.isClosed() || !context.pages().includes(page)) {
      this.observedTabsById.delete(tabId);
      throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The observed tab capability is stale or unavailable.', {
        recoverable: true,
        details: {
          reason: 'stale_tab_id',
          actionDispatched: false,
          suggestedAction: 'Call browser_tabs once and use only the intended fresh opaque tabId. Stage5 Browser will not fall back to URL, title, or index.',
        },
      });
    }
    return page;
  },

  discardObservedTab(page: Page): void {
    const tabId = this.tabIds.get(page);
    if (tabId !== undefined) this.observedTabsById.delete(tabId);
    this.tabIds.delete(page);
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type ObservationTabModelOperations = typeof observationTabModelOperations;
