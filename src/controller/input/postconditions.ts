import { type ClickPostcondition, type Frame, inspectTargetState, type Locator, type Page, type PostconditionCheck, type PostconditionResult, type SanitizedClickDispatchEvidence, Stage5BrowserError, type VisibleElementExpectation } from '../dependencies.js';
import { POPUP_RENDERED_STATE_ROLES, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const inputPostconditionsOperations = {
  async verifyClickPostcondition(
    page: Page,
    clickedFrame: Frame,
    clickedLocator: Locator,
    postcondition: ClickPostcondition | null,
    remainingTimeoutMs: number,
    pagesBeforeDispatch: ReadonlySet<Page>,
    downloadCursorBeforeDispatch: number,
  ): Promise<PostconditionResult | null> {
    return this.verifyActionPostcondition(
      page,
      clickedFrame,
      clickedLocator,
      postcondition,
      remainingTimeoutMs,
      pagesBeforeDispatch,
      downloadCursorBeforeDispatch,
      'click',
    );
  },

  async verifyActionPostcondition(
    page: Page,
    clickedFrame: Frame,
    clickedLocator: Locator,
    postcondition: ClickPostcondition | null,
    remainingTimeoutMs: number,
    pagesBeforeDispatch: ReadonlySet<Page>,
    downloadCursorBeforeDispatch: number,
    actionLabel: 'click' | 'motion',
  ): Promise<PostconditionResult | null> {
    if (postcondition === null) {
      return null;
    }

    const timeoutMs = Math.min(postcondition.timeoutMs, remainingTimeoutMs);
    const startedAt = Date.now();
    let checks: PostconditionCheck[] = [];
    while (true) {
      checks = await this.postconditionChecks(
        page,
        clickedFrame,
        clickedLocator,
        postcondition,
        pagesBeforeDispatch,
        downloadCursorBeforeDispatch,
      );
      const satisfied = postcondition.satisfaction === 'any'
        ? checks.some((check) => check.passed)
        : checks.length > 0 && checks.every((check) => check.passed);
      if (satisfied) {
        return { passed: true, checks };
      }
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        break;
      }
      await page.waitForTimeout(Math.min(100, remaining));
    }

    throw new Stage5BrowserError(
      'POSTCONDITION_FAILED',
      `The ${actionLabel} was dispatched, but the requested postcondition was not observed before its deadline.`,
      {
        recoverable: true,
        details: {
          reason: `${actionLabel}_postcondition_not_met`,
          ...(actionLabel === 'click'
            ? { clickDispatched: true, actionOutcome: 'click_dispatched_postcondition_failed' }
            : { actionDispatched: true, actionOutcome: 'motion_dispatched_postcondition_failed' }),
          checks: checks.map((check) => ({
            ...check,
            ...((check.kind === 'url' || check.kind === 'new_page_url') && typeof check.observed === 'string'
              ? { observed: this.safeObservedUrl(check.observed) }
              : {}),
            ...((check.kind === 'url' || check.kind === 'new_page_url') && typeof check.expected === 'string'
              ? { expected: this.safeObservedUrl(check.expected) }
              : {}),
          })),
          currentUrl: this.safeObservedUrl(page.url()),
          suggestedAction: 'Inspect the current page state. Do not repeat the click unless a fresh observation shows that retrying is safe.',
        },
      },
    );
  },

  async reconcilePartialClickEffect(
    page: Page,
    clickedFrame: Frame,
    clickedLocator: Locator,
    postcondition: ClickPostcondition | null,
    dispatchError: unknown,
    deadlineAt: number,
    pagesBeforeDispatch: ReadonlySet<Page>,
    downloadCursorBeforeDispatch: number,
    observeEffect?: () => Promise<PostconditionResult | null>,
  ): Promise<{
    postcondition: PostconditionResult;
    dispatchEvidence: SanitizedClickDispatchEvidence | null;
    actionDispatched: boolean | 'unknown';
    clickDispatched: boolean | 'unknown';
  } | null> {
    if (
      !(dispatchError instanceof Stage5BrowserError) ||
      (postcondition === null && observeEffect === undefined)
    ) return null;
    const actionDispatched = dispatchError.details?.actionDispatched;
    const clickDispatched = dispatchError.details?.clickDispatched;
    if (
      (actionDispatched !== true && actionDispatched !== 'unknown') ||
      (clickDispatched !== false && clickDispatched !== 'unknown')
    ) {
      return null;
    }
    const dispatchEvidence = (dispatchError.details?.dispatchEvidence ?? null) as
      SanitizedClickDispatchEvidence | null;
    try {
      const observed = observeEffect === undefined
        ? await this.verifyClickPostcondition(
          page,
          clickedFrame,
          clickedLocator,
          postcondition,
          remainingUntil(deadlineAt),
          pagesBeforeDispatch,
          downloadCursorBeforeDispatch,
        )
        : await observeEffect();
      if (observed === null) return null;
      return { postcondition: observed, dispatchEvidence, actionDispatched, clickDispatched };
    } catch (postconditionError) {
      if (!(postconditionError instanceof Stage5BrowserError) || postconditionError.code !== 'POSTCONDITION_FAILED') {
        throw postconditionError;
      }
      throw new Stage5BrowserError(
        dispatchError.code,
        dispatchError.message,
        {
          recoverable: dispatchError.recoverable,
          details: {
            ...dispatchError.details,
            effectPostconditionObserved: false,
            effectPostconditionChecks: postconditionError.details?.checks ?? [],
            checks: postconditionError.details?.checks ?? [],
            suggestedAction: 'Inspect authoritative state with a fresh snapshot. Partial or ambiguous input occurred and the requested effect was not confirmed; do not retry or replay the action.',
          },
          cause: dispatchError,
        },
      );
    }
  },

  async postconditionChecks(
    page: Page,
    clickedFrame: Frame,
    clickedLocator: Locator,
    postcondition: ClickPostcondition,
    pagesBeforeDispatch: ReadonlySet<Page>,
    downloadCursorBeforeDispatch: number,
  ): Promise<PostconditionCheck[]> {
    const checks: PostconditionCheck[] = [];

    if (postcondition.expectedUrl !== null) {
      const observed = page.url();
      checks.push({
        kind: 'url',
        passed: this.urlMatches(observed, postcondition.expectedUrl),
        expected: postcondition.expectedUrl.url,
        observed,
      });
    }

    if (postcondition.expectedNewPageUrl !== undefined && postcondition.expectedNewPageUrl !== null) {
      const newPages = page.context().pages().filter((candidate) =>
        !candidate.isClosed() && !pagesBeforeDispatch.has(candidate));
      const observed = newPages.length === 1 ? newPages[0]?.url() ?? null : null;
      checks.push({
        kind: 'new_page_url',
        passed: observed !== null && this.urlMatches(observed, postcondition.expectedNewPageUrl),
        expected: postcondition.expectedNewPageUrl.url,
        observed,
      });
    }

    if (postcondition.expectedDownload === true) {
      const downloads = await this.downloadManager.after(downloadCursorBeforeDispatch);
      checks.push({
        kind: 'download',
        passed: downloads.length > 0,
        expected: true,
        observed: downloads.length > 0,
      });
    }

    if (postcondition.expectedSelected !== null) {
      const observed = await this.selectedState(clickedLocator);
      checks.push({
        kind: 'selected',
        passed: observed === postcondition.expectedSelected,
        expected: postcondition.expectedSelected,
        observed,
      });
    }

    if (postcondition.expectedVisible !== null) {
      const expectation = postcondition.expectedVisible;
      let observed = false;
      try {
        const frame = expectation.frameId === null
          ? page.mainFrame()
          : this.resolveFrame(page, expectation.frameId);
        const locator = frame.getByRole(expectation.role, {
          name: expectation.name,
          exact: expectation.exact,
        });
        if ((await locator.count()) === 1) {
          if (POPUP_RENDERED_STATE_ROLES.has(expectation.role.toLocaleLowerCase())) {
            const state = await inspectTargetState(locator);
            observed = state?.visible === true && state.inViewport;
          } else {
            observed = await locator.isVisible();
          }
        }
      } catch {
        observed = false;
      }
      checks.push({
        kind: 'visible',
        passed: observed,
        expected: true,
        observed,
      });
    }

    if (postcondition.expectedHidden !== undefined && postcondition.expectedHidden !== null) {
      const expectation = postcondition.expectedHidden;
      let observed: boolean | null = null;
      try {
        const frame = expectation.frameId === null
          ? page.mainFrame()
          : this.resolveFrame(page, expectation.frameId);
        const locator = frame.getByRole(expectation.role, {
          name: expectation.name,
          exact: expectation.exact,
          includeHidden: true,
        });
        const count = await locator.count();
        if (count === 0) {
          observed = false;
        } else if (count === 1) {
          observed = await locator.isVisible();
        }
      } catch {
        // A missing frame or failed observation is not proof that the requested
        // semantic element became hidden. Preserve fail-closed uncertainty.
        observed = null;
      }
      checks.push({
        kind: 'visible',
        passed: observed === false,
        expected: false,
        observed,
      });
    }

    if (clickedFrame.isDetached() && postcondition.expectedSelected !== null) {
      const selected = checks.find((check) => check.kind === 'selected');
      if (selected !== undefined) {
        selected.passed = false;
        selected.observed = null;
      }
    }
    return checks;
  },

  async selectedState(locator: Locator): Promise<boolean | null> {
    try {
      return await locator.evaluate((element) => {
        const candidates: Element[] = [element];
        let ancestor = element.parentElement;
        for (let depth = 0; depth < 3 && ancestor !== null; depth += 1) {
          candidates.push(ancestor);
          ancestor = ancestor.parentElement;
        }
        for (const candidate of candidates) {
          const controlledPopupVisible = (): boolean => [
            ...(candidate.getAttribute('aria-controls') ?? '').split(/\s+/),
            ...(candidate.getAttribute('aria-owns') ?? '').split(/\s+/),
          ].filter(Boolean).some((id) => {
            const controlled = candidate.ownerDocument.getElementById(id);
            if (controlled === null) return false;
            const role = (controlled.getAttribute('role') ?? '').toLocaleLowerCase();
            if (role !== 'listbox' && role !== 'menu' && role !== 'tree') return false;
            const rect = controlled.getBoundingClientRect();
            const style = getComputedStyle(controlled);
            return rect.width > 0 && rect.height > 0 &&
              rect.right > 0 && rect.bottom > 0 &&
              rect.left < innerWidth && rect.top < innerHeight &&
              style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
          });
          const ariaSelected = candidate.getAttribute('aria-selected');
          if (ariaSelected !== null) {
            return ariaSelected === 'true';
          }
          const ariaChecked = candidate.getAttribute('aria-checked');
          if (ariaChecked !== null) {
            return ariaChecked === 'true';
          }
          const ariaPressed = candidate.getAttribute('aria-pressed');
          if (ariaPressed !== null) {
            return ariaPressed === 'true';
          }
          const ariaExpanded = candidate.getAttribute('aria-expanded');
          if (ariaExpanded !== null) {
            return ariaExpanded === 'true' || controlledPopupVisible();
          }
          if (controlledPopupVisible()) return true;
          const ariaCurrent = candidate.getAttribute('aria-current');
          if (ariaCurrent !== null) {
            return ariaCurrent !== 'false';
          }
          if (candidate instanceof HTMLOptionElement) {
            return candidate.selected;
          }
          if (candidate instanceof HTMLInputElement && (candidate.type === 'checkbox' || candidate.type === 'radio')) {
            return candidate.checked;
          }
        }
        return null;
      });
    } catch {
      return null;
    }
  },

  async visibleExpectationObserved(
    page: Page,
    expectation: VisibleElementExpectation,
  ): Promise<boolean> {
    try {
      const frame = expectation.frameId === null
        ? page.mainFrame()
        : this.resolveFrame(page, expectation.frameId);
      const locator = frame.getByRole(expectation.role, {
        name: expectation.name,
        exact: expectation.exact,
      });
      return (await locator.count()) === 1 && await locator.isVisible();
    } catch {
      return false;
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type InputPostconditionsOperations = typeof inputPostconditionsOperations;
