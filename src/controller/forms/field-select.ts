import { type ControlOptionTarget, type ElementHandle, type Frame, randomUUID, Stage5BrowserError } from '../dependencies.js';
import { type ObservedControlInspection, type ObservedControlOption, type ObservedFormField } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import type { FormFieldMutationEvidence } from './field-fill.js';

export const formFieldSelectOperations = {
  async selectObservedFormField(
    frame: Frame,
    field: ObservedFormField,
    requested: ControlOptionTarget,
    timeoutMs: number,
  ): Promise<FormFieldMutationEvidence> {
    if (field.observation.kind !== 'native_select') {
      throw new Stage5BrowserError('OPERATION_FAILED', 'Staged form selection currently requires an exact native select field.', {
        recoverable: true,
        details: {
          reason: 'form_field_requires_control_selection',
          actionDispatched: false,
          suggestedAction: 'Use browser_select_option for this exact custom control; Stage5 Browser did not dispatch a selection.',
        },
      });
    }
    const before = await this.observeFormFieldState(field.handle);
    const candidates = await field.handle.evaluate((control) => {
      if (!(control instanceof HTMLSelectElement)) return null;
      return Array.from(control.options).map((option, index) => ({
        index,
        name: (option.label || option.textContent || '').replace(/\s+/gu, ' ').trim(),
        disabled: option.disabled,
        selected: option.selected,
      }));
    });
    if (candidates === null) {
      throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The native select field changed after the form summary.', {
        recoverable: true,
        details: { reason: 'native_form_select_changed', actionDispatched: false },
      });
    }
    const matches = candidates.filter((candidate) => requested.exact
      ? candidate.name === requested.name
      : candidate.name.toLocaleLowerCase().includes(requested.name.toLocaleLowerCase()));
    if (matches.length !== 1 || matches[0] === undefined) {
      throw new Stage5BrowserError(matches.length > 1 ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND', 'The staged native option was not one unique observed choice.', {
        recoverable: true,
        details: {
          reason: matches.length > 1 ? 'ambiguous_native_form_option' : 'native_form_option_missing',
          actionDispatched: false,
          choices: candidates.slice(0, 50).map(({ name, disabled }) => ({ name, disabled })),
          responsible: 'agent',
        },
      });
    }
    const match = matches[0];
    const optionLocator = field.locator.locator('option').nth(match.index);
    const optionHandle = await optionLocator.elementHandle() as ElementHandle<HTMLElement> | null;
    if (optionHandle === null) {
      throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The exact native option detached before dispatch.', {
        recoverable: true,
        details: { reason: 'native_form_option_detached', actionDispatched: false },
      });
    }
    try {
      const observedOption: ObservedControlOption = {
        observation: {
          optionId: `option-${randomUUID()}`,
          name: match.name,
          role: 'option',
          selected: match.selected,
          disabled: match.disabled,
        },
        locator: optionLocator,
        handle: optionHandle,
      };
      const inspection: ObservedControlInspection = {
        id: `control-${randomUUID()}`,
        frame,
        documentVersion: this.documentVersion(frame),
        kind: 'native_select',
        controlRole: field.observation.role,
        controlName: field.observation.name ?? '',
        controlExact: true,
        controlLocator: field.locator,
        controlHandle: field.handle,
        popupSurfaces: [],
        multiple: field.observation.multiple,
        optionsComplete: true,
        options: new Map([[observedOption.observation.optionId, observedOption]]),
      };
      const evidence = await this.selectNativeControlOption(
        inspection,
        observedOption,
        Date.now() + timeoutMs,
      );
      const after = await this.observeFormFieldState(field.handle);
      return {
        actionDispatched: evidence.actionDispatched,
        alreadySatisfied: evidence.actionDispatched === false && evidence.selectionEffectObserved,
        before,
        after,
      };
    } finally {
      await optionHandle.dispose().catch(() => undefined);
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type FormFieldSelectOperations = typeof formFieldSelectOperations;
