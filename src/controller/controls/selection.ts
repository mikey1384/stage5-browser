import { randomUUID } from 'node:crypto';

import { type BrowserCommandInput, type BrowserCommandOutput, type ControlOptionObservation, type ControlSelectionEvidence, type Frame, type Page, type SanitizedNativeWindowActivationEvidence, Stage5BrowserError } from '../dependencies.js';
import { type ObservedControlInspection, type ObservedControlOption, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

interface NativeSelectEventRecord {
  inputEventObserved: boolean;
  changeEventObserved: boolean;
  inputListener: EventListener;
  changeListener: EventListener;
}

export function controlOptionMatches(
  candidate: ControlOptionObservation,
  requested: NonNullable<BrowserCommandInput<'selectOption'>['option']>,
): boolean {
  return requested.exact
    ? candidate.name === requested.name
    : candidate.name.toLocaleLowerCase().includes(requested.name.toLocaleLowerCase());
}

export const controlSelectionOperations = {
  async selectOption(
    input: BrowserCommandInput<'selectOption'>,
  ): Promise<BrowserCommandOutput<'selectOption'>> {
    const page = await this.ensureActivePage(this.requireContext());
    const frame = this.resolveFrame(page, input.frameId);
    const deadlineAt = Date.now() + input.timeoutMs;
    let inspectionId = input.inspectionId;
    let optionId = input.optionId;

    if (inspectionId === null) {
      if (input.control === null || input.option === null) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'A direct option selection requires one exact control and option target.', {
          details: { reason: 'invalid_selection_target', actionDispatched: false },
        });
      }
      const observed = await this.inspectControl({
        control: input.control,
        frameId: input.frameId,
        revealOptions: true,
        maxOptions: 200,
        timeoutMs: Math.max(1_000, remainingUntil(deadlineAt)),
      });
      inspectionId = observed.inspection.inspectionId;
      const requestedOption = input.option;
      const matches = observed.inspection.options.filter((candidate) =>
        controlOptionMatches(candidate, requestedOption));
      if (matches.length !== 1) {
        const retained = this.consumeControlInspection(frame, inspectionId);
        await this.disposeControlInspection(retained);
        throw new Stage5BrowserError(
          matches.length > 1 ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND',
          matches.length > 1
            ? 'Multiple options matched the requested meaning inside the exact control.'
            : 'The requested option was not found inside the exact inspected control.',
          {
            recoverable: true,
            details: {
              reason: 'decision_required',
              responsible: 'agent',
              actionDispatched: false,
              optionCount: observed.inspection.options.length,
              optionsComplete: observed.inspection.optionsComplete,
              choices: observed.inspection.options.slice(0, 50).map(({ optionId: id, name, role }) => ({ optionId: id, name, role })),
              suggestedAction: 'Use agent judgment within the existing user-authorized scope, then select one exact observed optionId. Escalate only if the meanings materially change the user outcome.',
            },
          },
        );
      }
      optionId = matches[0]?.optionId ?? null;
    }

    if (inspectionId === null || optionId === null) {
      throw new Stage5BrowserError('OPERATION_FAILED', 'An inspected selection requires both inspectionId and optionId.', {
        details: { reason: 'invalid_selection_capability', actionDispatched: false },
      });
    }

    const inspection = this.consumeControlInspection(frame, inspectionId);
    try {
      const option = inspection.options.get(optionId);
      if (option === undefined) {
        throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The option capability was not present in the exact control inspection.', {
          recoverable: true,
          details: {
            reason: 'option_not_observed',
            actionDispatched: false,
            suggestedAction: 'Inspect the intended control once more and use only an exact returned optionId.',
          },
        });
      }
      if (option.observation.disabled) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The exact observed option is disabled.', {
          recoverable: true,
          details: {
            reason: 'option_not_enabled',
            actionDispatched: false,
            suggestedAction: 'Inspect the current form state and satisfy any prerequisite before selecting this option.',
          },
        });
      }
      const evidence = inspection.kind === 'native_select'
        ? await this.selectNativeControlOption(inspection, option, deadlineAt)
        : await this.selectCustomControlOption(page, frame, inspection, option, input.frameId, deadlineAt);
      return {
        page: await this.pageSummary(page, undefined, remainingUntil(deadlineAt)),
        frame: this.frameSummary(frame, page),
        inspectionId,
        optionId,
        selectedName: option.observation.name,
        kind: inspection.kind,
        evidence,
      };
    } finally {
      await this.disposeControlInspection(inspection);
    }
  },

  async selectNativeControlOption(
    inspection: ObservedControlInspection,
    option: ObservedControlOption,
    deadlineAt: number,
  ): Promise<ControlSelectionEvidence> {
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
      if (before.selected) {
        phases.enter('preflight');
        phases.enter('prepare');
        phases.beginFinalization();
        phases.complete('succeeded');
        return {
          actionDispatched: false,
          inputEventObserved: false,
          changeEventObserved: false,
          selectionEffectObserved: true,
          selectedState: true,
          popupClosed: null,
        };
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
      const indexes = before.multiple
        ? [...new Set([...before.selectedIndexes, before.targetIndex])]
        : [before.targetIndex];
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
      const actionDispatched = after.inputEventObserved || after.changeEventObserved || after.selected
        ? true
        : dispatchError === null ? 'unknown' as const : false;
      phases.concludeDispatch({ actionDispatched });
      phases.enter('reconcile');
      if (!after.selected) {
        throw new Stage5BrowserError('POSTCONDITION_FAILED', 'Native option input did not produce the exact selected state.', {
          recoverable: true,
          details: {
            reason: 'native_option_selection_not_observed',
            actionDispatched,
            suggestedAction: actionDispatched === false
              ? 'Inspect the control once more before deciding whether another selection is useful.'
              : 'Inspect authoritative form state. Possible input occurred; do not replay the selection automatically.',
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
        selectedState: true,
        popupClosed: null,
      };
    } catch (error) {
      phases.ensureFailed();
      throw error;
    } finally {
      phases.ensureFailed();
      this.actionPhases.finish(phases);
    }
  },

  async selectCustomControlOption(
    page: Page,
    frame: Frame,
    inspection: ObservedControlInspection,
    option: ObservedControlOption,
    frameId: string | null,
    deadlineAt: number,
    requireSelected = false,
  ): Promise<ControlSelectionEvidence> {
    if (option.observation.selected === true) {
      return {
        actionDispatched: false,
        inputEventObserved: false,
        changeEventObserved: false,
        selectionEffectObserved: true,
        selectedState: true,
        popupClosed: null,
      };
    }
    if (inspection.popupHandle === null) {
      throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The inspected popup capability is no longer available.', {
        recoverable: true,
        details: { reason: 'control_popup_capability_missing', actionDispatched: false },
      });
    }
    const popupHandle = inspection.popupHandle;
    const hiddenExpectation = requireSelected ? null : {
      role: option.observation.role,
      name: option.observation.name,
      exact: true,
      frameId,
    };
    const result = await this.executeClickAction({
      action: 'select_option',
      timeoutMs: Math.max(1, remainingUntil(deadlineAt)),
      observe: async () => ({ page, frame }),
      plan: () => ({
        action: 'select_option',
        page,
        frame,
        postcondition: {
          expectedUrl: null,
          expectedSelected: true,
          expectedVisible: null,
          expectedHidden: hiddenExpectation,
          satisfaction: 'any',
          timeoutMs: Math.max(100, Math.min(3_000, remainingUntil(deadlineAt))),
        },
        prepare: async (
          priorNativeActivation: SanitizedNativeWindowActivationEvidence | null,
          activationAttemptCount: number,
          actionStartedAt: string,
          actionDeadlineAt: number,
        ) => {
          const pageActivation = await this.primeSelectedPageForTargetPreparation(
            page,
            actionDeadlineAt,
            actionStartedAt,
            'select_option',
            activationAttemptCount,
            priorNativeActivation ?? undefined,
          );
          let locator = option.locator;
          let handle = option.handle;
          const inside = await handle.evaluate((target, root) =>
            target.isConnected && root.isConnected && root.contains(target), popupHandle).catch(() => false);
          if (!inside) {
            const resolved = await this.resolveUniqueSemanticReferenceInScope(
              frame,
              popupHandle,
              { role: option.observation.role, name: option.observation.name, url: null },
              actionDeadlineAt,
            );
            if (resolved.kind !== 'resolved') {
              return this.failClickBeforeDispatch(
                page,
                actionStartedAt,
                null,
                resolved.kind === 'ambiguous' ? 'ambiguous_target' : 'target_missing',
                `control_option_${resolved.kind}`,
                'The exact observed option could not be uniquely rebound inside its inspected popup.',
                'Inspect the control once more. Stage5 Browser confirmed that no selection input was dispatched.',
                resolved.kind === 'ambiguous' ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND',
                'select_option',
              );
            }
            locator = resolved.locator;
            handle = resolved.handle as typeof handle;
          }
          return this.prepareObservedClickTarget(
            page,
            frame,
            locator,
            actionStartedAt,
            actionDeadlineAt,
            {
              expectedUrl: null,
              expectedSelected: true,
              expectedVisible: null,
              expectedHidden: hiddenExpectation,
              satisfaction: 'any',
              timeoutMs: Math.max(100, Math.min(3_000, remainingUntil(deadlineAt))),
            },
            pageActivation,
            handle,
          );
        },
        reconciliationLocator: (prepared) => prepared.locator,
        discardCapabilities: () => undefined,
      }),
      preflight: async () => {
        const connected = await popupHandle.evaluate((popup) => popup.isConnected).catch(() => false);
        if (!connected || inspection.documentVersion !== this.documentVersion(frame)) {
          throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The inspected popup document changed before selection.', {
            recoverable: true,
            details: { reason: 'control_popup_changed', actionDispatched: false },
          });
        }
      },
    });
    const selectedCheck = result.postcondition?.checks.find((check) => check.kind === 'selected');
    const hiddenCheck = result.postcondition?.checks.find((check) => check.kind === 'visible' && check.expected === false);
    return {
      actionDispatched: result.dispatch.actionDispatched,
      inputEventObserved: false,
      changeEventObserved: false,
      selectionEffectObserved: true,
      selectedState: typeof selectedCheck?.observed === 'boolean' ? selectedCheck.observed : null,
      popupClosed: hiddenCheck?.passed ?? null,
    };
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type ControlSelectionOperations = typeof controlSelectionOperations;
