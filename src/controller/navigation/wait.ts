import { type BrowserCommandInput, type BrowserCommandOutput } from '../dependencies.js';
import type { BrowserControllerContext } from '../runtime.js';

export const navigationWaitOperations = {
  async waitForUrl(input: BrowserCommandInput<'waitForUrl'>): Promise<BrowserCommandOutput<'waitForUrl'>> {
    const page = await this.ensureActivePage(this.requireContext());
    await this.waitForUrlExpectation(page, input.expected, input.timeoutMs, 'URL wait');
    this.lastKnownUrl = page.url();
    return { page: await this.pageSummary(page), matched: true, expected: input.expected };
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type NavigationWaitOperations = typeof navigationWaitOperations;
