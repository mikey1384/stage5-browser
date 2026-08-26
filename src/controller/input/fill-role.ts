import { type Browser, type BrowserCommandInput, type BrowserCommandOutput, type ElementHandle, type FillRefEvidence, inspectTargetState, type SafeTargetState, type SanitizedActionDiagnostic, sanitizeUrlForJournal, Stage5BrowserError } from '../dependencies.js';
import { boundedValue, CLICK_REF_INCREMENTAL_SETTLE_MS, FILL_REF_VIEWPORT_PREPARATION_TIMEOUT_MS, fillFinalizationReserve, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const inputFillRoleOperations = {
  async fillByRole(input: BrowserCommandInput<'fillByRole'>): Promise<BrowserCommandOutput<'fillByRole'>> {
    const page = await this.ensureActivePage(this.requireContext());
    const frame = this.resolveFrame(page, input.frameId);
    const locator = frame.getByRole(input.role, { name: input.name, exact: input.exact });
    const phases = this.actionPhases.begin('fill_by_role', input.timeoutMs);
    phases.enter('observe');
    phases.enter('plan');
    phases.enter('preflight');
    const deadlineAt = phases.deadlineAtMs;
    const actionDeadlineAt = deadlineAt - fillFinalizationReserve(input.timeoutMs);
    const startedAt = new Date(phases.startedAtMs).toISOString();
    let preflightHandle: ElementHandle<HTMLElement> | null = null;
    let handle: ElementHandle<HTMLElement> | null = null;
    let targetState: SafeTargetState | null = null;
    let inputEvidence: FillRefEvidence | null = null;
    let fillPhase: NonNullable<SanitizedActionDiagnostic['fillPhase']> = 'target_preparation';
    let fillPreparationStep: NonNullable<SanitizedActionDiagnostic['fillPreparationStep']> = 'reference_validation';
    this.pageDiagnostics.beginAction(page, startedAt);
    try {
      preflightHandle = await this.resolveUniqueFillTarget(
        locator,
        input.role,
        input.name,
        remainingUntil(actionDeadlineAt),
      );
      phases.enter('prepare');
      fillPreparationStep = 'scope_validation';
      const activation = await boundedValue(
        this.activateSelectedPageForInput(page, 1),
        Math.max(1, remainingUntil(actionDeadlineAt)),
        {
          attemptCount: 1,
          controllerSelected: this.preferredPage() === page,
          bringToFrontAttempted: false,
          bringToFrontSucceeded: false,
          visibilityBefore: 'unknown' as const,
          visibilityAfter: 'unknown' as const,
          documentFocusedBefore: null,
          documentFocusedAfter: null,
          nativeWindow: this.nativeWindowActivationNotRequired(),
        },
      );
      if (!this.pageIsActivatedForInput(activation)) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The selected page could not become a visible input target.', {
          recoverable: true,
          details: {
            reason: 'page_not_active',
            actionDispatched: false,
            pageActivation: activation,
            suggestedAction: 'Inspect the selected tab and renderer visibility; Stage5 Browser did not enter any text.',
          },
        });
      }

      await preflightHandle.dispose().catch(() => undefined);
      preflightHandle = null;
      fillPreparationStep = 'editor_capability';
      handle = await this.resolveUniqueFillTarget(
        locator,
        input.role,
        input.name,
        remainingUntil(actionDeadlineAt),
      );
      const target = await this.inspectFillTarget(
        handle,
        Math.max(1, remainingUntil(actionDeadlineAt)),
      );
      if (target === null || !target.enabled) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The unique role target is not an enabled text editor.', {
          recoverable: true,
          details: {
            reason: target === null ? 'target_not_text_editable' : 'target_not_enabled',
            actionDispatched: false,
            suggestedAction: 'Inspect the field with one fresh semantic snapshot; Stage5 Browser did not enter any text.',
          },
        });
      }
      this.validateFillValue(target, input.value);

      fillPreparationStep = 'viewport_preparation';
      targetState = await boundedValue(
        inspectTargetState(handle),
        Math.max(1, remainingUntil(actionDeadlineAt)),
        null,
      );
      if (targetState !== null && targetState.visible && !targetState.inViewport) {
        await boundedValue(
          handle.evaluate((element) => {
            if (!element.isConnected) return false;
            element.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
            return true;
          }),
          Math.max(1, remainingUntil(actionDeadlineAt)),
          false,
        );
        const settleMs = Math.min(CLICK_REF_INCREMENTAL_SETTLE_MS, remainingUntil(actionDeadlineAt));
        if (settleMs > 0) await page.waitForTimeout(settleMs);
        targetState = await boundedValue(
          inspectTargetState(handle),
          Math.max(1, remainingUntil(actionDeadlineAt)),
          null,
        );
      }
      if (targetState === null || !targetState.visible || !targetState.inViewport || !targetState.enabled) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The unique role editor is not safely actionable.', {
          recoverable: true,
          details: {
            reason: targetState === null ? 'target_detached_before_input' : 'target_not_actionable',
            actionDispatched: false,
            targetState,
            suggestedAction: 'Take one fresh semantic snapshot after the editor is visible and enabled; Stage5 Browser did not enter any text.',
          },
        });
      }
      fillPreparationStep = 'completed';
      fillPhase = 'fill_dispatch';
      phases.beginDispatch();
      inputEvidence = await this.dispatchPreparedFill(
        handle,
        target,
        input.value,
        actionDeadlineAt,
        deadlineAt,
      );
      phases.concludeDispatch({ actionDispatched: inputEvidence.actionDispatched });
      phases.enter('reconcile');
      fillPhase = 'completed';
      phases.beginFinalization();
      this.pageDiagnostics.recordAction(page, {
        action: 'fill_by_role',
        outcome: 'succeeded',
        reason: null,
        actionDispatched: inputEvidence.actionDispatched,
        clickDispatched: null,
        targetState,
        fillPhase,
        fillPreparationStep,
        inputEvidence,
        pageUrl: sanitizeUrlForJournal(page.url()) ?? null,
        startedAt,
        occurredAt: new Date().toISOString(),
      });
      this.lastKnownUrl = page.url();
      const result = {
        page: await this.pageSummary(page, undefined, remainingUntil(deadlineAt)),
        frame: this.frameSummary(frame, page),
        input: inputEvidence,
      };
      phases.complete('succeeded');
      return result;
    } catch (error) {
      const existing = error instanceof Stage5BrowserError ? error : null;
      const retainedInputEvidence = inputEvidence ?? (
        typeof existing?.details?.inputEvidence === 'object' && existing.details.inputEvidence !== null
          ? existing.details.inputEvidence as FillRefEvidence
          : null
      );
      const rawDispatch = existing?.details?.actionDispatched;
      const actionDispatched = rawDispatch === true || rawDispatch === false || rawDispatch === 'unknown'
        ? rawDispatch
        : retainedInputEvidence?.actionDispatched ?? (phases.snapshot().currentPhase === 'dispatch' ? 'unknown' : false);
      if (phases.snapshot().currentPhase === 'dispatch') {
        phases.concludeDispatch({ actionDispatched });
        phases.enter('reconcile');
      }
      phases.beginFinalization();
      this.pageDiagnostics.recordAction(page, {
        action: 'fill_by_role',
        outcome: actionDispatched === false ? 'blocked' : 'failed',
        reason: existing?.details?.reason === 'page_not_active' ? 'page_not_active' : 'unknown',
        actionDispatched,
        clickDispatched: null,
        targetState,
        fillPhase,
        fillPreparationStep,
        ...(retainedInputEvidence === null ? {} : { inputEvidence: retainedInputEvidence }),
        pageUrl: sanitizeUrlForJournal(page.url()) ?? null,
        startedAt,
        occurredAt: new Date().toISOString(),
      });
      const failure = new Stage5BrowserError(
        existing?.code ?? 'OPERATION_FAILED',
        existing?.message ?? 'The role-based editor fill did not complete.',
        {
          recoverable: existing?.recoverable ?? true,
          details: {
            ...(existing?.details ?? {}),
            fillPhase,
            fillPreparationStep,
            actionDispatched,
            targetState,
            inputEvidence: retainedInputEvidence,
            suggestedAction: typeof existing?.details?.suggestedAction === 'string'
              ? existing.details.suggestedAction
              : actionDispatched === false
                ? 'Take one fresh snapshot before another attempt; Stage5 Browser confirmed that no text input was dispatched.'
                : 'Inspect the editor with a fresh snapshot. Do not replay because partial or ambiguous input may have occurred.',
          },
          cause: error,
        },
      );
      phases.complete('failed');
      throw failure;
    } finally {
      await preflightHandle?.dispose().catch(() => undefined);
      await handle?.dispose().catch(() => undefined);
      this.discardObservedSnapshot(frame);
      phases.ensureFailed();
      this.actionPhases.finish(phases);
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type InputFillRoleOperations = typeof inputFillRoleOperations;
