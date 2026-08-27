import {
  type ControlSelectionReconciliationEvidence,
  type ElementHandle,
  type Locator,
  type Page,
  type PostconditionResult,
  Stage5BrowserError,
} from '../dependencies.js';
import {
  boundedValue,
  type ObservedControlPopupSurface,
  remainingUntil,
} from '../model.js';
import { inspectPopupSurfaceSetRendering } from './popup-set.js';
import {
  controlSelectionRepresentationSelected,
  observeControlSelectionRepresentation,
  type ControlSelectionRepresentation,
} from './selection-representation.js';

export interface ControlSelectionReconciliation {
  postcondition: PostconditionResult;
  popupClosed: boolean;
  selectedRepresentationObserved: boolean;
  selectedState: boolean | null;
  reconciliation: ControlSelectionReconciliationEvidence;
}

export interface RecoveredControlSelectionTarget {
  control: ElementHandle<HTMLElement>;
  option: Locator;
  owner: ElementHandle<HTMLElement>;
  popupSurfaces: readonly ObservedControlPopupSurface[];
  dispose: () => Promise<void>;
}

export async function reconcileCustomControlSelection(input: {
  before: ControlSelectionRepresentation;
  control: ElementHandle<HTMLElement>;
  deadlineAt: number;
  option: Locator;
  optionName: string;
  owner: ElementHandle<HTMLElement>;
  page: Page;
  popupSurfaces: readonly ObservedControlPopupSurface[];
  desiredSelected: boolean;
  requireSelected: boolean;
  recover?: (
    deadlineAt: number,
  ) => Promise<RecoveredControlSelectionTarget | null>;
  selectedState: (locator: Locator) => Promise<boolean | null>;
}): Promise<ControlSelectionReconciliation> {
  const startedAt = Date.now();
  const deadlineAt = Math.min(input.deadlineAt, startedAt + 1_500);
  let attempts = 0;
  let selectedState: boolean | null = null;
  let popupClosed = false;
  let selectedRepresentationObserved = false;
  let targetResolution: ControlSelectionReconciliationEvidence['targetResolution'] =
    'retained_exact';
  let recoveryAttempted = false;
  let recovered: RecoveredControlSelectionTarget | null = null;
  let control = input.control;
  let option = input.option;
  let owner = input.owner;
  let popupSurfaces = input.popupSurfaces;
  const beforeRepresentationSelected = controlSelectionRepresentationSelected(
    input.before,
  );
  try {
    while (true) {
      attempts += 1;
      selectedState = await boundedValue(
        input.selectedState(option),
        Math.max(1, remainingUntil(deadlineAt)),
        null,
      );
      const rendering = await inspectPopupSurfaceSetRendering(
        popupSurfaces,
        deadlineAt,
      );
      if (rendering !== null) popupClosed = !rendering.anyRendered;
      const represented = await observeControlSelectionRepresentation(
        control,
        owner,
        popupSurfaces,
        input.optionName,
        deadlineAt,
      );
      if (
        represented?.controlConnected === false &&
        targetResolution === 'retained_exact'
      ) {
        targetResolution = 'retained_scope_after_control_replacement';
      }
      selectedRepresentationObserved =
        represented !== null &&
        controlSelectionRepresentationSelected(represented);
      const representationMatched =
        represented !== null &&
        beforeRepresentationSelected !== input.desiredSelected &&
        selectedRepresentationObserved === input.desiredSelected;
      const popupClosureMatched =
        input.desiredSelected &&
        !input.requireSelected &&
        popupClosed &&
        represented?.controlConnected === true;
      const satisfied =
        selectedState === input.desiredSelected ||
        representationMatched ||
        popupClosureMatched;
      const checks = [
        {
          kind: 'selection_representation' as const,
          passed: representationMatched,
          expected: input.desiredSelected,
          observed: selectedRepresentationObserved,
        },
        {
          kind: 'selected' as const,
          passed: selectedState === input.desiredSelected,
          expected: input.desiredSelected,
          observed: selectedState,
        },
        {
          kind: 'popup_closed' as const,
          passed: popupClosed,
          expected: true,
          observed: popupClosed,
        },
      ];
      if (satisfied) {
        const terminalProof: ControlSelectionReconciliationEvidence['terminalProof'] =
          selectedState === input.desiredSelected
            ? 'selected_state'
            : representationMatched
              ? 'representation_change'
              : 'popup_closed';
        return {
          postcondition: { passed: true, checks },
          popupClosed,
          selectedRepresentationObserved,
          selectedState,
          reconciliation: {
            targetResolution,
            attempts,
            durationMs: Math.max(0, Date.now() - startedAt),
            terminalProof,
          },
        };
      }
      if (
        !recoveryAttempted &&
        input.recover !== undefined &&
        (represented === null || represented.controlConnected === false)
      ) {
        recoveryAttempted = true;
        recovered = await input.recover(deadlineAt);
        if (recovered !== null) {
          control = recovered.control;
          option = recovered.option;
          owner = recovered.owner;
          popupSurfaces = recovered.popupSurfaces;
          popupClosed = false;
          targetResolution = 'rebound_exact';
          continue;
        }
        targetResolution = 'unresolved';
      }
      if (remainingUntil(deadlineAt) <= 0) {
        const reconciliation = {
          targetResolution,
          attempts,
          durationMs: Math.max(0, Date.now() - startedAt),
          terminalProof: 'unresolved' as const,
        } satisfies ControlSelectionReconciliationEvidence;
        throw new Stage5BrowserError(
          'POSTCONDITION_FAILED',
          `The option received click input, but the requested ${input.desiredSelected ? 'selected' : 'unselected'} state was not observed.`,
          {
            recoverable: true,
            details: {
              reason: input.desiredSelected
                ? 'control_option_selection_not_observed'
                : 'control_option_deselection_not_observed',
              actionDispatched: true,
              clickDispatched: true,
              actionOutcome: 'click_dispatched_postcondition_failed',
              checks,
              reconciliation,
              suggestedAction:
                'Inspect authoritative form state. Do not replay the option input unless one fresh observation proves the requested state remains unsatisfied and a new action is safe.',
            },
          },
        );
      }
      await input.page.waitForTimeout(Math.min(50, remainingUntil(deadlineAt)));
    }
  } finally {
    await recovered?.dispose().catch(() => undefined);
  }
}
