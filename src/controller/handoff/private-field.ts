import { type BrowserCommandInput, type BrowserCommandOutput, type ElementHandle, inspectTargetState, type Locator, randomUUID, Stage5BrowserError } from '../dependencies.js';
import { boundedValue, type ObservedFormInspection, type PrivateFieldHandoff, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const privateFieldHandoffOperations = {
  privateFieldStatus(): BrowserCommandOutput<'privateFieldStatus'> {
    const handoff = this.privateFieldHandoff;
    return handoff === null
      ? {
          controlMode: 'agent',
          state: 'inactive',
          handoffId: null,
          fieldLabel: null,
          valueType: null,
          requestedAt: null,
        }
      : {
          controlMode: 'private_field',
          state: 'awaiting_user',
          handoffId: handoff.id,
          fieldLabel: handoff.fieldLabel,
          valueType: handoff.valueType,
          requestedAt: handoff.requestedAt,
        };
  },

  privateFieldInProgressError(): Stage5BrowserError {
    return new Stage5BrowserError('AUTH_HANDOFF_REQUIRED', 'A field-scoped private input handoff is active.', {
      recoverable: true,
      details: {
        reason: 'private_field_handoff_in_progress',
        suggestedAction: 'Let the user complete or leave the highlighted field unchanged, then call browser_resume_private_field_handoff with the exact handoffId. Do not stop, recover, navigate, or inspect the page meanwhile.',
      },
    });
  },

  async requestPrivateFieldHandoff(
    input: BrowserCommandInput<'requestPrivateFieldHandoff'>,
  ): Promise<BrowserCommandOutput<'requestPrivateFieldHandoff'>> {
    if (this.privateFieldHandoff !== null) throw this.privateFieldInProgressError();
    if (this.pendingHandoffRelease !== null || this.authenticationHandoff !== null) {
      throw this.humanBootstrapInProgressError('Complete the existing private browser handoff before beginning a field-scoped handoff.');
    }
    const page = await this.ensureActivePage(this.requireContext());
    const frame = this.resolveFrame(page, input.frameId);
    const deadlineAt = Date.now() + input.timeoutMs;
    let inspection: ObservedFormInspection | null = null;
    let handle: ElementHandle<HTMLElement> | null = null;
    let fieldLabel: string | null = null;
    let locator: Locator;
    let retained = false;
    try {
      if (input.target.kind === 'form_field') {
        inspection = this.consumeFormInspection(frame, input.target.formId);
        const field = inspection.fields.get(input.target.fieldId);
        if (field === undefined) {
          throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The private fieldId was not present in the exact form summary.', {
            recoverable: true,
            details: { reason: 'private_form_field_not_observed', actionDispatched: false },
          });
        }
        inspection.fields.delete(input.target.fieldId);
        handle = field.handle;
        locator = field.locator;
        fieldLabel = field.observation.name;
      } else {
        const control = input.target.control;
        locator = frame.getByRole(control.role, { name: control.name, exact: control.exact });
        const count = await boundedValue(locator.count(), Math.max(1, remainingUntil(deadlineAt)), -1);
        if (count !== 1) {
          throw new Stage5BrowserError(count > 1 ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND', 'The private field target was not one unique exact control.', {
            recoverable: true,
            details: { reason: 'private_field_not_unique', actionDispatched: false },
          });
        }
        handle = await locator.elementHandle() as ElementHandle<HTMLElement> | null;
        fieldLabel = control.name;
      }
      if (handle === null || fieldLabel === null || fieldLabel.trim().length === 0) {
        throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The private field requires one visible exact label and retained control.', {
          recoverable: true,
          details: {
            reason: 'private_field_label_or_handle_missing',
            actionDispatched: false,
            suggestedAction: 'Take one fresh form summary and choose a uniquely labelled field before requesting private input.',
          },
        });
      }
      const descriptor = await this.inspectPrivateField(handle);
      if (descriptor === null || !descriptor.editable || !descriptor.visible || !descriptor.enabled) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The exact private field is not visibly editable for a user handoff.', {
          recoverable: true,
          details: { reason: 'private_field_not_editable', actionDispatched: false },
        });
      }
      const pageActivation = await this.primeSelectedPageForTargetPreparation(
        page,
        deadlineAt,
        new Date().toISOString(),
        'focus',
      );
      if (!this.pageIsActivatedForInput(pageActivation)) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The private field page could not become visible for the user.', {
          recoverable: true,
          details: { reason: 'private_field_page_not_active', actionDispatched: false, pageActivation },
        });
      }
      const targetState = await inspectTargetState(handle);
      if (targetState === null || !targetState.visible || !targetState.inViewport || !targetState.enabled) {
        await handle.evaluate((element) => element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' }));
      }
      const before = (await this.observePrivateFieldState(handle)).state;
      const style = await handle.evaluate((element) => {
        const priorOutline = element.style.outline;
        const priorOutlineOffset = element.style.outlineOffset;
        element.style.outline = '3px solid #5b8def';
        element.style.outlineOffset = '3px';
        element.focus({ preventScroll: true });
        return { priorOutline, priorOutlineOffset };
      });
      const requestedAt = new Date().toISOString();
      const handoff: PrivateFieldHandoff = {
        id: `private-field-${randomUUID()}`,
        page,
        frame,
        documentVersion: this.documentVersion(frame),
        handle,
        locator,
        fieldLabel: fieldLabel.trim().slice(0, 500),
        valueType: input.valueType,
        before,
        requestedAt,
        ...style,
      };
      this.privateFieldHandoff = handoff;
      retained = true;
      return {
        controlMode: 'private_field',
        state: 'awaiting_user',
        handoffId: handoff.id,
        fieldLabel: handoff.fieldLabel,
        valueType: handoff.valueType,
        requestedAt,
        page: await this.pageSummary(page, undefined, remainingUntil(deadlineAt)),
        instructions: `In the dedicated Stage5 browser, enter the ${input.valueType.replaceAll('_', ' ')} only into the highlighted “${handoff.fieldLabel}” field. Do not save, continue, submit, upload, accept terms, or perform another action. Return here when the field is complete or intentionally unchanged.`,
      };
    } finally {
      if (inspection !== null) await this.disposeFormInspection(inspection);
      if (!retained) await handle?.dispose().catch(() => undefined);
    }
  },

  async resumePrivateFieldHandoff(
    input: BrowserCommandInput<'resumePrivateFieldHandoff'>,
  ): Promise<BrowserCommandOutput<'resumePrivateFieldHandoff'>> {
    const handoff = this.privateFieldHandoff;
    if (handoff === null || handoff.id !== input.handoffId) {
      throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The private field handoffId is stale or unavailable.', {
        recoverable: true,
        details: { reason: 'stale_private_field_handoff', actionDispatched: false },
      });
    }
    const deadlineAt = Date.now() + input.timeoutMs;
    let observed: Awaited<ReturnType<BrowserControllerContext['observePrivateFieldState']>> | null = null;
    try {
      if (
        !handoff.page.isClosed() &&
        !handoff.frame.isDetached() &&
        this.documentVersion(handoff.frame) === handoff.documentVersion
      ) {
        observed = await boundedValue(
          this.observePrivateFieldState(handoff.handle),
          Math.max(1, remainingUntil(deadlineAt)),
          null,
        );
      }
      await handoff.handle.evaluate((element, style) => {
        element.style.outline = style.priorOutline;
        element.style.outlineOffset = style.priorOutlineOffset;
      }, { priorOutline: handoff.priorOutline, priorOutlineOffset: handoff.priorOutlineOffset }).catch(() => undefined);
    } finally {
      this.privateFieldHandoff = null;
      await handoff.handle.dispose().catch(() => undefined);
    }
    const after = observed?.state ?? null;
    const outcome = observed === null ? 'target_changed' as const :
      observed.state.valid === false ? 'validation_error' as const :
        observed.state.valuePresence !== handoff.before.valuePresence || observed.state.selected !== handoff.before.selected
          ? 'completed' as const
          : handoff.before.valuePresence === 'present' || handoff.before.valuePresence === 'not_observed_private'
            ? 'unverifiable_change' as const
            : 'unchanged' as const;
    const page = handoff.page.isClosed()
      ? await this.ensureActivePage(this.requireContext())
      : handoff.page;
    return {
      controlMode: 'agent',
      state: 'inactive',
      handoffId: null,
      fieldLabel: handoff.fieldLabel,
      valueType: handoff.valueType,
      requestedAt: null,
      outcome,
      page: await this.pageSummary(page, undefined, remainingUntil(deadlineAt)),
      before: handoff.before,
      after,
      validationMessagePresent: observed?.validationMessagePresent ?? null,
      instructions: outcome === 'completed'
        ? 'The private field changed and remains privacy-redacted. Inspect only the surrounding form state before continuing.'
        : outcome === 'validation_error'
          ? 'The field reports a validation error. Request a new field-scoped handoff only after explaining the field label and value type; never ask for the value.'
          : outcome === 'unchanged'
            ? 'The field remained unchanged. Continue only if that was intentional.'
            : 'The runtime cannot prove the private value change. Inspect surrounding privacy-safe state and do not request the value or replay input.',
    };
  },

  async inspectPrivateField(handle: ElementHandle<HTMLElement>): Promise<{
    editable: boolean;
    enabled: boolean;
    visible: boolean;
  } | null> {
    return handle.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const input = element instanceof HTMLInputElement;
      const editable = (input && !['button', 'hidden', 'image', 'reset', 'submit'].includes(element.type.toLocaleLowerCase())) ||
        element instanceof HTMLTextAreaElement || element.isContentEditable;
      return {
        editable,
        enabled: !('disabled' in element && Boolean((element as HTMLInputElement).disabled)) && element.getAttribute('aria-disabled') !== 'true',
        visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0',
      };
    }).catch(() => null);
  },

  async observePrivateFieldState(handle: ElementHandle<HTMLElement>): Promise<{
    state: BrowserCommandOutput<'resumePrivateFieldHandoff'>['before'];
    validationMessagePresent: boolean;
  }> {
    return handle.evaluate((element) => {
      const input = element instanceof HTMLInputElement ? element : null;
      const type = input?.type.toLocaleLowerCase() ?? null;
      const selected = type === 'checkbox' || type === 'radio'
        ? input?.checked ?? null
        : element.getAttribute('aria-checked') === null ? null : element.getAttribute('aria-checked') === 'true';
      const valuePresence = type === 'checkbox' || type === 'radio' ? 'not_applicable' as const :
        type === 'file' ? ((input?.files?.length ?? 0) > 0 ? 'present' as const : 'empty' as const) :
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? (element.value.length > 0 ? 'present' as const : 'empty' as const)
            : (element.textContent ?? '').trim().length > 0 ? 'present' as const : 'empty' as const;
      const ariaInvalid = element.getAttribute('aria-invalid');
      const valid = ariaInvalid !== null ? ariaInvalid !== 'true' :
        'checkValidity' in element && typeof element.checkValidity === 'function' ? element.checkValidity() : null;
      const validationMessagePresent = 'validationMessage' in element &&
        typeof element.validationMessage === 'string' && element.validationMessage.length > 0;
      return { state: { valuePresence, selected, valid }, validationMessagePresent };
    });
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type PrivateFieldHandoffOperations = typeof privateFieldHandoffOperations;
