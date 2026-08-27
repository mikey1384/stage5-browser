import { type BrowserCommandInput, type BrowserCommandOutput, type ElementHandle, type FormFieldObservation, type Frame, type Page, type SanitizedNativeWindowActivationEvidence, Stage5BrowserError } from '../dependencies.js';
import { type ObservedFormField, type ObservedFormInspection } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import type { ClickActivationPolicy } from '../action/click-plan.js';
import type { FormFieldMutationEvidence } from './field-fill.js';

export const formFieldCheckOperations = {
  async setObservedFormFieldChecked(
    page: Page,
    frame: Frame,
    field: ObservedFormField,
    checked: boolean,
    timeoutMs: number,
  ): Promise<FormFieldMutationEvidence> {
    const before = await this.observeFormFieldState(field.handle);
    if (!['checkbox', 'radio'].includes(field.observation.kind) && field.observation.role !== 'switch') {
      throw new Stage5BrowserError('OPERATION_FAILED', 'The exact form field is not a checkbox, radio, or switch.', {
        recoverable: true,
        details: { reason: 'form_field_not_checkable', actionDispatched: false },
      });
    }
    if (field.observation.kind === 'radio' && !checked) {
      throw new Stage5BrowserError('OPERATION_FAILED', 'A radio option cannot be safely cleared without choosing its intended alternative.', {
        recoverable: true,
        details: {
          reason: 'radio_clear_requires_alternative',
          actionDispatched: false,
          responsible: 'agent',
          suggestedAction: 'Choose and set the intended radio option instead of toggling this one off.',
        },
      });
    }
    if (before.selected === checked) {
      return { actionDispatched: false, alreadySatisfied: true, before, after: before };
    }
    const postcondition = {
      expectedUrl: null,
      expectedNewPageUrl: null,
      expectedSelected: checked,
      expectedVisible: null,
      expectedHidden: null,
      satisfaction: 'all' as const,
      timeoutMs: Math.max(100, Math.min(2_000, timeoutMs)),
    };
    const result = await this.executeClickAction({
      action: 'set_checked',
      timeoutMs,
      observe: async () => ({ page, frame }),
      plan: ({ frame }) => ({
        action: 'set_checked',
        activationPolicy: 'postconditioned_native_keyboard',
        page,
        frame,
        postcondition,
        prepare: async (
          priorNativeActivation: SanitizedNativeWindowActivationEvidence | null,
          activationAttemptCount: number,
          actionStartedAt: string,
          actionDeadlineAt: number,
          activationPolicy: ClickActivationPolicy,
        ) => {
          const pageActivation = await this.primeSelectedPageForTargetPreparation(
            page,
            actionDeadlineAt,
            actionStartedAt,
            'set_checked',
            activationAttemptCount,
            priorNativeActivation ?? undefined,
          );
          const borrowed = await field.locator.elementHandle() as ElementHandle<HTMLElement> | null;
          if (borrowed === null || !await field.handle.evaluate((retained, current) => retained === current, borrowed).catch(() => false)) {
            await borrowed?.dispose().catch(() => undefined);
            throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The exact form field changed before checked-state dispatch.', {
              recoverable: true,
              details: { reason: 'checkable_form_field_changed', actionDispatched: false },
            });
          }
          return this.prepareObservedClickTarget(
            page,
            frame,
            field.locator,
            actionStartedAt,
            actionDeadlineAt,
            postcondition,
            pageActivation,
            borrowed,
            activationPolicy,
          );
        },
        reconciliationLocator: () => field.locator,
        discardCapabilities: () => undefined,
      }),
      preflight: () => undefined,
    });
    const after = await this.observeFormFieldState(field.handle);
    return {
      actionDispatched: result.dispatch.actionDispatched,
      alreadySatisfied: false,
      before,
      after,
    };
  },

  async setChecked(input: BrowserCommandInput<'setChecked'>): Promise<BrowserCommandOutput<'setChecked'>> {
    const page = await this.ensureActivePage(this.requireContext());
    const frame = this.resolveFrame(page, input.frameId);
    let inspection: ObservedFormInspection | null = null;
    let temporaryHandle: ElementHandle<HTMLElement> | null = null;
    try {
      let field: ObservedFormField;
      if (input.formId !== null && input.fieldId !== null) {
        inspection = this.consumeFormInspection(frame, input.formId);
        const observed = inspection.fields.get(input.fieldId);
        if (observed === undefined) {
          throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The fieldId was not present in the exact form summary.', {
            recoverable: true,
            details: { reason: 'form_field_not_observed', actionDispatched: false },
          });
        }
        field = observed;
      } else if (input.control !== null) {
        const locator = frame.getByRole(input.control.role, { name: input.control.name, exact: input.control.exact });
        if (await locator.count() !== 1) {
          throw new Stage5BrowserError('AMBIGUOUS_TARGET', 'The checkable control was not one unique exact target.', {
            recoverable: true,
            details: { reason: 'checkable_control_not_unique', actionDispatched: false },
          });
        }
        temporaryHandle = await locator.elementHandle() as ElementHandle<HTMLElement> | null;
        if (temporaryHandle === null) {
          throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The checkable control detached before preflight.', {
            recoverable: true,
            details: { reason: 'checkable_control_detached', actionDispatched: false },
          });
        }
        const descriptor = await temporaryHandle.evaluate((element) => {
          const inputElement = element instanceof HTMLInputElement ? element : null;
          const type = inputElement?.type.toLocaleLowerCase() ?? null;
          const role = element.getAttribute('role')?.toLocaleLowerCase() ?? type ?? '';
          const kind: 'checkbox' | 'radio' = type === 'radio' || role === 'radio' ? 'radio' : 'checkbox';
          return { type, role, kind };
        });
        const observation: FormFieldObservation = {
          fieldId: 'direct-control',
          kind: descriptor.kind,
          role: descriptor.role,
          name: input.control.name,
          inputType: descriptor.type,
          required: false,
          disabled: false,
          readOnly: false,
          multiple: false,
          optionNames: [],
          selectedOptionNames: [],
          optionsComplete: true,
          ...await this.observeFormFieldState(temporaryHandle),
        };
        field = { observation, locator, handle: temporaryHandle, ownerFormHandle: null };
      } else {
        throw new Stage5BrowserError('OPERATION_FAILED', 'Set checked requires either one form field capability or one exact semantic control.', {
          details: { reason: 'invalid_set_checked_target', actionDispatched: false },
        });
      }
      const evidence = await this.setObservedFormFieldChecked(page, frame, field, input.checked, input.timeoutMs);
      return {
        page: await this.pageSummary(page, undefined, input.timeoutMs),
        frame: this.frameSummary(frame, page),
        checked: input.checked,
        ...evidence,
      };
    } finally {
      if (inspection !== null) await this.disposeFormInspection(inspection);
      else await temporaryHandle?.dispose().catch(() => undefined);
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type FormFieldCheckOperations = typeof formFieldCheckOperations;
