import { type BrowserCommandInput, type BrowserCommandOutput, type FormFieldRebindingSummary, type FormPlanStepResult, Stage5BrowserError } from '../dependencies.js';
import { remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

function aggregateDispatch(results: FormPlanStepResult[]): boolean | 'unknown' {
  if (results.some(({ actionDispatched }) => actionDispatched === 'unknown')) return 'unknown';
  return results.some(({ actionDispatched }) => actionDispatched === true);
}

function aggregateDispatchWith(
  results: FormPlanStepResult[],
  current: boolean | 'unknown',
): boolean | 'unknown' {
  if (current === 'unknown' || results.some(({ actionDispatched }) => actionDispatched === 'unknown')) return 'unknown';
  return current || results.some(({ actionDispatched }) => actionDispatched === true);
}

function rebindingSummary(
  results: FormPlanStepResult[],
  currentRebound = false,
  failed = false,
): FormFieldRebindingSummary {
  const reboundSteps = results.filter(({ fieldResolution }) =>
    fieldResolution.resolution === 'rebound_exact').length + (currentRebound ? 1 : 0);
  return { attempted: reboundSteps > 0 || failed, reboundSteps, failed };
}

export const formPlanOperations = {
  async applyFormPlan(
    input: BrowserCommandInput<'applyFormPlan'>,
  ): Promise<BrowserCommandOutput<'applyFormPlan'>> {
    const page = await this.ensureActivePage(this.requireContext());
    const frame = this.resolveFrame(page, input.frameId);
    const workflow = this.formWorkflows.begin(input.formId, input.steps.length, input.timeoutMs);
    const inspection = this.consumeFormInspection(frame, input.formId);
    const completedSteps: FormPlanStepResult[] = [];
    try {
      for (const [index, step] of input.steps.entries()) {
        const field = inspection.fields.get(step.fieldId);
        if (field === undefined) {
          throw new Stage5BrowserError('TARGET_NOT_FOUND', 'A form-plan fieldId was not present in the exact summary.', {
            recoverable: true,
            details: { reason: 'form_plan_field_not_observed', failedStep: index, actionDispatched: false },
          });
        }
        if (step.kind === 'fill' && !['contenteditable', 'date', 'private', 'text', 'textarea'].includes(field.observation.kind)) {
          throw new Stage5BrowserError('OPERATION_FAILED', 'A fill step does not match the observed field kind.', {
            details: { reason: 'form_plan_step_kind_mismatch', failedStep: index, actionDispatched: false },
          });
        }
        if (step.kind === 'select' && field.observation.kind !== 'native_select') {
          throw new Stage5BrowserError('OPERATION_FAILED', 'A staged select step requires a native select field.', {
            recoverable: true,
            details: {
              reason: 'form_plan_custom_control_requires_select_option',
              failedStep: index,
              actionDispatched: false,
              suggestedAction: 'Use browser_select_option for this custom control after the staged native/text/check steps.',
            },
          });
        }
        if (step.kind === 'set_checked' && !['checkbox', 'radio'].includes(field.observation.kind) && field.observation.role !== 'switch') {
          throw new Stage5BrowserError('OPERATION_FAILED', 'A checked-state step does not match the observed field kind.', {
            details: { reason: 'form_plan_step_kind_mismatch', failedStep: index, actionDispatched: false },
          });
        }
      }

      for (const [index, step] of input.steps.entries()) {
        workflow.beginStep(index);
        const originalField = inspection.fields.get(step.fieldId);
        if (originalField === undefined) throw new Error('The preflighted form field disappeared from the retained plan.');
        let resolved: Awaited<ReturnType<BrowserControllerContext['resolveCurrentFormField']>> | null = null;
        try {
          resolved = await this.resolveCurrentFormField(
            frame,
            inspection,
            originalField,
            Date.now() + Math.max(1, workflow.remainingMs()),
          );
          const field = resolved.field;
          const evidence = step.kind === 'fill'
            ? await this.fillObservedFormField(page, field, step.value, Math.max(1, workflow.remainingMs()))
            : step.kind === 'select'
              ? await this.selectObservedFormField(frame, field, step.option, Math.max(1, workflow.remainingMs()))
              : await this.setObservedFormFieldChecked(page, frame, field, step.checked, Math.max(1, workflow.remainingMs()));
          const result: FormPlanStepResult = {
            index,
            fieldId: step.fieldId,
            kind: step.kind,
            fieldResolution: resolved.fieldResolution,
            ...evidence,
          };
          completedSteps.push(result);
          workflow.completeStep(index);
          if (frame.isDetached() || this.documentVersion(frame) !== inspection.documentVersion) {
            throw new Stage5BrowserError('OPERATION_FAILED', 'The form document changed after a staged input.', {
              recoverable: true,
              details: {
                reason: 'form_document_changed_after_step',
                failedStep: index,
                actionDispatched: aggregateDispatch(completedSteps),
                completedSteps,
                suggestedAction: 'Inspect the authoritative new document. Do not replay the completed staged inputs.',
              },
            });
          }
        } catch (error) {
          const raw = error instanceof Stage5BrowserError ? error.details?.actionDispatched : null;
          const actionDispatched = raw === true || raw === false || raw === 'unknown' ? raw : false;
          const failedRebind = error instanceof Stage5BrowserError &&
            typeof error.details?.reason === 'string' &&
            error.details.reason.startsWith('form_field_rebind_');
          const currentRebound = resolved?.fieldResolution.resolution === 'rebound_exact';
          throw new Stage5BrowserError(
            error instanceof Stage5BrowserError ? error.code : 'OPERATION_FAILED',
            error instanceof Error ? error.message : 'The staged form plan did not complete.',
            {
              recoverable: error instanceof Stage5BrowserError ? error.recoverable : true,
              details: {
                ...(error instanceof Stage5BrowserError ? error.details : {}),
                failedStep: index,
                completedSteps,
                actionDispatched: aggregateDispatchWith(completedSteps, actionDispatched),
                fieldRebinding: rebindingSummary(completedSteps, currentRebound, failedRebind),
                ...(resolved === null ? {} : { fieldResolution: resolved.fieldResolution }),
                suggestedAction: raw === false && completedSteps.length === 0
                  ? 'Take one fresh form summary before a corrected plan; no staged input was dispatched.'
                  : 'Inspect authoritative form state. Do not replay completed or possibly dispatched plan steps.',
              },
              cause: error,
            },
          );
        } finally {
          await resolved?.dispose();
        }
      }
      workflow.finish('succeeded');
      return {
        page: await this.pageSummary(page, undefined, remainingUntil(workflow.deadlineAtMs)),
        frame: this.frameSummary(frame, page),
        formId: input.formId,
        completedSteps,
        actionDispatched: aggregateDispatch(completedSteps),
        fieldRebinding: rebindingSummary(completedSteps),
        requiresFreshSummary: true,
      };
    } catch (error) {
      workflow.finish('failed');
      throw error;
    } finally {
      await this.disposeFormInspection(inspection);
      this.formWorkflows.finish(workflow);
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type FormPlanOperations = typeof formPlanOperations;
