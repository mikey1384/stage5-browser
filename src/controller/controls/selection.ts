import { randomUUID } from 'node:crypto';

import { type BrowserCommandInput, type BrowserCommandOutput, type ControlOptionObservation, type ControlSelectionEvidence, type Frame, type Page, type SanitizedNativeWindowActivationEvidence, Stage5BrowserError } from '../dependencies.js';
import { type ObservedControlInspection, type ObservedControlOption, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import type { ClickActivationPolicy } from '../action/click-plan.js';
import { elementWithinPopupSurfaces, inspectPopupSurfaceSetRendering, resolveUniqueSemanticReferenceInPopupSurfaces } from './popup-set.js';
import { observeCustomControlSelectionBaseline, type CustomControlSelectionBaseline } from './selection-baseline.js';
import { reconcileCustomControlSelection } from './selection-evidence.js';
import { completedSelectionSummary } from './selection-summary.js';

interface NativeSelectEventRecord {
  inputEventObserved: boolean;
  changeEventObserved: boolean;
  inputListener: EventListener;
  changeListener: EventListener;
}

function representedOptionStillObserved(
  baseline: CustomControlSelectionBaseline,
  option: ObservedControlOption,
): boolean {
  return baseline.representation.controlRepresentsOption ||
    (option.selectedRepresentationObserved === true &&
      baseline.representation.localExactRepresentationCount > 0);
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
    const desiredSelected = input.selected ?? true;
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
      if (option.selectionStateConflict === true) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The exact option exposes conflicting current selection state.', {
          recoverable: true,
          details: {
            reason: 'control_option_state_conflict',
            actionDispatched: false,
            suggestedAction: 'Inspect authoritative current form state. Stage5 Browser dispatched no option input and will not guess between conflicting state channels.',
          },
        });
      }
      if (!desiredSelected && option.observation.selected === null) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The exact option current state is unknown, so toggling it could select instead of deselect.', {
          recoverable: true,
          details: {
            reason: 'control_option_current_state_unknown',
            actionDispatched: false,
            suggestedAction: 'Inspect fresh authoritative control state. Deselect only an option reported selected=true; Stage5 Browser will not guess at a toggle state.',
          },
        });
      }
      const evidence = inspection.kind === 'native_select'
        ? await this.selectNativeControlOption(inspection, option, deadlineAt, desiredSelected)
        : await this.selectCustomControlOption(page, frame, inspection, option, input.frameId, deadlineAt, false, desiredSelected);
      return {
        ...completedSelectionSummary([evidence], inspection.multiple, desiredSelected),
        page: await this.pageSummary(page, undefined, remainingUntil(deadlineAt)),
        frame: this.frameSummary(frame, page),
        inspectionId,
        optionId,
        selectedName: option.observation.name,
        selected: desiredSelected,
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
    desiredSelected = true,
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
    desiredSelected = true,
  ): Promise<ControlSelectionEvidence> {
    if (!desiredSelected && !inspection.multiple && option.observation.selected === true) {
      throw new Stage5BrowserError('OPERATION_FAILED', 'The selected custom option is not proven to support independent deselection.', {
        recoverable: true,
        details: {
          reason: 'control_not_multiselect',
          actionDispatched: false,
          suggestedAction: 'Choose the intended replacement option, or inspect a control that exposes multi-select semantics.',
        },
      });
    }
    if (inspection.popupSurfaces.length === 0) {
      throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The inspected popup capability is no longer available.', {
        recoverable: true,
        details: { reason: 'control_popup_capability_missing', actionDispatched: false },
      });
    }
    let observedBaseline: CustomControlSelectionBaseline | null = null;
    const result = await this.executeClickAction({
      action: 'select_option',
      timeoutMs: Math.max(1, remainingUntil(deadlineAt)),
      observe: async () => {
        observedBaseline = await observeCustomControlSelectionBaseline({
          associatePopup: (controlHandle, associationDeadlineAt) =>
            this.associatedControlPopup(frame, controlHandle, associationDeadlineAt, {
              agentDeclaredOwner: inspection.agentDeclaredPopupOwner,
              requireRendered: true,
            }),
          deadlineAt,
          frame,
          inspection,
          optionName: option.observation.name,
        });
        return observedBaseline;
      },
      plan: (baseline) => {
        const represented = representedOptionStillObserved(baseline, option);
        const selectedState = option.selectedRepresentationObserved === true
          ? null
          : option.observation.selected;
        const alreadySatisfied = selectedState === desiredSelected ||
          (option.selectedRepresentationObserved === true && represented === desiredSelected);
        return {
          action: 'select_option',
          activationPolicy: 'pointer_only',
          page,
          frame,
          postcondition: null,
          ...(baseline.capabilityRebound
            ? { preDispatchRecoveryReason: 'target_changed_before_input' as const }
            : {}),
          ...(alreadySatisfied
            ? { satisfiedWithoutDispatch: {
                postcondition: {
                  passed: true,
                  checks: [
                    {
                      kind: 'selection_representation' as const,
                      passed: represented === desiredSelected,
                      expected: desiredSelected,
                      observed: represented,
                    },
                    {
                      kind: 'selected' as const,
                      passed: selectedState === desiredSelected,
                      expected: desiredSelected,
                      observed: selectedState,
                    },
                    { kind: 'popup_closed' as const, passed: false, expected: true, observed: null },
                  ],
                },
              } }
            : {}),
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
              'select_option',
              activationAttemptCount,
              priorNativeActivation ?? undefined,
            );
            let locator = option.locator;
            let handle = option.handle;
            const inside = await elementWithinPopupSurfaces(
              handle,
              baseline.popupSurfaces,
              actionDeadlineAt,
            );
            if (!inside) {
              const resolved = await resolveUniqueSemanticReferenceInPopupSurfaces(
                frame,
                baseline.popupSurfaces,
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
              null,
              pageActivation,
              handle,
              activationPolicy,
            );
          },
          reconciliationLocator: (prepared) => prepared.locator,
          reconcile: async (prepared, remainingTimeoutMs) => {
            const reconciliation = await reconcileCustomControlSelection({
              before: baseline.representation,
              control: baseline.controlHandle,
              deadlineAt: Date.now() + Math.max(1, remainingTimeoutMs),
              option: prepared.locator,
              optionName: option.observation.name,
              owner: baseline.representationScope,
              page,
              popupSurfaces: baseline.popupSurfaces,
              desiredSelected,
              requireSelected: requireSelected || inspection.multiple,
              selectedState: (locator) => this.controlOptionSelectedState(locator),
            });
            return reconciliation.postcondition;
          },
          discardCapabilities: () => undefined,
        };
      },
      preflight: async () => {
        const baseline = observedBaseline;
        const rendering = baseline === null
          ? null
          : await inspectPopupSurfaceSetRendering(baseline.popupSurfaces, deadlineAt);
        const controlConnected = baseline === null
          ? false
          : await baseline.controlHandle.evaluate((control) => control.isConnected).catch(() => false);
        const connected = rendering?.allRendered === true && controlConnected;
        if (!connected || inspection.documentVersion !== this.documentVersion(frame)) {
          throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The inspected popup document changed before selection.', {
            recoverable: true,
            details: { reason: 'control_popup_changed', actionDispatched: false },
          });
        }
      },
    });
    const selectedCheck = result.postcondition?.checks.find((check) => check.kind === 'selected');
    const representationCheck = result.postcondition?.checks.find((check) => check.kind === 'selection_representation');
    const popupCheck = result.postcondition?.checks.find((check) => check.kind === 'popup_closed');
    return {
      actionDispatched: result.dispatch.actionDispatched,
      inputEventObserved: false,
      changeEventObserved: false,
      selectionEffectObserved: true,
      selectedRepresentationObserved: representationCheck?.observed === true,
      selectedState: typeof selectedCheck?.observed === 'boolean' ? selectedCheck.observed : null,
      popupClosed: typeof popupCheck?.observed === 'boolean'
        ? popupCheck.observed
        : null,
    };
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type ControlSelectionOperations = typeof controlSelectionOperations;
