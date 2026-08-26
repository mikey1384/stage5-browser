import { type FillRefEvidence, type FormFieldState, inspectTargetState, type Page, Stage5BrowserError } from '../dependencies.js';
import { CLICK_REF_INCREMENTAL_SETTLE_MS, fillFinalizationReserve, type ObservedFormField, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export interface FormFieldMutationEvidence {
  actionDispatched: boolean | 'unknown';
  alreadySatisfied: boolean;
  before: FormFieldState;
  after: FormFieldState;
  inputEvidence?: FillRefEvidence;
}

export const formFieldFillOperations = {
  async fillObservedFormField(
    page: Page,
    field: ObservedFormField,
    value: string,
    timeoutMs: number,
  ): Promise<FormFieldMutationEvidence> {
    const phases = this.actionPhases.begin('form_fill', timeoutMs);
    const actionDeadlineAt = phases.deadlineAtMs - fillFinalizationReserve(timeoutMs);
    try {
      phases.enter('observe');
      const before = await this.observeFormFieldState(field.handle);
      phases.enter('plan');
      if (!['contenteditable', 'date', 'text', 'textarea'].includes(field.observation.kind)) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The exact form field is not a non-private text editor.', {
          recoverable: true,
          details: { reason: 'form_field_not_fillable', actionDispatched: false },
        });
      }
      phases.enter('preflight');
      const activation = await this.primeSelectedPageForTargetPreparation(
        page,
        actionDeadlineAt,
        new Date(phases.startedAtMs).toISOString(),
        'fill_by_role',
      );
      phases.enter('prepare');
      const descriptor = await this.inspectFillTarget(field.handle, Math.max(1, remainingUntil(actionDeadlineAt)));
      if (descriptor === null || !descriptor.enabled) {
        throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The exact form field changed before fill dispatch.', {
          recoverable: true,
          details: { reason: 'form_field_changed_before_fill', actionDispatched: false },
        });
      }
      this.validateFillValue(descriptor, value);
      let state = await inspectTargetState(field.handle);
      if (state?.visible === true && !state.inViewport) {
        await field.handle.evaluate((element) => element.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' }));
        const settleMs = Math.min(CLICK_REF_INCREMENTAL_SETTLE_MS, remainingUntil(actionDeadlineAt));
        if (settleMs > 0) await page.waitForTimeout(settleMs);
        state = await inspectTargetState(field.handle);
      }
      if (state === null || !state.visible || !state.inViewport || !state.enabled || !this.pageIsActivatedForInput(activation)) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The exact form field is not safely actionable.', {
          recoverable: true,
          details: { reason: 'form_field_not_actionable', actionDispatched: false, targetState: state },
        });
      }
      phases.beginDispatch();
      const inputEvidence = await this.dispatchPreparedFill(
        field.handle,
        descriptor,
        value,
        actionDeadlineAt,
        phases.deadlineAtMs,
      );
      phases.concludeDispatch({ actionDispatched: inputEvidence.actionDispatched });
      phases.enter('reconcile');
      const after = await this.observeFormFieldState(field.handle);
      phases.beginFinalization();
      const result = {
        actionDispatched: inputEvidence.actionDispatched,
        alreadySatisfied: inputEvidence.valueMatchedBefore,
        before,
        after,
        inputEvidence,
      };
      phases.complete('succeeded');
      return result;
    } catch (error) {
      if (phases.snapshot().currentPhase === 'dispatch') {
        const raw = error instanceof Stage5BrowserError ? error.details?.actionDispatched : null;
        phases.concludeDispatch({ actionDispatched: raw === true || raw === false || raw === 'unknown' ? raw : 'unknown' });
        phases.enter('reconcile');
      }
      phases.beginFinalization();
      phases.complete('failed');
      throw error;
    } finally {
      phases.ensureFailed();
      this.actionPhases.finish(phases);
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type FormFieldFillOperations = typeof formFieldFillOperations;
