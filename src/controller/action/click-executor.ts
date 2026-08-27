import { type Browser, type BrowserCommandOutput, type Page, type SanitizedClickDispatchEvidence, type SanitizedPageActivationEvidence, Stage5BrowserError } from '../dependencies.js';
import { clickFinalizationReserve, type PreparedObservedClickTarget, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import type { ViewportPreparationTelemetry } from '../../protocol/telemetry.js';
import type { ClickActionDefinition, ClickActionPlan } from './click-plan.js';

type ClickActionExecutionResult = Omit<BrowserCommandOutput<'clickByRole'>, 'dispatch'> & {
  dispatch: { actionDispatched: boolean | 'unknown'; clickDispatched: boolean | 'unknown' };
};

function dispatchConclusion(error: unknown): boolean | 'unknown' {
  if (!(error instanceof Stage5BrowserError)) return 'unknown';
  const dispatched = error.details?.actionDispatched;
  return dispatched === true || dispatched === false || dispatched === 'unknown'
    ? dispatched
    : 'unknown';
}

function viewportPreparationFromError(error: unknown): ViewportPreparationTelemetry | null {
  if (!(error instanceof Stage5BrowserError)) return null;
  const value = error.details?.viewportPreparation;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const evidence = value as Partial<ViewportPreparationTelemetry>;
  if (
    !Number.isInteger(evidence.attempts) || (evidence.attempts ?? -1) < 0 || (evidence.attempts ?? 33) > 32 ||
    !Number.isInteger(evidence.movements) || (evidence.movements ?? -1) < 0 ||
    (evidence.movements ?? 33) > (evidence.attempts ?? -1) ||
    typeof evidence.horizontalMovement !== 'boolean' ||
    typeof evidence.verticalMovement !== 'boolean' ||
    typeof evidence.nestedSurfaceMovement !== 'boolean' ||
    typeof evidence.documentMovement !== 'boolean' ||
    typeof evidence.composedBoundaryTraversed !== 'boolean' ||
    typeof evidence.pointerContactRecovery !== 'boolean' ||
    typeof evidence.completedInViewport !== 'boolean' ||
    (evidence.reachStrategy !== 'pointer_viewport' && evidence.reachStrategy !== 'postconditioned_keyboard')
  ) return null;
  return evidence as ViewportPreparationTelemetry;
}

export const clickExecutorOperations = {
  async executeClickAction<Observation>(
    definition: ClickActionDefinition<Observation>,
  ): Promise<ClickActionExecutionResult> {
    const phases = this.actionPhases.begin(definition.action, definition.timeoutMs);
    let plan: ClickActionPlan | null = null;
    let preparedTarget: PreparedObservedClickTarget | null = null;
    let dispatchEvidence: SanitizedClickDispatchEvidence | null = null;
    let pagesBeforeDispatch: ReadonlySet<Page> = new Set();
    let downloadCursorBeforeDispatch = 0;
    const actionStartedAt = new Date(phases.startedAtMs).toISOString();
    const deadlineAt = phases.deadlineAtMs;
    const actionDeadlineAt = deadlineAt - clickFinalizationReserve(definition.timeoutMs);
    try {
      phases.enter('observe');
      const observation = await definition.observe();
      phases.enter('plan');
      plan = await definition.plan(observation);
      if (plan.preDispatchRecoveryReason !== undefined) {
        phases.recordPreDispatchRecovery(plan.preDispatchRecoveryReason);
      }
      phases.enter('preflight');
      await definition.preflight(plan);
      if (plan.satisfiedWithoutDispatch !== undefined) {
        phases.beginFinalization();
        this.lastKnownUrl = plan.page.url();
        const result = {
          page: await this.pageSummary(plan.page, undefined, remainingUntil(deadlineAt)),
          frame: this.frameSummary(plan.frame, plan.page),
          postcondition: plan.satisfiedWithoutDispatch.postcondition,
          viewportPreparation: null,
          dispatch: { actionDispatched: false as const, clickDispatched: false as const },
          newPage: null,
          newPageCount: 0,
          newDownload: null,
          newDownloadCount: 0,
        };
        phases.complete('succeeded');
        return result;
      }
      this.pageDiagnostics.beginAction(plan.page, actionStartedAt);

      let priorActivation: SanitizedPageActivationEvidence | null = null;
      for (;;) {
        phases.enter('prepare');
        preparedTarget = await plan.prepare(
          priorActivation?.nativeWindow ?? null,
          (priorActivation?.attemptCount ?? 0) + 1,
          actionStartedAt,
          actionDeadlineAt,
          plan.activationPolicy,
        );
        if (preparedTarget.viewportPreparation !== null) {
          phases.recordViewportPreparation(preparedTarget.viewportPreparation);
        }
        pagesBeforeDispatch = new Set(plan.page.context().pages().filter((candidate) => !candidate.isClosed()));
        downloadCursorBeforeDispatch = await this.downloadManager.cursor();
        phases.beginDispatch();
        try {
          dispatchEvidence = await this.dispatchPreparedObservedClick(
            plan.page,
            preparedTarget,
            actionStartedAt,
            actionDeadlineAt,
            deadlineAt,
            plan.action,
          );
          phases.concludeDispatch({ actionDispatched: true });
        } catch (error) {
          phases.concludeDispatch({ actionDispatched: dispatchConclusion(error) });
          if (this.canRecoverDispatchTimeActivationLoss(error, actionDeadlineAt)) {
            phases.recoverBeforeDispatch('activation_lost_before_input');
            priorActivation = preparedTarget.pageActivation;
            await preparedTarget.handle.dispose().catch(() => undefined);
            preparedTarget = null;
            phases.enter('preflight');
            await definition.preflight(plan);
            continue;
          }

          phases.enter('reconcile');
          const reconciled = await this.reconcilePartialClickEffect(
            plan.page,
            plan.frame,
            plan.reconciliationLocator(preparedTarget),
            plan.postcondition,
            error,
            deadlineAt,
            pagesBeforeDispatch,
            downloadCursorBeforeDispatch,
            plan.reconcile === undefined || preparedTarget === null
              ? undefined
              : () => plan!.reconcile!(preparedTarget!, remainingUntil(deadlineAt)),
          );
          if (reconciled === null) throw error;
          dispatchEvidence = reconciled.dispatchEvidence;
          phases.beginFinalization();
          this.pageDiagnostics.recordAction(
            plan.page,
            this.reconciledPartialEffectDiagnostic(
              plan.action,
              plan.page,
              preparedTarget.targetState,
              actionStartedAt,
              reconciled,
            ),
          );
          this.lastKnownUrl = plan.page.url();
          const result = {
            page: await this.pageSummary(plan.page, undefined, remainingUntil(deadlineAt)),
            frame: this.frameSummary(plan.frame, plan.page),
            postcondition: reconciled.postcondition,
            viewportPreparation: preparedTarget?.viewportPreparation ?? null,
            dispatch: {
              actionDispatched: reconciled.actionDispatched === false ? 'unknown' as const : reconciled.actionDispatched,
              clickDispatched: reconciled.clickDispatched === false ? 'unknown' as const : reconciled.clickDispatched,
            },
            ...await this.newPageDispatchResult(plan.page, pagesBeforeDispatch, downloadCursorBeforeDispatch),
          };
          phases.complete('succeeded');
          return result;
        }

        phases.enter('reconcile');
        const postcondition = plan.reconcile === undefined
          ? await this.verifyClickPostcondition(
            plan.page,
            plan.frame,
            plan.reconciliationLocator(preparedTarget),
            plan.postcondition,
            remainingUntil(actionDeadlineAt),
            pagesBeforeDispatch,
            downloadCursorBeforeDispatch,
          )
          : await plan.reconcile(preparedTarget, remainingUntil(actionDeadlineAt));
        phases.beginFinalization();
        this.pageDiagnostics.recordAction(
          plan.page,
          this.successfulActionDiagnostic(
            plan.action,
            plan.page,
            preparedTarget.targetState,
            actionStartedAt,
            dispatchEvidence,
          ),
        );
        this.lastKnownUrl = plan.page.url();
        const result = {
          page: await this.pageSummary(plan.page, undefined, remainingUntil(deadlineAt)),
          frame: this.frameSummary(plan.frame, plan.page),
          postcondition,
          viewportPreparation: preparedTarget.viewportPreparation,
          dispatch: { actionDispatched: true as const, clickDispatched: true as const },
          ...await this.newPageDispatchResult(plan.page, pagesBeforeDispatch, downloadCursorBeforeDispatch),
        };
        phases.complete('succeeded');
        return result;
      }
    } catch (error) {
      const viewportPreparation = viewportPreparationFromError(error);
      if (viewportPreparation !== null) phases.recordViewportPreparation(viewportPreparation);
      if (
        plan !== null &&
        error instanceof Stage5BrowserError &&
        error.code === 'POSTCONDITION_FAILED'
      ) {
        this.pageDiagnostics.recordAction(
          plan.page,
          this.postconditionFailureDiagnostic(
            plan.action,
            plan.page,
            preparedTarget?.targetState ?? null,
            actionStartedAt,
            dispatchEvidence,
          ),
        );
      }
      phases.ensureFailed();
      throw error;
    } finally {
      await preparedTarget?.handle.dispose().catch(() => undefined);
      plan?.discardCapabilities();
      this.actionPhases.finish(phases);
    }
  },

  async newPageDispatchResult(
    opener: Page,
    pagesBeforeDispatch: ReadonlySet<Page>,
    downloadCursorBeforeDispatch: number,
  ): Promise<Pick<BrowserCommandOutput<'clickByRole'>, 'newPage' | 'newPageCount' | 'newDownload' | 'newDownloadCount'>> {
    const livePages = opener.context().pages().filter((candidate) => !candidate.isClosed());
    const newPages = livePages.filter((candidate) => !pagesBeforeDispatch.has(candidate));
    const newDownloads = await this.downloadManager.after(downloadCursorBeforeDispatch);
    return {
      newPage: newPages.length === 1 && newPages[0] !== undefined
        ? await this.tabSummary(newPages[0], livePages.indexOf(newPages[0]))
        : null,
      newPageCount: newPages.length,
      newDownload: newDownloads.length === 1 ? newDownloads[0] ?? null : null,
      newDownloadCount: newDownloads.length,
    };
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type ClickExecutorOperations = typeof clickExecutorOperations;
