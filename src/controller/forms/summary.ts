import { type BrowserCommandInput, type BrowserCommandOutput, type ElementHandle, type FormFieldObservation, type FormFieldState, randomUUID, Stage5BrowserError } from '../dependencies.js';
import { boundedValue, type ObservedFormField, type ObservedFormInspection, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import { describeFormFieldElement, FORM_FIELD_SELECTOR } from './field-observation.js';

export const formSummaryOperations = {
  async formSummary(input: BrowserCommandInput<'formSummary'>): Promise<BrowserCommandOutput<'formSummary'>> {
    const page = await this.ensureActivePage(this.requireContext());
    const frame = this.resolveFrame(page, input.frameId);
    const deadlineAt = Date.now() + input.timeoutMs;
    const documentVersion = this.documentVersion(frame);
    const root = await this.snapshotRoot(frame);
    const candidates = root.locator.locator(FORM_FIELD_SELECTOR);
    const totalFields = await boundedValue(candidates.count(), Math.max(1, remainingUntil(deadlineAt)), -1);
    if (totalFields < 0) {
      throw new Stage5BrowserError('OPERATION_FAILED', 'Form-field inventory exceeded its bounded deadline.', {
        recoverable: true,
        details: { reason: 'form_field_inventory_timeout', actionDispatched: false },
      });
    }
    const fields = new Map<string, ObservedFormField>();
    let retained = false;
    try {
      for (let index = 0; index < Math.min(totalFields, input.maxFields); index += 1) {
        const locator = candidates.nth(index);
        const handle = await boundedValue(
          locator.elementHandle() as Promise<ElementHandle<HTMLElement> | null>,
          Math.max(1, remainingUntil(deadlineAt)),
          null,
        );
        if (handle === null) continue;
        const descriptor = await boundedValue(
          handle.evaluate(describeFormFieldElement),
          Math.max(1, remainingUntil(deadlineAt)),
          null,
        );
        if (descriptor === null) {
          await handle.dispose().catch(() => undefined);
          continue;
        }
        const ownerFormReference = await boundedValue(
          handle.evaluateHandle((element) => element.closest('form')),
          Math.max(1, remainingUntil(deadlineAt)),
          null,
        );
        const ownerFormHandle = ownerFormReference?.asElement() as ElementHandle<HTMLElement> | null;
        if (ownerFormReference !== null && ownerFormHandle === null) {
          await ownerFormReference.dispose().catch(() => undefined);
        }
        const fieldId = `field-${randomUUID()}`;
        fields.set(fieldId, { locator, handle, ownerFormHandle, observation: { fieldId, ...descriptor } });
      }
      if (frame.isDetached() || this.documentVersion(frame) !== documentVersion) {
        throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The form document changed during summary capture.', {
          recoverable: true,
          details: { reason: 'form_document_changed_during_summary', actionDispatched: false },
        });
      }
      const actionsLocator = root.locator.locator('button:visible, input[type="button"]:visible, input[type="submit"]:visible, a[href]:visible, [role="button"]:visible');
      const totalActions = await boundedValue(actionsLocator.count(), Math.max(1, remainingUntil(deadlineAt)), -1);
      const actions = totalActions < 0 ? [] : await Promise.all(
        Array.from({ length: Math.min(totalActions, input.maxActions) }, async (_, index) =>
          actionsLocator.nth(index).evaluate((element) => {
            const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim();
            const labelledBy = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/u)
              .filter(Boolean).map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '').join(' ');
            const name = normalize(element.getAttribute('aria-label') ?? '') || normalize(labelledBy) ||
              normalize(element.textContent ?? '') || (element instanceof HTMLInputElement ? normalize(element.value) : '');
            return {
              role: element instanceof HTMLAnchorElement ? 'link' as const : 'button' as const,
              name: name.slice(0, 500),
              disabled: ('disabled' in element && Boolean((element as HTMLButtonElement).disabled)) || element.getAttribute('aria-disabled') === 'true',
            };
          }),
        ),
      );
      const formId = `form-${randomUUID()}`;
      const inspection: ObservedFormInspection = {
        id: formId,
        frame,
        documentVersion,
        scope: root.scope,
        fields,
      };
      this.retainFormInspection(inspection);
      retained = true;
      const observations = [...fields.values()].map(({ observation }) => observation);
      const ambiguous = observations.some(({ name, kind }) => name === null || kind === 'custom_control');
      return {
        page: await this.pageSummary(page, undefined, remainingUntil(deadlineAt)),
        frame: this.frameSummary(frame, page),
        formId,
        scope: root.scope,
        fields: observations,
        actions,
        fieldsComplete: totalFields <= input.maxFields,
        actionsComplete: totalActions >= 0 && totalActions <= input.maxActions,
        choice: {
          responsibility: 'agent',
          decisionRequired: ambiguous,
          reason: ambiguous ? 'choose_materially_ambiguous_fields' : 'form_structurally_ready',
        },
      };
    } finally {
      if (!retained) {
        await Promise.allSettled([...fields.values()].flatMap(({ handle, ownerFormHandle }) => [
          handle.dispose(),
          ...(ownerFormHandle === null ? [] : [ownerFormHandle.dispose()]),
        ]));
      }
    }
  },

  async observeFormFieldState(handle: ElementHandle<HTMLElement>): Promise<FormFieldState> {
    return handle.evaluate((element) => {
      const input = element instanceof HTMLInputElement ? element : null;
      const type = input?.type.toLocaleLowerCase() ?? null;
      const privateField = type === 'password';
      const selected = type === 'checkbox' || type === 'radio'
        ? input?.checked ?? null
        : element.getAttribute('aria-checked') === null ? null : element.getAttribute('aria-checked') === 'true';
      const valuePresence = privateField ? 'not_observed_private' as const :
        type === 'checkbox' || type === 'radio' || element.getAttribute('role') === 'combobox' ? 'not_applicable' as const :
          element instanceof HTMLSelectElement ? (element.selectedIndex >= 0 ? 'present' as const : 'empty' as const) :
            type === 'file' ? ((input?.files?.length ?? 0) > 0 ? 'present' as const : 'empty' as const) :
              element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
                ? (element.value.length > 0 ? 'present' as const : 'empty' as const)
                : (element.textContent ?? '').trim().length > 0 ? 'present' as const : 'empty' as const;
      const ariaInvalid = element.getAttribute('aria-invalid');
      const valid = ariaInvalid !== null ? ariaInvalid !== 'true' :
        'checkValidity' in element && typeof element.checkValidity === 'function' ? element.checkValidity() : null;
      return { valuePresence, selected, valid };
    });
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type FormSummaryOperations = typeof formSummaryOperations;
