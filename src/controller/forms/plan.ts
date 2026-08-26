import { type BrowserCommandInput, type BrowserCommandOutput, type FormPlanStepResult, Stage5BrowserError } from '../dependencies.js';
import { remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

function aggregateDispatch(results: FormPlanStepResult[]): boolean | 'unknown' {
  if (results.some(({ actionDispatched }) => actionDispatched === 'unknown')) return 'unknown';
  return results.some(({ actionDispatched }) => actionDispatched === true);
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
        if (field.observation.kind === 'private') {
          throw new Stage5BrowserError('AUTH_HANDOFF_REQUIRED', 'Private form fields cannot receive agent-supplied staged values.', {
            recoverable: true,
            details: {
              reason: 'private_form_field_requires_handoff',
              failedStep: index,
              actionDispatched: false,
              suggestedAction: 'Use the field-scoped private handoff for this exact field; do not send its value to the agent.',
            },
          });
        }
        if (step.kind === 'fill' && !['contenteditable', 'date', 'text', 'textarea'].includes(field.observation.kind)) {
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
        const field = inspection.fields.get(step.fieldId);
        if (field === undefined) throw new Error('The preflighted form field disappeared from the retained plan.');
        try {
          const evidence = step.kind === 'fill'
            ? await this.fillObservedFormField(page, field, step.value, Math.max(1, workflow.remainingMs()))
            : step.kind === 'select'
              ? await this.selectObservedFormField(frame, field, step.option, Math.max(1, workflow.remainingMs()))
              : await this.setObservedFormFieldChecked(page, frame, field, step.checked, Math.max(1, workflow.remainingMs()));
          const result: FormPlanStepResult = {
            index,
            fieldId: step.fieldId,
            kind: step.kind,
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
          throw new Stage5BrowserError(
            error instanceof Stage5BrowserError ? error.code : 'OPERATION_FAILED',
            error instanceof Error ? error.message : 'The staged form plan did not complete.',
            {
              recoverable: error instanceof Stage5BrowserError ? error.recoverable : true,
              details: {
                ...(error instanceof Stage5BrowserError ? error.details : {}),
                failedStep: index,
                completedSteps,
                actionDispatched: raw === true || raw === false || raw === 'unknown'
                  ? (completedSteps.length === 0 ? raw : aggregateDispatch([...completedSteps, {
                    index,
                    fieldId: step.fieldId,
                    kind: step.kind,
                    actionDispatched: raw,
                    alreadySatisfied: false,
                    before: field.observation,
                    after: field.observation,
                  }]))
                  : aggregateDispatch(completedSteps),
                suggestedAction: raw === false && completedSteps.length === 0
                  ? 'Take one fresh form summary before a corrected plan; no staged input was dispatched.'
                  : 'Inspect authoritative form state. Do not replay completed or possibly dispatched plan steps.',
              },
              cause: error,
            },
          );
        }
      }
      workflow.finish('succeeded');
      return {
        page: await this.pageSummary(page, undefined, remainingUntil(workflow.deadlineAtMs)),
        frame: this.frameSummary(frame, page),
        formId: input.formId,
        completedSteps,
        actionDispatched: aggregateDispatch(completedSteps),
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
