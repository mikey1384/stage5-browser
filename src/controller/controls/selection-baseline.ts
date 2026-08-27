import { type ElementHandle, type Frame, type Locator, Stage5BrowserError, type SupportedAriaRole } from '../dependencies.js';
import { boundedValue, type ObservedControlInspection, remainingUntil } from '../model.js';
import type { ControlPopupAssociation } from './options.js';
import { popupRenderedState } from './rendering.js';
import { resolveUniqueControl } from './resolution.js';
import { observeControlSelectionRepresentation, type ControlSelectionRepresentation, resolveControlSelectionRepresentationScope } from './selection-evidence.js';

const RETAINED_CONTROL_PROBE_MS = 500;
const SELECTION_BASELINE_OBSERVATION_MS = 2_000;

export interface CustomControlSelectionBaseline {
  controlHandle: ElementHandle<HTMLElement>;
  popupHandle: ElementHandle<HTMLElement>;
  representationScope: ElementHandle<HTMLElement>;
  representation: ControlSelectionRepresentation;
  rebound: boolean;
}

interface BaselineInput {
  associatePopup(
    controlHandle: ElementHandle<HTMLElement>,
    deadlineAt: number,
  ): Promise<ControlPopupAssociation>;
  deadlineAt: number;
  frame: Frame;
  inspection: ObservedControlInspection;
  optionName: string;
}

export async function observeCustomControlSelectionBaseline(
  input: BaselineInput,
): Promise<CustomControlSelectionBaseline> {
  const { inspection } = input;
  const probeDeadlineAt = Date.now() + Math.max(
    1,
    Math.min(RETAINED_CONTROL_PROBE_MS, remainingUntil(input.deadlineAt)),
  );
  const retainedConnected = await boundedValue(
    inspection.controlHandle.evaluate((control) => control.isConnected),
    Math.max(1, remainingUntil(probeDeadlineAt)),
    null,
  );
  if (retainedConnected === null) throwBaselineUnavailable();

  let controlLocator: Locator = inspection.controlLocator;
  let controlHandle = inspection.controlHandle;
  let popupLocator = inspection.popupLocator;
  let popupHandle = inspection.popupHandle;
  let rebound = false;
  let freshControl: ElementHandle<HTMLElement> | null = null;
  let freshPopup: ElementHandle<HTMLElement> | null = null;
  let freshScope: ElementHandle<HTMLElement> | null = null;

  try {
    const observationDeadlineAt = Date.now() + Math.max(
      1,
      Math.min(SELECTION_BASELINE_OBSERVATION_MS, remainingUntil(input.deadlineAt)),
    );
    if (!retainedConnected) {
      const resolved = await resolveUniqueControl({
        role: inspection.controlRole as SupportedAriaRole,
        name: inspection.controlName,
        exact: inspection.controlExact,
      }, input.frame, observationDeadlineAt);
      controlLocator = resolved.locator;
      controlHandle = resolved.handle;
      freshControl = resolved.handle;
      rebound = true;
    }

    const popupState = rebound
      ? false
      : await popupRenderedState(popupHandle, observationDeadlineAt);
    if (popupState === null) throwBaselineUnavailable();
    if (popupState !== true) {
      if (!rebound) throwPopupChanged();
      const associated = await input.associatePopup(controlHandle, observationDeadlineAt);
      if (associated.kind !== 'resolved') throwPopupChanged(associated.kind);
      popupLocator = associated.locator;
      popupHandle = associated.handle;
      freshPopup = associated.handle;
      if (await popupRenderedState(popupHandle, observationDeadlineAt) !== true) throwPopupChanged();
    }
    if (popupHandle === null) throwPopupChanged();

    let representationScope = inspection.representationScopeHandle;
    if (representationScope !== undefined && !rebound) {
      const retainedScope = await boundedValue(
        representationScope.evaluate((scope, control) =>
          scope.isConnected && control.isConnected && (scope === control || scope.contains(control)), controlHandle),
        Math.max(1, remainingUntil(observationDeadlineAt)),
        null,
      );
      if (retainedScope === null) throwBaselineUnavailable();
      if (!retainedScope) representationScope = undefined;
    } else {
      representationScope = undefined;
    }
    if (representationScope === undefined) {
      freshScope = await resolveControlSelectionRepresentationScope(
        controlHandle,
        popupHandle,
        observationDeadlineAt,
      );
      if (freshScope === null) throwScopeUnavailable();
      representationScope = freshScope;
    }

    const representation = await observeControlSelectionRepresentation(
      controlHandle,
      representationScope,
      popupHandle,
      input.optionName,
      observationDeadlineAt,
    );
    if (representation === null) throwBaselineUnavailable();

    if (rebound) {
      await Promise.allSettled([
        inspection.controlHandle.dispose(),
        inspection.popupHandle?.dispose() ?? Promise.resolve(),
        inspection.representationScopeHandle?.dispose() ?? Promise.resolve(),
      ]);
      inspection.controlLocator = controlLocator;
      inspection.controlHandle = controlHandle;
      inspection.popupLocator = popupLocator;
      inspection.popupHandle = popupHandle;
      inspection.representationScopeHandle = representationScope;
      freshControl = null;
      freshPopup = null;
      freshScope = null;
    } else if (inspection.representationScopeHandle !== representationScope) {
      await inspection.representationScopeHandle?.dispose().catch(() => undefined);
      inspection.representationScopeHandle = representationScope;
      freshScope = null;
    }

    return { controlHandle, popupHandle, representationScope, representation, rebound };
  } finally {
    await Promise.allSettled([
      freshControl?.dispose() ?? Promise.resolve(),
      freshPopup?.dispose() ?? Promise.resolve(),
      freshScope?.dispose() ?? Promise.resolve(),
    ]);
  }
}

function throwBaselineUnavailable(): never {
  throw new Stage5BrowserError(
    'OPERATION_FAILED',
    'The exact inspected control could not be observed before the selection dispatch gate.',
    {
      recoverable: true,
      details: {
        reason: 'control_selection_baseline_unavailable',
        actionDispatched: false,
        suggestedAction: 'Inspect the control once more before deciding whether a new selection is safe.',
      },
    },
  );
}

function throwScopeUnavailable(): never {
  throw new Stage5BrowserError(
    'OPERATION_FAILED',
    'The exact inspected field scope could not be retained before the selection dispatch gate.',
    {
      recoverable: true,
      details: {
        reason: 'control_selection_scope_unavailable',
        actionDispatched: false,
        suggestedAction: 'Inspect the control once more before deciding whether a new selection is safe.',
      },
    },
  );
}

function throwPopupChanged(kind: 'ambiguous' | 'missing' | null = null): never {
  throw new Stage5BrowserError(
    kind === 'ambiguous' ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND',
    'The inspected popup capability changed before the selection dispatch gate.',
    {
      recoverable: true,
      details: {
        reason: kind === 'ambiguous' ? 'ambiguous_control_popup_after_rebind' : 'control_popup_changed',
        actionDispatched: false,
        suggestedAction: 'Inspect the control once more. Stage5 Browser confirmed that no selection input was dispatched.',
      },
    },
  );
}
