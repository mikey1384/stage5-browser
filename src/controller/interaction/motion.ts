import { type BrowserCommandInput, type BrowserCommandOutput, type BrowserMotionDispatchEvidence, type BrowserMotionTarget, type ElementHandle, type Page, sanitizeUrlForJournal, Stage5BrowserError } from '../dependencies.js';
import { fillFinalizationReserve, type ObservedReferenceCapability, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import type { PreparedMotionTarget } from './motion-target.js';

function targetForMotion(input: BrowserCommandInput<'motion'>): BrowserMotionTarget {
  return input.motion.kind === 'drag' ? input.motion.source : input.motion.target;
}

function dispatchedFromEvidence(
  kind: BrowserCommandInput<'motion'>['motion']['kind'],
  evidence: Omit<BrowserMotionDispatchEvidence, 'actionDispatched' | 'kind'>,
  dispatchError: unknown,
): boolean | 'unknown' {
  const observed = kind === 'focus'
      ? evidence.focusObserved
    : kind === 'hover'
      ? evidence.hoverObserved
      : kind === 'press'
        ? evidence.keyDownObserved || evidence.keyUpObserved
        : kind === 'double_click'
          ? evidence.doubleClickObserved || evidence.clickObserved || evidence.pointerDownObserved
          : kind === 'context_click'
            ? evidence.contextMenuObserved || evidence.pointerDownObserved
            : evidence.pointerDownObserved || evidence.dragStartObserved || evidence.dropObserved;
  if (observed) return true;
  return dispatchError === null ? 'unknown' : false;
}

export const interactionMotionOperations = {
  async motion(input: BrowserCommandInput<'motion'>): Promise<BrowserCommandOutput<'motion'>> {
    const page = await this.ensureActivePage(this.requireContext());
    const frame = this.resolveFrame(page, input.frameId);
    const phases = this.actionPhases.begin(input.motion.kind, input.timeoutMs);
    const deadlineAt = phases.deadlineAtMs;
    const actionDeadlineAt = deadlineAt - fillFinalizationReserve(input.timeoutMs);
    const startedAt = new Date(phases.startedAtMs).toISOString();
    let source: PreparedMotionTarget | null = null;
    let destination: PreparedMotionTarget | null = null;
    let sourceCapability: ObservedReferenceCapability | null = null;
    let destinationCapability: ObservedReferenceCapability | null = null;
    let probe: Awaited<ReturnType<BrowserControllerContext['installMotionProbe']>> = null;
    let dispatchError: unknown = null;
    let dispatch: BrowserMotionDispatchEvidence | null = null;
    let pagesBeforeDispatch: ReadonlySet<Page> = new Set();
    let downloadCursorBeforeDispatch = 0;
    this.pageDiagnostics.beginAction(page, startedAt);
    try {
      phases.enter('observe');
      const sourceTarget = targetForMotion(input);
      const sourceSnapshot = this.validateMotionTargetCapability(frame, sourceTarget);
      const destinationTarget = input.motion.kind === 'drag' ? input.motion.destination : null;
      const destinationSnapshot = destinationTarget === null
        ? null
        : this.validateMotionTargetCapability(frame, destinationTarget);
      sourceCapability = sourceTarget.kind === 'ref' && sourceSnapshot !== null
        ? await this.retainObservedReferenceCapability(
          frame,
          sourceSnapshot,
          sourceTarget.ref,
          actionDeadlineAt,
        )
        : null;
      destinationCapability = destinationTarget?.kind === 'ref' && destinationSnapshot !== null
        ? await this.retainObservedReferenceCapability(
          frame,
          destinationSnapshot,
          destinationTarget.ref,
          actionDeadlineAt,
        )
        : null;
      phases.enter('plan');
      if (
        sourceTarget.kind === 'ref' &&
        destinationTarget?.kind === 'ref' &&
        sourceTarget.snapshotId !== destinationTarget.snapshotId
      ) {
        throw new Stage5BrowserError('TARGET_NOT_FOUND', 'A drag must bind both refs from one exact current snapshot.', {
          recoverable: true,
          details: { reason: 'drag_snapshot_mismatch', actionDispatched: false },
        });
      }
      phases.enter('preflight');
      const activation = await this.primeSelectedPageForTargetPreparation(
        page,
        actionDeadlineAt,
        startedAt,
        input.motion.kind,
      );
      phases.enter('prepare');
      source = await this.prepareMotionTarget(
        page,
        frame,
        sourceTarget,
        sourceSnapshot,
        sourceCapability,
        input.motion.kind === 'hover'
          || input.motion.kind === 'drag'
          || input.motion.kind === 'double_click'
          || input.motion.kind === 'context_click',
        actionDeadlineAt,
      );
      if (destinationTarget !== null) {
        destination = await this.prepareMotionTarget(
          page,
          frame,
          destinationTarget,
          destinationSnapshot,
          destinationCapability,
          true,
          actionDeadlineAt,
        );
      }
      probe = await this.installMotionProbe(source.handle, destination?.handle ?? null);
      if (probe === null) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'Motion evidence could not be installed before dispatch.', {
          recoverable: true,
          details: {
            reason: 'motion_probe_unavailable',
            actionDispatched: false,
            suggestedAction: 'Inspect the current target once. Stage5 Browser confirmed that no motion input was dispatched.',
          },
        });
      }
      pagesBeforeDispatch = new Set(page.context().pages().filter((candidate) => !candidate.isClosed()));
      downloadCursorBeforeDispatch = await this.downloadManager.cursor();
      phases.beginDispatch();
      try {
        if (input.motion.kind === 'hover') {
          await source.handle.hover({ timeout: Math.max(1, remainingUntil(actionDeadlineAt)) });
        } else if (input.motion.kind === 'focus') {
          await source.handle.focus();
        } else if (input.motion.kind === 'press') {
          await source.handle.press(input.motion.key, { timeout: Math.max(1, remainingUntil(actionDeadlineAt)) });
        } else if (input.motion.kind === 'double_click') {
          await source.handle.dblclick({ timeout: Math.max(1, remainingUntil(actionDeadlineAt)) });
        } else if (input.motion.kind === 'context_click') {
          await source.handle.click({ button: 'right', timeout: Math.max(1, remainingUntil(actionDeadlineAt)) });
        } else {
          if (destination === null) throw new Error('The exact drag destination was not retained.');
          await this.dispatchExactDrag(page, source.handle, destination.handle, actionDeadlineAt);
        }
      } catch (error) {
        dispatchError = error;
      }
      const observed = await probe.evaluate((controller) => controller.finish()).catch(() => null);
      await probe.dispose().catch(() => undefined);
      probe = null;
      if (observed === null) {
        dispatch = {
          actionDispatched: 'unknown',
          kind: input.motion.kind,
          focusObserved: false,
          hoverObserved: false,
          keyDownObserved: false,
          keyUpObserved: false,
          pointerDownObserved: false,
          clickObserved: false,
          contextMenuObserved: false,
          doubleClickObserved: false,
          dragStartObserved: false,
          dropObserved: false,
        };
      } else {
        dispatch = {
          actionDispatched: dispatchedFromEvidence(input.motion.kind, observed, dispatchError),
          kind: input.motion.kind,
          ...observed,
        };
      }
      phases.concludeDispatch({ actionDispatched: dispatch.actionDispatched });
      phases.enter('reconcile');
      let postcondition = null;
      try {
        postcondition = await this.verifyActionPostcondition(
          page,
          frame,
          source.locator,
          input.postcondition,
          remainingUntil(actionDeadlineAt),
          pagesBeforeDispatch,
          downloadCursorBeforeDispatch,
          'motion',
        );
      } catch (postconditionError) {
        if (dispatchError === null) throw postconditionError;
        throw new Stage5BrowserError('OPERATION_FAILED', 'Possible motion input occurred without the requested effect.', {
          recoverable: true,
          details: {
            reason: 'motion_effect_unconfirmed',
            actionDispatched: dispatch.actionDispatched,
            dispatch,
            suggestedAction: dispatch.actionDispatched === false
              ? 'Inspect the current target before one fresh attempt.'
              : 'Inspect authoritative state. Possible input occurred; do not replay this motion automatically.',
          },
          cause: dispatchError,
        });
      }
      if (dispatchError !== null && input.postcondition === null) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The exact motion did not complete normally.', {
          recoverable: true,
          details: {
            reason: 'motion_dispatch_failed',
            actionDispatched: dispatch.actionDispatched,
            dispatch,
            suggestedAction: dispatch.actionDispatched === false
              ? 'Inspect the exact target before deciding whether one new motion is useful.'
              : 'Inspect authoritative state. Possible input occurred; do not replay this motion automatically.',
          },
          cause: dispatchError,
        });
      }
      phases.beginFinalization();
      this.pageDiagnostics.recordAction(page, {
        action: input.motion.kind,
        outcome: 'succeeded',
        reason: null,
        actionDispatched: dispatch.actionDispatched,
        clickDispatched: null,
        targetState: source.state,
        pageUrl: sanitizeUrlForJournal(page.url()) ?? null,
        startedAt,
        occurredAt: new Date().toISOString(),
      });
      const result = {
        page: await this.pageSummary(page, undefined, remainingUntil(deadlineAt)),
        frame: this.frameSummary(frame, page),
        motion: input.motion.kind,
        dispatch,
        postcondition,
        ...await this.newPageDispatchResult(page, pagesBeforeDispatch, downloadCursorBeforeDispatch),
      };
      phases.complete('succeeded');
      return result;
    } catch (error) {
      if (phases.snapshot().currentPhase === 'dispatch') {
        phases.concludeDispatch({ actionDispatched: dispatch?.actionDispatched ?? 'unknown' });
        phases.enter('reconcile');
      }
      phases.beginFinalization();
      this.pageDiagnostics.recordAction(page, {
        action: input.motion.kind,
        outcome: dispatch?.actionDispatched === false || dispatch === null ? 'blocked' : 'failed',
        reason: dispatch?.actionDispatched === false || dispatch === null ? 'unknown' : 'postcondition_not_met',
        actionDispatched: dispatch?.actionDispatched ?? false,
        clickDispatched: null,
        targetState: source?.state ?? null,
        pageUrl: sanitizeUrlForJournal(page.url()) ?? null,
        startedAt,
        occurredAt: new Date().toISOString(),
      });
      phases.complete('failed');
      throw error;
    } finally {
      await probe?.dispose().catch(() => undefined);
      await source?.handle.dispose().catch(() => undefined);
      await destination?.handle.dispose().catch(() => undefined);
      await sourceCapability?.handle.dispose().catch(() => undefined);
      await destinationCapability?.handle.dispose().catch(() => undefined);
      this.discardObservedSnapshot(frame);
      phases.ensureFailed();
      this.actionPhases.finish(phases);
    }
  },

  async dispatchExactDrag(
    page: Page,
    source: ElementHandle<HTMLElement | SVGElement>,
    destination: ElementHandle<HTMLElement | SVGElement>,
    deadlineAt: number,
  ): Promise<void> {
    if (await source.ownerFrame() !== await destination.ownerFrame()) {
      throw new Stage5BrowserError('OPERATION_FAILED', 'Cross-frame dragging is not an exact supported motion.', {
        recoverable: true,
        details: { reason: 'cross_frame_drag_unsupported', actionDispatched: false },
      });
    }
    const [sourceHit, destinationHit, sourceBox, destinationBox] = await Promise.all([
      this.freshExactHandleHitPoint(source),
      this.freshExactHandleHitPoint(destination),
      source.boundingBox(),
      destination.boundingBox(),
    ]);
    if (sourceHit === null || destinationHit === null || sourceBox === null || destinationBox === null) {
      throw new Stage5BrowserError('OPERATION_FAILED', 'The exact drag endpoints lost safe hit points before dispatch.', {
        recoverable: true,
        details: { reason: 'drag_hit_point_unavailable', actionDispatched: false },
      });
    }
    if (remainingUntil(deadlineAt) <= 0) {
      throw new Stage5BrowserError('OPERATION_FAILED', 'The drag deadline expired before pointer input.', {
        recoverable: true,
        details: { reason: 'drag_dispatch_deadline_expired', actionDispatched: false },
      });
    }
    const start = { x: sourceBox.x + sourceHit.element.x, y: sourceBox.y + sourceHit.element.y };
    const end = { x: destinationBox.x + destinationHit.element.x, y: destinationBox.y + destinationHit.element.y };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 });
    await page.mouse.up();
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type InteractionMotionOperations = typeof interactionMotionOperations;
