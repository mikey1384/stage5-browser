import { type Browser, type BrowserCommandInput, type ElementHandle, type Frame, type ObservedScrollContainer, type Page, type ScrollDirection, type ScrollPosition, type ScrollWaitResult, Stage5BrowserError } from '../dependencies.js';
import { type ScrollContentObservationSurface, type ScrollContentSample } from '../model.js';
import { observeScrollContentForRoot } from './content-observation.js';
import { publicScrollContentObservation } from './content-observation.js';
import type { BrowserControllerContext } from '../runtime.js';

export const scrollHelpersOperations = {
  resolveObservedScrollContainer(
    frame: Frame,
    target: BrowserCommandInput<'scroll'>['target'],
  ): ObservedScrollContainer | null {
    if (target === null || target === undefined) {
      return null;
    }
    const observed = this.observedSnapshots.get(frame);
    if (
      observed === undefined ||
      observed.id !== target.snapshotId ||
      observed.documentVersion !== this.documentVersion(frame)
    ) {
      throw new Stage5BrowserError(
        'TARGET_NOT_FOUND',
        'The scroll-container reference does not belong to the latest snapshot of the current document.',
        {
          details: {
            reason: 'stale_or_unknown_snapshot',
            snapshotId: target.snapshotId,
            frameId: this.frameIds.get(frame) ?? null,
          },
        },
      );
    }
    const container = observed.scrollContainers.get(target.ref);
    if (container === undefined) {
      throw new Stage5BrowserError(
        'TARGET_NOT_FOUND',
        'The requested scroll-container reference was not present in that snapshot.',
        {
          details: {
            reason: 'scroll_container_reference_not_observed',
            ref: target.ref,
            snapshotId: target.snapshotId,
          },
        },
      );
    }
    return container;
  },

  async scrollPosition(
    frame: Frame,
    target: ElementHandle<HTMLElement> | null,
  ): Promise<ScrollPosition> {
    if (target !== null) {
      return target.evaluate((element) => ({
        x: element.scrollLeft,
        y: element.scrollTop,
        maxX: Math.max(0, element.scrollWidth - element.clientWidth),
        maxY: Math.max(0, element.scrollHeight - element.clientHeight),
        viewportWidth: element.clientWidth,
        viewportHeight: element.clientHeight,
        contentWidth: element.scrollWidth,
        contentHeight: element.scrollHeight,
      }));
    }
    return frame.evaluate(() => {
      const root = (document.scrollingElement ?? document.documentElement) as HTMLElement;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const contentWidth = Math.max(
        root.scrollWidth,
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0,
      );
      const contentHeight = Math.max(
        root.scrollHeight,
        document.documentElement.scrollHeight,
        document.body?.scrollHeight ?? 0,
      );
      return {
        x: root.scrollLeft,
        y: root.scrollTop,
        maxX: Math.max(0, contentWidth - viewportWidth),
        maxY: Math.max(0, contentHeight - viewportHeight),
        viewportWidth,
        viewportHeight,
        contentWidth,
        contentHeight,
      };
    });
  },

  async performScrollStep(
    frame: Frame,
    direction: ScrollDirection,
    amount: 'half_viewport' | 'viewport' | 'document_start' | 'document_end',
    target: ElementHandle<HTMLElement> | null,
  ): Promise<void> {
    if (target !== null) {
      await target.evaluate((element, { direction: fixedDirection, amount: fixedAmount }) => {
        const horizontal = fixedDirection === 'left' || fixedDirection === 'right';
        if (fixedAmount === 'document_start') {
          element.scrollTo({ left: horizontal ? 0 : element.scrollLeft, top: horizontal ? element.scrollTop : 0, behavior: 'instant' });
          return;
        }
        if (fixedAmount === 'document_end') {
          element.scrollTo({ left: horizontal ? element.scrollWidth : element.scrollLeft, top: horizontal ? element.scrollTop : element.scrollHeight, behavior: 'instant' });
          return;
        }
        const multiplier = fixedAmount === 'half_viewport' ? 0.5 : 1;
        const sign = fixedDirection === 'down' || fixedDirection === 'right' ? 1 : -1;
        element.scrollBy({ left: horizontal ? element.clientWidth * multiplier * sign : 0, top: horizontal ? 0 : element.clientHeight * multiplier * sign, behavior: 'instant' });
      }, { direction, amount });
      return;
    }
    await frame.evaluate(({ direction: fixedDirection, amount: fixedAmount }) => {
      const root = (document.scrollingElement ?? document.documentElement) as HTMLElement;
      const horizontal = fixedDirection === 'left' || fixedDirection === 'right';
      if (fixedAmount === 'document_start') {
        root.scrollTo({ left: horizontal ? 0 : root.scrollLeft, top: horizontal ? root.scrollTop : 0, behavior: 'instant' });
        return;
      }
      if (fixedAmount === 'document_end') {
        root.scrollTo({ left: horizontal ? root.scrollWidth : root.scrollLeft, top: horizontal ? root.scrollTop : root.scrollHeight, behavior: 'instant' });
        return;
      }
      const multiplier = fixedAmount === 'half_viewport' ? 0.5 : 1;
      const sign = fixedDirection === 'down' || fixedDirection === 'right' ? 1 : -1;
      root.scrollBy({ left: horizontal ? window.innerWidth * multiplier * sign : 0, top: horizontal ? 0 : window.innerHeight * multiplier * sign, behavior: 'instant' });
    }, { direction, amount });
  },

  async scrollContentObservation(
    frame: Frame,
    surface: ScrollContentObservationSurface,
  ): Promise<ScrollContentSample | null> {
    try {
      if (surface.handle !== null) {
        return await surface.handle.evaluate(observeScrollContentForRoot);
      }
      return await frame.evaluate(observeScrollContentForRoot, null);
    } catch (error) {
      if (surface.handle !== null) {
        const stillConnected = await surface.handle.evaluate((element) => element.isConnected)
          .catch(() => false);
        if (!stillConnected) {
          return null;
        }
      }
      if (error instanceof Error && error.message.includes('scroll_content_observation_incomplete')) {
        throw new Stage5BrowserError(
          'OPERATION_FAILED',
          'The selected scroll surface exceeded the bounded semantic observation limits.',
          {
            recoverable: true,
            details: {
              reason: 'scroll_observation_incomplete',
              suggestedAction: 'Use one fresh snapshot to target a smaller observed scroll container; Stage5 Browser will not infer growth or loader disappearance from a truncated sample.',
            },
            cause: error,
          },
        );
      }
      throw error;
    }
  },

  async resolveScrollContentObservationSurface(
    frame: Frame,
    target: ElementHandle<HTMLElement> | null,
  ): Promise<ScrollContentObservationSurface> {
    if (target !== null) {
      return { handle: target, ownsHandle: false };
    }
    const candidate = await frame.evaluateHandle(() => {
      const viewportIntersects = (candidate: Element): boolean => {
        const rect = candidate.getBoundingClientRect();
        const style = getComputedStyle(candidate);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none'
          && style.visibility !== 'hidden' && style.opacity !== '0'
          && rect.bottom > 0 && rect.right > 0
          && rect.top < window.innerHeight && rect.left < window.innerWidth;
      };
      const visible = Array.from(document.querySelectorAll('[role="feed"]'))
        .filter(viewportIntersects);
      return visible.length === 1 ? visible[0] ?? null : null;
    });
    const handle = candidate.asElement();
    if (handle === null) {
      await candidate.dispose().catch(() => undefined);
      return { handle: null, ownsHandle: false };
    }
    return { handle: handle as ElementHandle<HTMLElement>, ownsHandle: true };
  },

  async waitForScrollContent(
    page: Page,
    frame: Frame,
    surface: ScrollContentObservationSurface,
    before: ScrollContentSample,
    expectation: BrowserCommandInput<'scroll'>['waitFor'],
    remainingTimeoutMs: number,
    visibilityGuard?: () => Promise<void>,
  ): Promise<ScrollWaitResult> {
    const observationSurfaceUnavailable = (): Stage5BrowserError => new Stage5BrowserError(
      'OPERATION_FAILED',
      'The pinned scroll observation surface was replaced before comparable content evidence could be collected.',
      {
        recoverable: true,
        details: {
          reason: 'scroll_observation_surface_unavailable',
          suggestedAction: 'Inspect one fresh snapshot before continuing; Stage5 Browser will not compare or replay against a replacement surface.',
        },
      },
    );
    if (expectation === null || expectation === undefined) {
      const after = await this.scrollContentObservation(frame, surface);
      if (after === null) {
        throw observationSurfaceUnavailable();
      }
      return {
        requested: false,
        condition: null,
        satisfied: false,
        evidence: 'not_requested',
        waitedMs: 0,
        before: publicScrollContentObservation(before),
        after: publicScrollContentObservation(after),
      };
    }
    const startedAt = Date.now();
    const budgetMs = Math.max(0, Math.min(expectation.timeoutMs, remainingTimeoutMs));
    await visibilityGuard?.();
    const initialObservation = await this.scrollContentObservation(frame, surface);
    if (initialObservation === null) {
      throw observationSurfaceUnavailable();
    }
    let after = initialObservation;
    let loadingObserved = before.loadingIndicatorCount > 0 || after.loadingIndicatorCount > 0;
    let semanticLoadingObserved = before.semanticLoadingIndicatorCount > 0 ||
      after.semanticLoadingIndicatorCount > 0;
    let genericTextLoadingObserved = before.genericTextLoadingIndicatorCount > 0 ||
      after.genericTextLoadingIndicatorCount > 0;
    let genericTextLoadingObservationComplete = before.genericTextLoadingObservationComplete &&
      after.genericTextLoadingObservationComplete;
    let animationObservationComplete = before.animationObservationComplete &&
      after.animationObservationComplete;
    while (true) {
      const elapsed = Date.now() - startedAt;
      const articleGrew = after.articleCount > before.articleCount;
      const loadingDisappeared = loadingObserved &&
        after.loadingIndicatorCount === 0 &&
        (
          semanticLoadingObserved ||
          (genericTextLoadingObserved
            ? genericTextLoadingObservationComplete
            : animationObservationComplete)
        );
      const satisfied = expectation.condition === 'article_count_growth'
        ? articleGrew
        : expectation.condition === 'loading_indicators_disappear'
          ? loadingDisappeared
          : articleGrew || loadingDisappeared;
      if (satisfied && elapsed <= budgetMs) {
        return {
          requested: true,
          condition: expectation.condition,
          satisfied: true,
          evidence: expectation.condition === 'article_count_growth'
            ? 'article_count_growth'
            : expectation.condition === 'loading_indicators_disappear'
              ? 'loading_indicators_disappeared'
              : articleGrew
                ? 'article_count_growth'
                : 'loading_indicators_disappeared',
          waitedMs: elapsed,
          before: publicScrollContentObservation(before),
          after: publicScrollContentObservation(after),
        };
      }
      if (elapsed >= budgetMs) {
        const loadingEvidenceRequested = expectation.condition === 'loading_indicators_disappear' ||
          expectation.condition === 'either';
        if (
          loadingEvidenceRequested &&
          !semanticLoadingObserved &&
          loadingObserved &&
          after.loadingIndicatorCount === 0 &&
          !(genericTextLoadingObserved
            ? genericTextLoadingObservationComplete
            : animationObservationComplete)
        ) {
          throw new Stage5BrowserError(
            'OPERATION_FAILED',
            'The selected scroll surface exceeded a bounded heuristic loading-observation limit.',
            {
              recoverable: true,
              details: {
                reason: 'scroll_observation_incomplete',
                suggestedAction: 'Use one fresh snapshot to target a smaller observed scroll container; Stage5 Browser will not infer disappearance from a truncated generic-text or animation sample.',
              },
            },
          );
        }
        return {
          requested: true,
          condition: expectation.condition,
          satisfied: false,
          evidence: 'timeout',
          waitedMs: elapsed,
          before: publicScrollContentObservation(before),
          after: publicScrollContentObservation(after),
        };
      }
      await page.waitForTimeout(Math.min(100, Math.max(1, budgetMs - elapsed)));
      await visibilityGuard?.();
      const observed = await this.scrollContentObservation(frame, surface);
      if (observed === null) {
        throw observationSurfaceUnavailable();
      }
      after = observed;
      loadingObserved ||= after.loadingIndicatorCount > 0;
      semanticLoadingObserved ||= after.semanticLoadingIndicatorCount > 0;
      genericTextLoadingObserved ||= after.genericTextLoadingIndicatorCount > 0;
      genericTextLoadingObservationComplete &&=
        after.genericTextLoadingObservationComplete;
      animationObservationComplete &&= after.animationObservationComplete;
    }
  },

  async countNestedScrollContainerCandidates(frame: Frame): Promise<number> {
    return frame.locator('body *').evaluateAll((elements) => elements.reduce((count, element) => {
      if (!(element instanceof HTMLElement)) {
        return count;
      }
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none'
        && style.visibility !== 'hidden' && style.opacity !== '0';
      const vertical = (style.overflowY === 'auto' || style.overflowY === 'scroll'
        || style.overflowY === 'overlay' || element.scrollTop > 0)
        && element.scrollHeight - element.clientHeight > 1;
      const horizontal = (style.overflowX === 'auto' || style.overflowX === 'scroll'
        || style.overflowX === 'overlay' || element.scrollLeft > 0)
        && element.scrollWidth - element.clientWidth > 1;
      return visible && (vertical || horizontal)
        ? count + 1
        : count;
    }, 0));
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type ScrollHelpersOperations = typeof scrollHelpersOperations;
