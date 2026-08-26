import { type BrowserCommandOutput, type FileProcessingExpectation, type FileSelectionWarning, type Frame, type Page, PageDiagnosticBuffer } from '../dependencies.js';
import { type ProgressSample } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const inputFileProcessingOperations = {
  async progressSample(frame: Frame): Promise<ProgressSample> {
    try {
      return await frame.locator('progress, [role="progressbar"]').evaluateAll((elements) => {
        let visibleCount = 0;
        let activeCount = 0;
        let completedCount = 0;
        let maxPercent: number | null = null;
        for (const element of elements) {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const visible =
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0';
          if (!visible) {
            continue;
          }
          visibleCount += 1;
          const nativeNow = element instanceof HTMLProgressElement ? element.value : Number.NaN;
          const nativeMax = element instanceof HTMLProgressElement ? element.max : Number.NaN;
          const ariaNow = Number.parseFloat(element.getAttribute('aria-valuenow') ?? '');
          const ariaMax = Number.parseFloat(element.getAttribute('aria-valuemax') ?? '');
          const now = Number.isFinite(nativeNow) ? nativeNow : ariaNow;
          const max = Number.isFinite(nativeMax) && nativeMax > 0 ? nativeMax : ariaMax;
          if (Number.isFinite(now) && Number.isFinite(max) && max > 0) {
            const percent = Math.max(0, Math.min(100, (now / max) * 100));
            maxPercent = maxPercent === null ? percent : Math.max(maxPercent, percent);
            if (now >= max) {
              completedCount += 1;
            } else {
              activeCount += 1;
            }
          } else {
            activeCount += 1;
          }
        }
        return { visibleCount, activeCount, completedCount, maxPercent };
      });
    } catch {
      return { visibleCount: 0, activeCount: 0, completedCount: 0, maxPercent: null };
    }
  },

  async observeFileProcessing(
    page: Page,
    frame: Frame,
    expectation: FileProcessingExpectation | null,
    observationMs: number,
    remainingTimeoutMs: number,
    diagnosticsBefore: ReturnType<PageDiagnosticBuffer['snapshot']>,
    baseline: {
      completeVisible: boolean;
      errorVisible: boolean;
      progress: ProgressSample;
    },
  ): Promise<{
    result: BrowserCommandOutput<'setInputFiles'>['processing'];
    warnings: FileSelectionWarning[];
  }> {
    const budgetMs = Math.max(
      0,
      Math.min(expectation?.timeoutMs ?? observationMs, remainingTimeoutMs),
    );
    const startedAt = Date.now();
    let progressObserved = false;
    let completionValueObserved = false;
    let maxPercentObserved: number | null = null;
    let finalProgress: ProgressSample = {
      visibleCount: 0,
      activeCount: 0,
      completedCount: 0,
      maxPercent: null,
    };
    let expectedCompletionObserved = false;
    let expectedErrorObserved = false;
    let completionMarkerWasAbsent = !baseline.completeVisible;
    let errorMarkerWasAbsent = !baseline.errorVisible;
    let completedProgressWasAbsent = baseline.progress.completedCount === 0;

    while (true) {
      finalProgress = await this.progressSample(frame);
      progressObserved ||= finalProgress.visibleCount > 0;
      if (finalProgress.completedCount === 0) {
        completedProgressWasAbsent = true;
      } else if (completedProgressWasAbsent) {
        completionValueObserved = true;
      }
      if (finalProgress.maxPercent !== null) {
        maxPercentObserved = maxPercentObserved === null
          ? finalProgress.maxPercent
          : Math.max(maxPercentObserved, finalProgress.maxPercent);
      }
      if (expectation?.expectedError !== null && expectation?.expectedError !== undefined) {
        const visible = await this.visibleExpectationObserved(page, expectation.expectedError);
        if (!visible) {
          errorMarkerWasAbsent = true;
        } else if (errorMarkerWasAbsent) {
          expectedErrorObserved = true;
        }
      }
      if (!expectedErrorObserved && expectation?.expectedComplete !== null && expectation?.expectedComplete !== undefined) {
        const visible = await this.visibleExpectationObserved(page, expectation.expectedComplete);
        if (!visible) {
          completionMarkerWasAbsent = true;
        } else if (completionMarkerWasAbsent) {
          expectedCompletionObserved = true;
        }
      }
      if (expectedErrorObserved || expectedCompletionObserved || completionValueObserved) {
        break;
      }
      const remaining = budgetMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        break;
      }
      await page.waitForTimeout(Math.min(200, remaining));
    }

    const diagnosticsAfter = this.pageDiagnostics.snapshot(page);
    const successfulResponses = Math.max(
      0,
      diagnosticsAfter.totals.httpSuccesses - diagnosticsBefore.totals.httpSuccesses,
    );
    const redirects = Math.max(
      0,
      diagnosticsAfter.totals.httpRedirects - diagnosticsBefore.totals.httpRedirects,
    );
    const httpErrors = Math.max(
      0,
      diagnosticsAfter.totals.httpErrors - diagnosticsBefore.totals.httpErrors,
    );
    const failedRequests = Math.max(
      0,
      diagnosticsAfter.totals.failedRequests - diagnosticsBefore.totals.failedRequests,
    );
    const networkErrorObserved = httpErrors > 0 || failedRequests > 0;
    const activeAtReturn = finalProgress.activeCount > 0;
    const disappearedAfterObservation = progressObserved && finalProgress.visibleCount === 0;

    let state: BrowserCommandOutput<'setInputFiles'>['processing']['state'];
    let evidence: BrowserCommandOutput<'setInputFiles'>['processing']['evidence'];
    if (expectedErrorObserved) {
      state = 'error_observed';
      evidence = 'expected_error_visible';
    } else if (expectedCompletionObserved) {
      state = 'completion_observed';
      evidence = 'expected_completion_visible';
    } else if (completionValueObserved) {
      state = 'completion_observed';
      evidence = 'progress_complete';
    } else if (activeAtReturn) {
      state = 'in_progress';
      evidence = 'progress_active';
    } else if (networkErrorObserved) {
      state = 'error_observed';
      evidence = 'network_error_observed';
    } else if (disappearedAfterObservation) {
      state = 'unverified';
      evidence = 'progress_disappeared';
    } else {
      state = 'unverified';
      evidence = 'none';
    }

    const warnings: FileSelectionWarning[] = [];
    if (
      (baseline.completeVisible && !expectedCompletionObserved) ||
      (baseline.errorVisible && !expectedErrorObserved) ||
      (baseline.progress.visibleCount > 0 && !completionValueObserved)
    ) {
      warnings.push({
        code: 'processing_marker_preexisting',
        message: 'A supplied completion/error marker or completed progress control was already present before file selection and did not make a new transition.',
        suggestedAction: 'Treat the pre-existing marker as non-causal and inspect the fresh attachment preview for a new processing state.',
      });
    }
    if (state === 'error_observed') {
      warnings.push({
        code: 'processing_error_observed',
        message: expectedErrorObserved
          ? 'The caller-supplied processing error marker became visible.'
          : 'A failed request or HTTP error occurred during the bounded post-selection window; attribution to this upload is temporal only.',
        suggestedAction: 'Inspect the fresh attachment preview and page diagnostics before retrying or removing the attachment.',
      });
    }
    if (disappearedAfterObservation && !completionValueObserved && !expectedCompletionObserved) {
      warnings.push({
        code: 'progress_disappeared_unverified',
        message: 'A semantic progress control disappeared without an explicit completion value or caller-supplied completion marker.',
        suggestedAction: 'Treat processing as unverified and inspect the fresh preview; do not assume disappearance means success.',
      });
    }
    if (state === 'unverified') {
      warnings.push({
        code: 'processing_completion_unverified',
        message: 'The file-selection event was confirmed, but no explicit processing-completion signal was observed.',
        suggestedAction: 'Use the returned fresh snapshotId and preview, then inspect or wait for a service-visible completion state before posting.',
      });
    }

    return {
      result: {
        state,
        evidence,
        progress: {
          observed: progressObserved,
          activeAtReturn,
          completionValueObserved,
          disappearedAfterObservation,
          maxPercentObserved,
        },
        pageActivity: {
          attribution: 'temporal_only',
          observationMs: Date.now() - startedAt,
          successfulResponses,
          redirects,
          httpErrors,
          failedRequests,
        },
      },
      warnings,
    };
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type InputFileProcessingOperations = typeof inputFileProcessingOperations;
