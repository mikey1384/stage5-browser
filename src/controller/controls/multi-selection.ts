import {
  type BrowserCommandInput,
  type BrowserCommandOutput,
  type ControlMultiSelectionResult,
  type ControlOptionTarget,
  type ControlTarget,
  type Frame,
  type Page,
  Stage5BrowserError,
} from '../dependencies.js';
import { type ObservedControlInspection, type ObservedControlOption, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import { controlOptionMatches } from './selection.js';

interface RequestedSelection {
  requestedOptionId: string;
  target: ControlOptionTarget;
  observed: ObservedControlOption;
}

export const controlMultiSelectionOperations = {
  async selectOptions(
    input: BrowserCommandInput<'selectOptions'>,
  ): Promise<BrowserCommandOutput<'selectOptions'>> {
    const page = await this.ensureActivePage(this.requireContext());
    const frame = this.resolveFrame(page, input.frameId);
    const deadlineAt = Date.now() + input.timeoutMs;
    const inspectionOutput = input.inspectionId === null
      ? await this.inspectControl({
        control: requiredControl(input),
        frameId: input.frameId,
        revealOptions: true,
        maxOptions: 200,
        timeoutMs: Math.max(1_000, remainingUntil(deadlineAt)),
      })
      : null;
    const inspectionId = input.inspectionId ?? inspectionOutput?.inspection.inspectionId;
    if (inspectionId === undefined) throw invalidMultiSelectionTarget();
    const inspection = this.consumeControlInspection(frame, inspectionId);
    const requested = resolveRequestedSelections(inspection, input);

    try {
      if (requested.length > 1 && !inspection.multiple) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The exact inspected control does not support multiple selections.', {
          recoverable: true,
          details: {
            reason: 'control_not_multiselect',
            actionDispatched: false,
            suggestedAction: 'Choose one option for this single-select control, or inspect the exact intended multi-select control.',
          },
        });
      }
      const disabled = requested.find(({ observed }) => observed.observation.disabled);
      if (disabled !== undefined) {
        throw new Stage5BrowserError('OPERATION_FAILED', 'One requested option is disabled.', {
          recoverable: true,
          details: { reason: 'option_not_enabled', actionDispatched: false, optionId: disabled.requestedOptionId },
        });
      }

      const selections = inspection.kind === 'native_select'
        ? await this.selectNativeRequestedOptions(inspection, requested, deadlineAt)
        : await this.selectCustomRequestedOptions(page, frame, inspection, requested, input.frameId, deadlineAt);
      return {
        page: await this.pageSummary(page, undefined, remainingUntil(deadlineAt)),
        frame: this.frameSummary(frame, page),
        inspectionId,
        kind: inspection.kind,
        selectedNames: selections.map(({ selectedName }) => selectedName),
        selections,
      };
    } finally {
      await this.disposeControlInspection(inspection);
    }
  },

  async selectNativeRequestedOptions(
    inspection: ObservedControlInspection,
    requested: RequestedSelection[],
    deadlineAt: number,
  ): Promise<ControlMultiSelectionResult[]> {
    const selections: ControlMultiSelectionResult[] = [];
    for (const selection of requested) {
      try {
        const evidence = await this.selectNativeControlOption(inspection, selection.observed, deadlineAt);
        selections.push({
          optionId: selection.requestedOptionId,
          selectedName: selection.observed.observation.name,
          evidence,
        });
      } catch (error) {
        throw multiSelectionFailure(error, selections);
      }
    }
    return selections;
  },

  async selectCustomRequestedOptions(
    page: Page,
    frame: Frame,
    inspection: ObservedControlInspection,
    requested: RequestedSelection[],
    frameId: string | null,
    deadlineAt: number,
  ): Promise<ControlMultiSelectionResult[]> {
    const selections: ControlMultiSelectionResult[] = [];
    const control: ControlTarget = {
      role: inspection.controlRole as ControlTarget['role'],
      name: inspection.controlName,
      exact: inspection.controlExact,
    };
    for (const [index, selection] of requested.entries()) {
      let currentInspection = inspection;
      let currentOption = selection.observed;
      let ownedFreshInspection = false;
      try {
        if (index > 0) {
          const fresh = await this.inspectControl({
            control,
            frameId,
            revealOptions: true,
            maxOptions: 200,
            timeoutMs: Math.max(1_000, remainingUntil(deadlineAt)),
          });
          currentInspection = this.consumeControlInspection(frame, fresh.inspection.inspectionId);
          ownedFreshInspection = true;
          currentOption = uniqueObservedOption(currentInspection, selection.target);
        }
        const evidence = await this.selectCustomControlOption(
          page,
          frame,
          currentInspection,
          currentOption,
          frameId,
          deadlineAt,
          true,
        );
        selections.push({
          optionId: selection.requestedOptionId,
          selectedName: currentOption.observation.name,
          evidence,
        });
      } catch (error) {
        throw multiSelectionFailure(error, selections);
      } finally {
        if (ownedFreshInspection) await this.disposeControlInspection(currentInspection);
      }
    }
    return selections;
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

function requiredControl(input: BrowserCommandInput<'selectOptions'>) {
  if (input.control === null || input.options === null) throw invalidMultiSelectionTarget();
  return input.control;
}

function resolveRequestedSelections(
  inspection: ObservedControlInspection,
  input: BrowserCommandInput<'selectOptions'>,
): RequestedSelection[] {
  if (input.inspectionId !== null && input.optionIds !== null) {
    if (new Set(input.optionIds).size !== input.optionIds.length) throw duplicateMultiSelectionTarget();
    return input.optionIds.map((requestedOptionId) => {
      const observed = inspection.options.get(requestedOptionId);
      if (observed === undefined) throw missingMultiSelectionOption(requestedOptionId);
      return {
        requestedOptionId,
        target: { name: observed.observation.name, exact: true },
        observed,
      };
    });
  }
  if (input.control === null || input.options === null) throw invalidMultiSelectionTarget();
  const semanticKeys = input.options.map(({ name, exact }) => `${exact ? 'exact' : 'contains'}\u0000${name}`);
  if (new Set(semanticKeys).size !== semanticKeys.length) throw duplicateMultiSelectionTarget();
  return input.options.map((target) => {
    const observed = uniqueObservedOption(inspection, target);
    return { requestedOptionId: observed.observation.optionId, target, observed };
  });
}

function uniqueObservedOption(
  inspection: ObservedControlInspection,
  target: ControlOptionTarget,
): ObservedControlOption {
  const matches = [...inspection.options.values()].filter(({ observation }) =>
    controlOptionMatches(observation, target));
  if (matches.length !== 1) {
    throw new Stage5BrowserError(
      matches.length > 1 ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND',
      matches.length > 1
        ? 'Multiple options matched one requested multi-select meaning.'
        : 'One requested option was not found in the exact multi-select control.',
      {
        recoverable: true,
        details: {
          reason: matches.length > 1 ? 'ambiguous_option' : 'option_not_observed',
          actionDispatched: false,
          optionsComplete: inspection.optionsComplete,
          suggestedAction: 'Inspect the exact control again and use unique observed option labels or optionIds. No option input was dispatched for this step.',
        },
      },
    );
  }
  return matches[0]!;
}

function invalidMultiSelectionTarget(): Stage5BrowserError {
  return new Stage5BrowserError('OPERATION_FAILED', 'Multi-selection requires one exact inspected capability or one exact control and option list.', {
    details: { reason: 'invalid_multi_selection_target', actionDispatched: false },
  });
}

function duplicateMultiSelectionTarget(): Stage5BrowserError {
  return new Stage5BrowserError('OPERATION_FAILED', 'Each requested multi-select option must be unique.', {
    details: { reason: 'duplicate_multi_selection_target', actionDispatched: false },
  });
}

function missingMultiSelectionOption(optionId: string): Stage5BrowserError {
  return new Stage5BrowserError('TARGET_NOT_FOUND', 'A requested option capability was not present in the exact inspection.', {
    recoverable: true,
    details: { reason: 'option_not_observed', actionDispatched: false, optionId },
  });
}

function multiSelectionFailure(
  error: unknown,
  completed: ControlMultiSelectionResult[],
): Stage5BrowserError {
  const details = error instanceof Stage5BrowserError ? error.details : undefined;
  return new Stage5BrowserError(
    error instanceof Stage5BrowserError ? error.code : 'OPERATION_FAILED',
    'Multi-selection stopped at the first unconfirmed option outcome.',
    {
      recoverable: true,
      details: {
        ...details,
        completedSelections: completed.map(({ optionId, selectedName, evidence }) => ({ optionId, selectedName, evidence })),
        suggestedAction: 'Inspect authoritative control state. Keep confirmed selections and do not replay the failed option when its input may have occurred.',
      },
      cause: error,
    },
  );
}

export type ControlMultiSelectionOperations = typeof controlMultiSelectionOperations;
