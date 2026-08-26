import { type Browser, type BrowserCommandOutput, type Page, type SanitizedClickDispatchEvidence, type SanitizedPageActivationEvidence, Stage5BrowserError } from '../dependencies.js';
import { clickFinalizationReserve, type PreparedObservedClickTarget, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import type { ClickActionDefinition, ClickActionPlan } from './click-plan.js';

function dispatchConclusion(error: unknown): boolean | 'unknown' {
  if (!(error instanceof Stage5BrowserError)) return 'unknown';
  const dispatched = error.details?.actionDispatched;
  return dispatched === true || dispatched === false || dispatched === 'unknown'
    ? dispatched
    : 'unknown';
}

export const clickExecutorOperations = {
  async executeClickAction<Observation>(
    definition: ClickActionDefinition<Observation>,
  ): Promise<BrowserCommandOutput<'clickByRole'>> {
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
      phases.enter('preflight');
      await definition.preflight(plan);
      this.pageDiagnostics.beginAction(plan.page, actionStartedAt);

      let priorActivation: SanitizedPageActivationEvidence | null = null;
      for (;;) {
        phases.enter('prepare');
        preparedTarget = await plan.prepare(
          priorActivation?.nativeWindow ?? null,
          (priorActivation?.attemptCount ?? 0) + 1,
          actionStartedAt,
          actionDeadlineAt,
        );
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
        const postcondition = await this.verifyClickPostcondition(
          plan.page,
          plan.frame,
          plan.reconciliationLocator(preparedTarget),
          plan.postcondition,
          remainingUntil(actionDeadlineAt),
          pagesBeforeDispatch,
          downloadCursorBeforeDispatch,
        );
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
          dispatch: { actionDispatched: true as const, clickDispatched: true as const },
          ...await this.newPageDispatchResult(plan.page, pagesBeforeDispatch, downloadCursorBeforeDispatch),
        };
        phases.complete('succeeded');
        return result;
      }
    } catch (error) {
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
