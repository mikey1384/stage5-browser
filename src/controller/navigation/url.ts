import { authenticationRouteMatches, type Page, Stage5BrowserError, type UrlExpectation } from '../dependencies.js';
import type { BrowserControllerContext } from '../runtime.js';

export const navigationUrlOperations = {
  urlMatches(actual: string, expected: UrlExpectation): boolean {
    switch (expected.match) {
      case 'exact':
        return actual === expected.url;
      case 'prefix':
        return actual.startsWith(expected.url);
      case 'contains':
        return actual.includes(expected.url);
    }
  },

  async waitForUrlExpectation(
    page: Page,
    expected: UrlExpectation,
    timeoutMs: number,
    operation: string,
    authenticationRoute = false,
  ): Promise<void> {
    const startedAt = Date.now();
    do {
      const matched = authenticationRoute && expected.match === 'exact'
        ? authenticationRouteMatches(page.url(), expected.url)
        : this.urlMatches(page.url(), expected);
      if (matched) {
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        break;
      }
      await page.waitForTimeout(Math.min(100, Math.max(1, timeoutMs - (Date.now() - startedAt))));
    } while (Date.now() - startedAt < timeoutMs);

    throw new Stage5BrowserError('POSTCONDITION_FAILED', `${operation} did not observe the expected URL.`, {
      recoverable: true,
      details: {
        reason: 'url_expectation_not_met',
        expected: { ...expected, url: this.safeObservedUrl(expected.url) },
        currentUrl: this.safeObservedUrl(page.url()),
        suggestedAction: 'Inspect the current page and redirect state before deciding whether another action is safe.',
      },
    });
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type NavigationUrlOperations = typeof navigationUrlOperations;
