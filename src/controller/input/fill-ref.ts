import { type Browser, type BrowserCommandInput, type BrowserCommandOutput, type ElementHandle, type FillRefEvidence, inspectTargetState, type SafeTargetState, type SanitizedActionDiagnostic, sanitizeUrlForJournal, Stage5BrowserError } from '../dependencies.js';
import { boundedValue, CLICK_REF_INCREMENTAL_SETTLE_MS, FILL_REF_VIEWPORT_PREPARATION_TIMEOUT_MS, fillFinalizationReserve, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const inputFillRefOperations = {
  async fillRef(input: BrowserCommandInput<'fillRef'>): Promise<BrowserCommandOutput<'fillRef'>> {
    const page = await this.ensureActivePage(this.requireContext());
    const frame = this.resolveFrame(page, input.frameId);
    const phases = this.actionPhases.begin('fill_ref', input.timeoutMs);
    phases.enter('observe');
    phases.enter('plan');
    phases.enter('preflight');
    const startedAtMs = phases.startedAtMs;
    const deadlineAt = phases.deadlineAtMs;
    const actionDeadlineAt = deadlineAt - fillFinalizationReserve(input.timeoutMs);
    const startedAt = new Date(startedAtMs).toISOString();
    let fillPhase: NonNullable<SanitizedActionDiagnostic['fillPhase']> = 'target_preparation';
    let fillPreparationStep: NonNullable<SanitizedActionDiagnostic['fillPreparationStep']> = 'reference_validation';
    let targetState: SafeTargetState | null = null;
    let inputEvidence: FillRefEvidence | null = null;
    let handle: ElementHandle<HTMLElement> | null = null;
    this.pageDiagnostics.beginAction(page, startedAt);
    try {
      const observed = this.observedSnapshots.get(frame);
      if (
        observed === undefined ||
        observed.id !== input.snapshotId ||
        observed.documentVersion !== this.documentVersion(frame)
      ) {
        throw new Stage5BrowserError(
          'TARGET_NOT_FOUND',
          'The textbox reference does not belong to the latest snapshot of the current document.',
          {
            recoverable: true,
            details: {
              reason: 'stale_or_unknown_snapshot',
              actionDispatched: false,
              suggestedAction: 'Take one fresh semantic snapshot and use only its textbox ref.',
            },
          },
        );
      }
      if (!observed.refs.has(input.ref)) {
        throw new Stage5BrowserError(
          'TARGET_NOT_FOUND',
          'The requested textbox reference was not present in that snapshot.',
          {
            recoverable: true,
            details: {
              reason: 'reference_not_observed',
              actionDispatched: false,
              suggestedAction: 'Take one fresh semantic snapshot and use only an observed textbox ref.',
            },
          },
        );
      }

      fillPreparationStep = 'editor_capability';
      const observedEditor = observed.textEditors.get(input.ref);
      if (observedEditor === undefined) {
        throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The observed reference was not captured as a fillable text editor.', {
          recoverable: true,
          details: {
            reason: 'reference_not_observed_as_text_editor',
            actionDispatched: false,
            suggestedAction: 'Take one fresh snapshot and use only a textbox ref exposed as a fillable editor capability.',
          },
        });
      }
      handle = observedEditor.handle;
      phases.enter('prepare');

      fillPreparationStep = 'scope_validation';
      const insideSameScope = await boundedValue(
        observed.scopeHandle.evaluate(
          (root, target) => root.isConnected && target.isConnected && (root === target || root.contains(target)),
          handle,
        ),
        Math.max(1, remainingUntil(actionDeadlineAt)),
        null,
      );
      if (insideSameScope === null) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The retained snapshot scope could not be validated before the fill deadline.', {
          recoverable: true,
          details: {
            reason: 'target_preparation_timeout',
            actionDispatched: false,
            suggestedAction: 'Take one fresh snapshot; Stage5 Browser confirmed that no text was entered.',
          },
        });
      }
      if (!insideSameScope) {
        throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The snapshot scope changed before filling.', {
          recoverable: true,
          details: {
            reason: 'snapshot_scope_changed',
            actionDispatched: false,
            suggestedAction: 'Take one fresh modal or document snapshot; Stage5 Browser did not enter any text.',
          },
        });
      }
      this.consumeObservedSnapshot(frame, handle);

      fillPreparationStep = 'editor_validation';
      const target = await this.inspectFillTarget(
        handle,
        Math.max(1, remainingUntil(actionDeadlineAt)),
      );
      if (target === null) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The observed editor could not be inspected before the fill deadline.', {
          recoverable: true,
          details: {
            reason: 'target_preparation_timeout',
            actionDispatched: false,
            suggestedAction: 'Take one fresh snapshot; Stage5 Browser confirmed that no text was entered.',
          },
        });
      }
      if (!target.enabled) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The observed reference is not an enabled text editor.', {
          recoverable: true,
          details: {
            reason: 'target_not_enabled',
            actionDispatched: false,
            suggestedAction: 'Take a fresh snapshot and choose an enabled textbox, textarea, or contenteditable ref.',
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
      if (targetState === null) {
        throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The observed editor detached before viewport preparation.', {
          recoverable: true,
          details: {
            reason: 'target_detached_before_input',
            actionDispatched: false,
            targetState,
            suggestedAction: 'Take one fresh snapshot; Stage5 Browser confirmed that no text was entered.',
          },
        });
      }
      if (!targetState.visible) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The observed editor is not visibly actionable.', {
          recoverable: true,
          details: {
            reason: 'target_not_actionable',
            actionDispatched: false,
            targetState,
            suggestedAction: 'Take one fresh snapshot after the editor becomes visible; Stage5 Browser did not enter any text.',
          },
        });
      }
      if (!targetState.inViewport) {
        const viewportTimeoutMs = Math.min(
          FILL_REF_VIEWPORT_PREPARATION_TIMEOUT_MS,
          Math.max(1, remainingUntil(actionDeadlineAt)),
        );
        const viewportPreparation = await boundedValue<{
          kind: 'detached' | 'failed' | 'scrolled' | 'timeout';
        }>(
          handle.evaluate((element) => {
            if (!element.isConnected) return 'detached' as const;
            element.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
            return 'scrolled' as const;
          }).then(
            (result) => ({ kind: result }),
            () => ({ kind: 'failed' as const }),
          ),
          viewportTimeoutMs,
          { kind: 'timeout' as const },
        );
        if (viewportPreparation.kind !== 'scrolled') {
          const timedOut = viewportPreparation.kind === 'timeout';
          const detached = viewportPreparation.kind === 'detached';
          throw new Stage5BrowserError(
            detached ? 'TARGET_NOT_FOUND' : 'OPERATION_FAILED',
            'The observed editor could not be prepared for bounded text input.',
            {
              recoverable: true,
              details: {
                reason: timedOut
                  ? 'target_preparation_timeout'
                  : detached
                    ? 'target_detached_before_input'
                    : 'target_scroll_failed',
                actionDispatched: false,
                targetState,
                suggestedAction: 'Take one fresh snapshot after the editor is visible; Stage5 Browser confirmed that no text was entered.',
              },
            },
          );
        }
        const settleMs = Math.min(CLICK_REF_INCREMENTAL_SETTLE_MS, remainingUntil(actionDeadlineAt));
        if (settleMs > 0) await page.waitForTimeout(settleMs);
      }
      if (remainingUntil(actionDeadlineAt) <= 0) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The observed editor could not be prepared before the fill deadline.', {
          recoverable: true,
          details: {
            reason: 'target_preparation_timeout',
            actionDispatched: false,
            targetState,
            suggestedAction: 'Take one fresh snapshot after the editor is visible; Stage5 Browser confirmed that no text was entered.',
          },
        });
      }
      fillPreparationStep = 'target_state';
      targetState = await boundedValue(
        inspectTargetState(handle),
        Math.max(1, remainingUntil(actionDeadlineAt)),
        null,
      );
      if (targetState === null || !targetState.visible || !targetState.inViewport || !targetState.enabled) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The observed text editor is not safely actionable.', {
          recoverable: true,
          details: {
            reason: targetState === null
              ? remainingUntil(actionDeadlineAt) === 0
                ? 'target_preparation_timeout'
                : 'target_detached_before_input'
              : 'target_not_actionable',
            actionDispatched: false,
            targetState,
            suggestedAction: 'Take a fresh snapshot after the editor is visible and enabled; Stage5 Browser did not enter any text.',
          },
        });
      }
      fillPreparationStep = 'completed';

      fillPhase = 'page_activation';
      const pageActivation = await boundedValue(
        this.activateSelectedPageForInput(page, 1),
        Math.max(1, remainingUntil(actionDeadlineAt)),
        {
          attemptCount: 1,
          controllerSelected: this.preferredPage() === page,
          bringToFrontAttempted: false,
          bringToFrontSucceeded: false,
          visibilityBefore: 'unknown',
          visibilityAfter: 'unknown',
          documentFocusedBefore: null,
          documentFocusedAfter: null,
          nativeWindow: this.nativeWindowActivationNotRequired(),
        },
      );
      if (!this.pageIsActivatedForInput(pageActivation)) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The selected page could not become a visible input target.', {
          recoverable: true,
          details: {
            reason: 'page_not_active',
            actionDispatched: false,
            pageActivation,
            suggestedAction: 'Inspect the selected tab and renderer visibility; Stage5 Browser did not enter any text.',
          },
        });
      }

      fillPhase = 'fill_dispatch';
      phases.beginDispatch();
      inputEvidence = await this.dispatchPreparedFill(
        handle,
        target,
        input.value,
        actionDeadlineAt,
        deadlineAt,
      );
      fillPhase = 'event_verification';
      phases.concludeDispatch({ actionDispatched: inputEvidence.actionDispatched });
      phases.enter('reconcile');

      fillPhase = 'completed';
      phases.beginFinalization();
      this.pageDiagnostics.recordAction(page, {
        action: 'fill_ref',
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
      const existingDispatch = existing?.details?.actionDispatched;
      const actionDispatched = existingDispatch === true || existingDispatch === false || existingDispatch === 'unknown'
        ? existingDispatch
        : retainedInputEvidence?.actionDispatched ?? (fillPhase === 'target_preparation' || fillPhase === 'page_activation'
          ? false
          : 'unknown');
      if (phases.snapshot().currentPhase === 'dispatch') {
        phases.concludeDispatch({ actionDispatched });
        phases.enter('reconcile');
      }
      const rawReason = typeof existing?.details?.reason === 'string' ? existing.details.reason : '';
      const nestedCause = error instanceof Error ? error.cause : null;
      const diagnosticReason: SanitizedActionDiagnostic['reason'] = rawReason.includes('detached')
        ? 'detached'
        : rawReason.includes('enabled')
          ? 'not_enabled'
          : rawReason.includes('active')
            ? 'page_not_active'
            : rawReason.includes('visible') || rawReason.includes('actionable') || rawReason.includes('scroll')
              ? 'not_visible'
              : rawReason.includes('timeout') ||
                  (error instanceof Error && error.name === 'TimeoutError') ||
                  (nestedCause instanceof Error && nestedCause.name === 'TimeoutError')
                ? 'timeout'
                : 'unknown';
      this.pageDiagnostics.recordAction(page, {
        action: 'fill_ref',
        outcome: actionDispatched === false ? 'blocked' : 'failed',
        reason: diagnosticReason,
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
      phases.beginFinalization();
      const failure = new Stage5BrowserError(
        existing?.code ?? 'OPERATION_FAILED',
        existing?.message ?? 'The observed editor fill did not complete.',
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
      await handle?.dispose().catch(() => undefined);
      this.discardObservedSnapshot(frame);
      phases.ensureFailed();
      this.actionPhases.finish(phases);
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type InputFillRefOperations = typeof inputFillRefOperations;
