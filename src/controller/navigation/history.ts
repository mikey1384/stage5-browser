import { type BrowserCommandInput, type BrowserCommandOutput, type Frame, type NavigationWarning, type Page, type Response, Stage5BrowserError } from '../dependencies.js';
import { fillFinalizationReserve, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const navigationHistoryOperations = {
  async navigateHistory(
    input: BrowserCommandInput<'navigateHistory'>,
  ): Promise<BrowserCommandOutput<'navigateHistory'>> {
    const page = await this.ensureActivePage(this.requireContext());
    const phases = this.actionPhases.begin(`navigate_${input.action}`, input.timeoutMs);
    const actionDeadlineAt = phases.deadlineAtMs - fillFinalizationReserve(input.timeoutMs);
    const beforeUrl = page.url();
    let response: Response | null = null;
    let dispatchError: unknown = null;
    let stateRisk: BrowserCommandOutput<'navigateHistory'>['stateRisk'] = null;
    let mainFrameNavigated = false;
    const onFrameNavigated = (frame: Frame): void => {
      if (frame === page.mainFrame()) mainFrameNavigated = true;
    };
    page.on('framenavigated', onFrameNavigated);
    try {
      phases.enter('observe');
      phases.enter('plan');
      phases.enter('preflight');
      if (page.isClosed()) {
        throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The selected page closed before history navigation.', {
          recoverable: true,
          details: { reason: 'selected_page_closed', actionDispatched: false },
        });
      }
      stateRisk = this.pageStateRiskManager.preflightNavigation(
        page,
        input.acknowledgeStateRisk ?? false,
        'navigation',
      );
      await this.persistNativePageStateRisk(page);
      phases.enter('prepare');
      this.discardAllObservedSnapshots();
      this.discardAllControlInspections();
      phases.beginDispatch();
      try {
        const options = { waitUntil: 'commit' as const, timeout: Math.max(1, remainingUntil(actionDeadlineAt)) };
        response = input.action === 'back'
          ? await page.goBack(options)
          : input.action === 'forward'
            ? await page.goForward(options)
            : await page.reload(options);
      } catch (error) {
        dispatchError = error;
      }
      const finalUrlBeforeReadiness = page.url();
      const moved = finalUrlBeforeReadiness !== beforeUrl;
      const actionDispatched: true | false | 'unknown' = mainFrameNavigated || moved
        ? true
        : dispatchError === null
          ? input.action === 'reload' ? 'unknown' : false
          : 'unknown';
      phases.concludeDispatch({ actionDispatched });
      phases.enter('reconcile');

      let readiness: BrowserCommandOutput<'navigateHistory'>['readiness'] = 'commit';
      const warnings: NavigationWarning[] = [];
      try {
        await page.waitForLoadState('domcontentloaded', {
          timeout: Math.min(this.config.readinessTimeoutMs, Math.max(1, remainingUntil(actionDeadlineAt))),
        });
        readiness = 'domcontentloaded';
      } catch {
        warnings.push({
          code: 'dom_readiness_timeout',
          message: 'History navigation changed browser state, but DOM readiness was not observed inside its bounded reserve.',
          status: response?.status() ?? null,
          suggestedAction: 'Inspect the current page state before another navigation.',
        });
      }
      const stabilizationMs = Math.min(input.stabilizationMs, remainingUntil(actionDeadlineAt));
      if (stabilizationMs > 0) await page.waitForTimeout(stabilizationMs);
      const finalUrl = page.url();
      const effectObserved = mainFrameNavigated || finalUrl !== beforeUrl;
      if (input.expectedUrl !== null && !this.urlMatches(finalUrl, input.expectedUrl)) {
        throw new Stage5BrowserError('POSTCONDITION_FAILED', 'History navigation did not reach the requested URL state.', {
          recoverable: true,
          details: {
            reason: 'history_url_postcondition_not_met',
            actionDispatched,
            expectedUrl: this.safeObservedUrl(input.expectedUrl.url),
            currentUrl: this.safeObservedUrl(finalUrl),
            suggestedAction: actionDispatched === false
              ? 'Inspect the available history state before choosing another navigation.'
              : 'Inspect the current page. Possible navigation occurred; do not replay automatically.',
          },
          cause: dispatchError,
        });
      }
      if (dispatchError !== null && !effectObserved && input.expectedUrl === null) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The history navigation outcome is ambiguous.', {
          recoverable: true,
          details: {
            reason: 'history_navigation_outcome_unknown',
            actionDispatched,
            suggestedAction: 'Inspect the current URL and page state. Do not replay the navigation automatically.',
          },
          cause: dispatchError,
        });
      }
      warnings.push(...this.httpWarnings(response?.status() ?? null));
      this.lastKnownUrl = finalUrl;
      await this.persistNativeSelectedPage(page);
      phases.beginFinalization();
      const result = {
        page: await this.pageSummary(page, undefined, remainingUntil(phases.deadlineAtMs)),
        stateRisk,
        action: input.action,
        actionDispatched,
        beforeUrl: this.safeObservedUrl(beforeUrl),
        finalUrl: this.safeObservedUrl(finalUrl),
        moved: finalUrl !== beforeUrl,
        readiness,
        responseStatus: response?.status() ?? null,
        stabilizationMs,
        warnings,
      };
      phases.complete('succeeded');
      return result;
    } catch (error) {
      if (phases.snapshot().currentPhase === 'dispatch') {
        phases.concludeDispatch({ actionDispatched: 'unknown' });
        phases.enter('reconcile');
      }
      phases.beginFinalization();
      phases.complete('failed');
      throw error;
    } finally {
      page.off('framenavigated', onFrameNavigated);
      phases.ensureFailed();
      this.actionPhases.finish(phases);
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type NavigationHistoryOperations = typeof navigationHistoryOperations;
