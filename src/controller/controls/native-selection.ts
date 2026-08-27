import { randomUUID } from 'node:crypto';

import { type ControlSelectionEvidence, Stage5BrowserError } from '../dependencies.js';
import { type ObservedControlInspection, type ObservedControlOption, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

interface NativeSelectEventRecord {
  inputEventObserved: boolean;
  changeEventObserved: boolean;
  inputListener: EventListener;
  changeListener: EventListener;
}

export async function selectNativeControlOption(
  this: BrowserControllerContext,
  inspection: ObservedControlInspection,
  option: ObservedControlOption,
  deadlineAt: number,
  desiredSelected = true,
): Promise<ControlSelectionEvidence> {
  const startedAt = Date.now();
  const phases = this.actionPhases.begin('select_option', Math.max(1, remainingUntil(deadlineAt)));
  const token = `__stage5_select_${randomUUID().replaceAll('-', '')}`;
  try {
    phases.enter('observe');
    const before = await inspection.controlHandle.evaluate((control, target) => {
      if (!(control instanceof HTMLSelectElement) || !(target instanceof HTMLOptionElement) || target.closest('select') !== control) return null;
      return {
        targetIndex: target.index,
        selected: target.selected,
        selectedIndexes: Array.from(control.options).filter((candidate) => candidate.selected).map((candidate) => candidate.index),
        multiple: control.multiple,
        disabled: control.disabled || target.disabled,
      };
    }, option.handle);
    if (before === null || before.disabled) {
      throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The native select capability changed before dispatch.', {
        recoverable: true,
        details: { reason: before === null ? 'native_option_changed' : 'option_not_enabled', actionDispatched: false },
      });
    }
    phases.enter('plan');
    if (before.selected === desiredSelected) {
      phases.enter('preflight');
      phases.enter('prepare');
      phases.beginFinalization();
      phases.complete('succeeded');
      return {
        actionDispatched: false,
        inputEventObserved: false,
        changeEventObserved: false,
        selectionEffectObserved: true,
        selectedRepresentationObserved: false,
        selectedState: desiredSelected,
        popupClosed: null,
        reconciliation: {
          targetResolution: 'retained_exact',
          attempts: 0,
          durationMs: 0,
          terminalProof: 'selected_state',
        },
      };
    }
    if (!desiredSelected && !before.multiple) {
      throw new Stage5BrowserError('OPERATION_FAILED', 'The selected native option cannot be cleared without choosing a replacement.', {
        recoverable: true,
        details: {
          reason: 'control_not_multiselect',
          actionDispatched: false,
          suggestedAction: 'Choose the intended replacement option for this single-select control.',
        },
      });
    }
    phases.enter('preflight');
    await inspection.controlHandle.evaluate((control, key) => {
      const global = window as typeof window & Record<string, unknown>;
      const inputListener: EventListener = () => { (global[key] as NativeSelectEventRecord).inputEventObserved = true; };
      const changeListener: EventListener = () => { (global[key] as NativeSelectEventRecord).changeEventObserved = true; };
      global[key] = { inputEventObserved: false, changeEventObserved: false, inputListener, changeListener } satisfies NativeSelectEventRecord;
      control.addEventListener('input', inputListener);
      control.addEventListener('change', changeListener);
    }, token);
    phases.enter('prepare');
    const indexes = desiredSelected
      ? before.multiple
        ? [...new Set([...before.selectedIndexes, before.targetIndex])]
        : [before.targetIndex]
      : before.selectedIndexes.filter((index) => index !== before.targetIndex);
    phases.beginDispatch();
    let dispatchError: unknown = null;
    try {
      await inspection.controlHandle.selectOption(
        indexes.map((index) => ({ index })),
        { timeout: Math.max(1, remainingUntil(deadlineAt)) },
      );
    } catch (error) {
      dispatchError = error;
    }
    const after = await inspection.controlHandle.evaluate((control, args) => {
      const global = window as typeof window & Record<string, unknown>;
      const record = global[args.key] as NativeSelectEventRecord | undefined;
      const select = control instanceof HTMLSelectElement ? control : null;
      const selected = select?.options.item(args.targetIndex)?.selected ?? false;
      if (record !== undefined) {
        control.removeEventListener('input', record.inputListener);
        control.removeEventListener('change', record.changeListener);
        delete global[args.key];
      }
      return {
        inputEventObserved: record?.inputEventObserved ?? false,
        changeEventObserved: record?.changeEventObserved ?? false,
        selected,
      };
    }, { key: token, targetIndex: before.targetIndex });
    const actionDispatched = after.inputEventObserved || after.changeEventObserved || after.selected !== before.selected
      ? true
      : dispatchError === null ? 'unknown' as const : false;
    phases.concludeDispatch({ actionDispatched });
    phases.enter('reconcile');
    if (after.selected !== desiredSelected) {
      throw new Stage5BrowserError('POSTCONDITION_FAILED', `Native option input did not produce the exact ${desiredSelected ? 'selected' : 'unselected'} state.`, {
        recoverable: true,
        details: {
          reason: desiredSelected
            ? 'native_option_selection_not_observed'
            : 'native_option_deselection_not_observed',
          actionDispatched,
          suggestedAction: actionDispatched === false
            ? 'Inspect the control once more before deciding whether another state change is useful.'
            : 'Inspect authoritative form state. Possible input occurred; do not replay the option input automatically.',
        },
        cause: dispatchError,
      });
    }
    phases.beginFinalization();
    phases.complete('succeeded');
    return {
      actionDispatched,
      inputEventObserved: after.inputEventObserved,
      changeEventObserved: after.changeEventObserved,
      selectionEffectObserved: true,
      selectedRepresentationObserved: false,
      selectedState: desiredSelected,
      popupClosed: null,
      reconciliation: {
        targetResolution: 'retained_exact',
        attempts: 1,
        durationMs: Math.max(0, Date.now() - startedAt),
        terminalProof: 'selected_state',
      },
    };
  } catch (error) {
    phases.ensureFailed();
    throw error;
  } finally {
    phases.ensureFailed();
    this.actionPhases.finish(phases);
  }
}
