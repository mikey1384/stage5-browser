import { type Browser, type BrowserCommandInput, type BrowserCommandOutput, inspectScrollContainer, type SanitizedPageActivationEvidence, type ScrollEndState, type ScrollPosition, Stage5BrowserError } from '../dependencies.js';
import { boundedValue, remainingUntil, SCROLL_BOUNDARY_EPSILON_PX, type ScrollContentObservationSurface, scrollFinalizationReserve } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const scrollActionOperations = {
  async scroll(input: BrowserCommandInput<'scroll'>): Promise<BrowserCommandOutput<'scroll'>> {
    const page = await this.ensureActivePage(this.requireContext());
    const frame = this.resolveFrame(page, input.frameId);
    const observedTarget = this.resolveObservedScrollContainer(frame, input.target);
    const targetHandle = observedTarget?.handle ?? null;
    if (targetHandle !== null && await inspectScrollContainer(targetHandle) === null) {
      throw new Stage5BrowserError(
        'TARGET_NOT_FOUND',
        'The observed nested scroll container is no longer attached or scrollable.',
        {
          recoverable: true,
          details: {
            reason: 'scroll_container_no_longer_available',
            ref: input.target?.ref ?? null,
            suggestedAction: 'Take one fresh snapshot and select a currently exposed scroll-container ref.',
          },
        },
      );
    }
    const startedAt = Date.now();
    const operationDeadlineAt = startedAt + input.timeoutMs;
    const actionDeadlineAt = operationDeadlineAt - scrollFinalizationReserve(input.timeoutMs);
    const actionStartedAt = new Date(startedAt).toISOString();
    this.pageDiagnostics.beginAction(page, actionStartedAt);
    if (targetHandle !== null) {
      this.consumeObservedSnapshot(frame, targetHandle);
    }
    let observationSurface: ScrollContentObservationSurface | null = null;
    let stepsCompleted = 0;
    let contentGrew = false;
    let finalStepMoved = false;
    let finalStepGrew = false;
    let actionDispatched: boolean | 'unknown' = false;

    const activateBeforeScroll = async (attemptCount: number): Promise<void> => {
      const activationFallback: SanitizedPageActivationEvidence = {
        attemptCount,
        controllerSelected: this.preferredPage() === page,
        bringToFrontAttempted: true,
        bringToFrontSucceeded: false,
        visibilityBefore: 'unknown',
        visibilityAfter: 'unknown',
        documentFocusedBefore: null,
        documentFocusedAfter: null,
        nativeWindow: this.nativeWindowActivationNotRequired(),
      };
      const pageActivation = await boundedValue(
        this.activateSelectedPageForInput(page, attemptCount),
        Math.max(1, remainingUntil(actionDeadlineAt)),
        activationFallback,
      );
      if (this.pageIsActivatedForInput(pageActivation)) {
        return;
      }
      const priorScrollDispatched = stepsCompleted > 0 || actionDispatched === true;
      throw new Stage5BrowserError(
        'OPERATION_FAILED',
        'The controller-selected page could not become the visible scroll target.',
        {
          recoverable: true,
          details: {
            reason: 'page_not_active',
            actionDispatched: priorScrollDispatched,
            clickDispatched: null,
            stepsCompleted,
            pageActivation,
            suggestedAction: priorScrollDispatched
              ? 'Inspect one fresh snapshot before continuing. Earlier scroll steps completed and Stage5 Browser did not replay them.'
              : 'Explicitly select the intended tab, obtain one fresh snapshot, and scroll only after the renderer can become visible.',
          },
        },
      );
    };

    try {
      await activateBeforeScroll(1);
      observationSurface = await this.resolveScrollContentObservationSurface(frame, targetHandle);
      const before = await this.scrollPosition(frame, targetHandle);
      let contentBefore = await this.scrollContentObservation(frame, observationSurface);
      if (contentBefore === null && observationSurface.ownsHandle) {
        await observationSurface.handle?.dispose().catch(() => undefined);
        observationSurface = { handle: null, ownsHandle: false };
        contentBefore = await this.scrollContentObservation(frame, observationSurface);
      }
      if (contentBefore === null) {
        throw new Stage5BrowserError(
          'OPERATION_FAILED',
          'The selected scroll observation surface was unavailable before dispatch.',
          {
            recoverable: true,
            details: {
              reason: 'scroll_observation_surface_unavailable',
              actionDispatched: false,
              stepsCompleted: 0,
              suggestedAction: 'Take one fresh snapshot and select the intended current scroll surface before another attempt.',
            },
          },
        );
      }
      let previous = before;
      for (let step = 0; step < input.count; step += 1) {
        if (remainingUntil(actionDeadlineAt) <= input.settleMs) {
          break;
        }
        await activateBeforeScroll(step + 2);
        if (remainingUntil(actionDeadlineAt) <= 0) {
          break;
        }
        actionDispatched = 'unknown';
        await this.performScrollStep(frame, input.direction, input.amount, targetHandle);
        actionDispatched = true;
        stepsCompleted += 1;
        const settleBudgetMs = Math.min(input.settleMs, remainingUntil(actionDeadlineAt));
        if (settleBudgetMs > 0) {
          await page.waitForTimeout(settleBudgetMs);
        }
        const positionBudgetMs = remainingUntil(actionDeadlineAt);
        if (positionBudgetMs <= 0) {
          break;
        }
        const current = await boundedValue<ScrollPosition | null>(
          this.scrollPosition(frame, targetHandle),
          positionBudgetMs,
          null,
        );
        if (current === null) {
          break;
        }
        finalStepMoved = previous.x !== current.x || previous.y !== current.y;
        finalStepGrew =
          current.contentHeight > previous.contentHeight ||
          current.contentWidth > previous.contentWidth;
        contentGrew ||= finalStepGrew;
        previous = current;
        if (input.amount === 'document_start' || input.amount === 'document_end') {
          break;
        }
      }

      const wait = await this.waitForScrollContent(
        page,
        frame,
        observationSurface,
        contentBefore,
        input.waitFor,
        remainingUntil(actionDeadlineAt),
      );
      const after = await boundedValue(
        this.scrollPosition(frame, targetHandle),
        Math.max(1, remainingUntil(operationDeadlineAt)),
        previous,
      );
      finalStepMoved ||= previous.x !== after.x || previous.y !== after.y;
      finalStepGrew ||=
        after.contentHeight > previous.contentHeight ||
        after.contentWidth > previous.contentWidth;
      const moved = before.x !== after.x || before.y !== after.y;
      contentGrew ||=
        finalStepGrew ||
        after.contentHeight > before.contentHeight ||
        after.contentWidth > before.contentWidth;
      const horizontal = input.direction === 'left' || input.direction === 'right';
      const movingTowardStart =
        input.amount === 'document_start' ||
        (input.amount !== 'document_end' && (input.direction === 'up' || input.direction === 'left'));
      const targetBoundaryReached = input.amount === 'document_start'
        ? (horizontal ? after.x : after.y) <= SCROLL_BOUNDARY_EPSILON_PX
        : input.amount === 'document_end'
          ? (horizontal ? after.maxX - after.x : after.maxY - after.y) <= SCROLL_BOUNDARY_EPSILON_PX
          : input.direction === 'down'
            ? after.maxY - after.y <= SCROLL_BOUNDARY_EPSILON_PX
            : input.direction === 'right'
              ? after.maxX - after.x <= SCROLL_BOUNDARY_EPSILON_PX
              : input.direction === 'left'
                ? after.x <= SCROLL_BOUNDARY_EPSILON_PX
                : after.y <= SCROLL_BOUNDARY_EPSILON_PX;
      const documentBoundaryReached = targetHandle === null && targetBoundaryReached;
      const priorHistory = targetHandle === null ? this.scrollHistories.get(frame) : undefined;
      const dynamicGrowthObserved = contentGrew || priorHistory?.dynamicGrowthObserved === true;
      if (targetHandle === null) {
        this.scrollHistories.set(frame, { dynamicGrowthObserved });
      }
      const endMarkerObserved = input.endMarker === null
        ? false
        : await boundedValue(
          this.visibleExpectationObserved(page, input.endMarker),
          Math.max(1, remainingUntil(operationDeadlineAt)),
          false,
        );
      const waitUnmet = wait.requested && !wait.satisfied;
      const dynamicContentStalled =
        targetBoundaryReached &&
        !movingTowardStart &&
        !finalStepMoved &&
        !finalStepGrew &&
        (dynamicGrowthObserved || waitUnmet || wait.after.loadingIndicatorCount > 0);
      let endState: ScrollEndState;
      if (endMarkerObserved) {
        endState = 'confirmed_by_marker';
      } else if (targetBoundaryReached && movingTowardStart) {
        endState = targetHandle === null ? 'confirmed_document_start' : 'confirmed_container_start';
      } else if (dynamicContentStalled) {
        endState = 'dynamic_content_stalled';
      } else if (targetBoundaryReached) {
        endState = 'geometric_boundary_unconfirmed';
      } else {
        endState = 'not_at_boundary';
      }
      const endReached =
        endState === 'confirmed_by_marker' ||
        endState === 'confirmed_document_start' ||
        endState === 'confirmed_container_start';
      const nestedScrollContainerCandidateCount = await boundedValue(
        this.countNestedScrollContainerCandidates(frame),
        Math.max(1, remainingUntil(operationDeadlineAt)),
        0,
      );
      const warnings: BrowserCommandOutput<'scroll'>['warnings'] = [];
      if (!moved && !contentGrew) {
        warnings.push({
          code: 'scroll_position_unchanged',
          message: 'The requested scroll did not change the selected scroll surface position or size.',
          suggestedAction: 'Inspect the current snapshot for an observed nested scroll container, a stalled dynamic feed, or an explicit end marker.',
        });
      }
      if (targetHandle === null && !moved && nestedScrollContainerCandidateCount > 0) {
        warnings.push({
          code: 'nested_scroll_containers_available',
          message: `${nestedScrollContainerCandidateCount} nested scroll-container candidate(s) are available in the active frame.`,
          suggestedAction: 'Take one fresh snapshot, select the intended scrollContainers ref, and pass it through browser_scroll.target. Do not guess a selector or container.',
        });
      }
      if (waitUnmet) {
        warnings.push({
          code: 'content_wait_timed_out',
          message: 'The bounded post-scroll wait did not observe the requested article growth or loading-indicator transition.',
          suggestedAction: 'Treat the feed as stalled, inspect the fresh page state and diagnostics, and do not claim that the timeline is complete.',
        });
      }
      if (dynamicContentStalled) {
        warnings.push({
          code: 'dynamic_content_stalled',
          message: 'The selected scroll surface is at its current geometric boundary while dynamic content remains unresolved; the feed end is not confirmed.',
          suggestedAction: 'Do not treat this as the end of the feed. Inspect loading state and scroll-correlated diagnostics, or target an observed nested container.',
        });
      } else if (endState === 'geometric_boundary_unconfirmed') {
        warnings.push({
          code: 'scroll_end_unconfirmed',
          message: 'The selected scroll surface reached its current geometric boundary without an explicit end marker.',
          suggestedAction: 'Treat the feed end as unconfirmed; inspect the page or provide a visible end marker instead of assuming all dynamic content loaded.',
        });
      }
      this.lastKnownUrl = page.url();
      this.pageDiagnostics.recordAction(
        page,
        this.scrollActionDiagnostic(page, actionStartedAt, actionDispatched, 'succeeded'),
      );
      return {
        page: await this.pageSummary(page, undefined, remainingUntil(operationDeadlineAt)),
        frame: this.frameSummary(frame, page),
        target: observedTarget === null
          ? { kind: 'document', ref: null }
          : { kind: 'container', ref: observedTarget.observation.ref },
        before,
        after,
        wait,
        stepsCompleted,
        moved,
        contentGrew,
        targetBoundaryReached,
        documentBoundaryReached,
        nestedScrollContainerCandidateCount,
        endReached,
        endState,
        warnings,
      };
    } catch (error) {
      const pageNotActive = error instanceof Stage5BrowserError &&
        error.details?.reason === 'page_not_active';
      const observationSurfaceUnavailable = error instanceof Stage5BrowserError &&
        error.details?.reason === 'scroll_observation_surface_unavailable';
      const observationIncomplete = error instanceof Stage5BrowserError &&
        error.details?.reason === 'scroll_observation_incomplete';
      const priorScrollDispatched = stepsCompleted > 0 || actionDispatched === true;
      const knownObservationFailure = observationSurfaceUnavailable || observationIncomplete;
      const reportedError = knownObservationFailure
        ? new Stage5BrowserError(
          'OPERATION_FAILED',
          error.message,
          {
            recoverable: true,
            details: {
              ...error.details,
              actionDispatched: priorScrollDispatched,
              clickDispatched: null,
              stepsCompleted,
              suggestedAction: priorScrollDispatched
                ? observationSurfaceUnavailable
                  ? 'Inspect one fresh snapshot before continuing. The completed scroll steps were not replayed, and Stage5 Browser will not compare the detached root with its replacement.'
                  : 'Inspect one fresh snapshot before continuing. The completed scroll steps were not replayed, and Stage5 Browser will not infer content state from a truncated observation.'
                : observationSurfaceUnavailable
                  ? 'Take one fresh snapshot and select the intended current scroll surface before another attempt.'
                  : 'Use one fresh snapshot to target a smaller observed scroll container; Stage5 Browser will not infer growth or loader disappearance from a truncated sample.',
            },
            cause: error,
          },
        )
        : error;
      this.pageDiagnostics.recordAction(
        page,
        this.scrollActionDiagnostic(
          page,
          actionStartedAt,
          actionDispatched,
          (pageNotActive || knownObservationFailure) && actionDispatched === false
            ? 'blocked'
            : 'failed',
          pageNotActive
            ? 'page_not_active'
            : observationSurfaceUnavailable
              ? 'detached'
              : 'unknown',
        ),
      );
      throw reportedError;
    } finally {
      if (observationSurface?.ownsHandle === true) {
        await observationSurface.handle?.dispose().catch(() => undefined);
      }
      if (targetHandle !== null) {
        await targetHandle.dispose().catch(() => undefined);
      } else {
        this.discardObservedSnapshot(frame);
      }
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type ScrollActionOperations = typeof scrollActionOperations;
