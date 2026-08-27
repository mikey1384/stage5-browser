import { type ElementHandle, type Frame, type Locator, Stage5BrowserError, type SupportedAriaRole } from '../dependencies.js';
import { boundedValue, type ObservedControlInspection, type ObservedControlPopupSurface, remainingUntil } from '../model.js';
import type { ControlPopupAssociation } from './popup-association.js';
import { disposePopupSurfaces, inspectPopupSurfaceSetRendering } from './popup-set.js';
import { resolveUniqueControl } from './resolution.js';
import { observeControlSelectionRepresentationsInAdaptiveScope, type ControlSelectionRepresentation } from './selection-evidence.js';

const RETAINED_CONTROL_PROBE_MS = 500;
const SELECTION_BASELINE_OBSERVATION_MS = 2_000;
const POPUP_REBIND_POLL_MS = 50;

export interface CustomControlSelectionBaseline {
  capabilityRebound: boolean;
  controlHandle: ElementHandle<HTMLElement>;
  popupSurfaces: ObservedControlPopupSurface[];
  representationScope: ElementHandle<HTMLElement>;
  representation: ControlSelectionRepresentation;
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
  let popupSurfaces = inspection.popupSurfaces;
  let controlRebound = false;
  let popupRebound = false;
  let freshControl: ElementHandle<HTMLElement> | null = null;
  let freshPopupSurfaces: ObservedControlPopupSurface[] = [];
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
      controlRebound = true;
    }

    const popupRendering = controlRebound
      ? { anyRendered: false, allRendered: false }
      : await inspectPopupSurfaceSetRendering(popupSurfaces, observationDeadlineAt);
    if (popupRendering === null) throwBaselineUnavailable();
    if (inspection.agentDeclaredPopupOwner !== null || !popupRendering.allRendered) {
      const associated = await waitForRenderedReplacementPopup(
        input,
        controlHandle,
        observationDeadlineAt,
      );
      popupSurfaces = associated.surfaces;
      freshPopupSurfaces = associated.surfaces;
      popupRebound = true;
    }
    if (popupSurfaces.length === 0) throwPopupChanged();

    let representationScope = inspection.representationScopeHandle;
    if (representationScope !== undefined && !controlRebound) {
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
    const representationObservation = await observeControlSelectionRepresentationsInAdaptiveScope(
      controlHandle,
      popupSurfaces,
      [input.optionName],
      observationDeadlineAt,
      representationScope,
    );
    if (representationObservation === null) throwScopeUnavailable();
    if (representationObservation.scope !== representationScope) {
      freshScope = representationObservation.scope;
      representationScope = representationObservation.scope;
    }
    const representation = representationObservation.representations?.get(input.optionName);
    if (representation === undefined) throwBaselineUnavailable();

    if (controlRebound) {
      await Promise.allSettled([
        inspection.controlHandle.dispose(),
        disposePopupSurfaces(inspection.popupSurfaces),
        inspection.representationScopeHandle?.dispose() ?? Promise.resolve(),
      ]);
      inspection.controlLocator = controlLocator;
      inspection.controlHandle = controlHandle;
      inspection.popupSurfaces = popupSurfaces;
      inspection.representationScopeHandle = representationScope;
      freshControl = null;
      freshPopupSurfaces = [];
      freshScope = null;
    } else {
      if (popupRebound) {
        await disposePopupSurfaces(inspection.popupSurfaces);
        inspection.popupSurfaces = popupSurfaces;
        freshPopupSurfaces = [];
      }
      if (inspection.representationScopeHandle !== representationScope) {
        await inspection.representationScopeHandle?.dispose().catch(() => undefined);
        inspection.representationScopeHandle = representationScope;
        freshScope = null;
      }
    }

    return {
      capabilityRebound: controlRebound || popupRebound,
      controlHandle,
      popupSurfaces,
      representationScope,
      representation,
    };
  } finally {
    await Promise.allSettled([
      freshControl?.dispose() ?? Promise.resolve(),
      disposePopupSurfaces(freshPopupSurfaces),
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

async function waitForRenderedReplacementPopup(
  input: BaselineInput,
  controlHandle: ElementHandle<HTMLElement>,
  deadlineAt: number,
): Promise<Extract<ControlPopupAssociation, { kind: 'resolved' }>> {
  let lastAssociation: ControlPopupAssociation | null = null;
  for (;;) {
    const associated = await input.associatePopup(controlHandle, deadlineAt);
    lastAssociation = associated;
    if (associated.kind === 'resolved') {
      const rendering = await inspectPopupSurfaceSetRendering(associated.surfaces, deadlineAt);
      if (rendering?.allRendered === true) return associated;
      await disposePopupSurfaces(associated.surfaces);
    }
    if (remainingUntil(deadlineAt) <= 0) break;
    await new Promise((resolve) => setTimeout(
      resolve,
      Math.min(POPUP_REBIND_POLL_MS, remainingUntil(deadlineAt)),
    ));
  }
  throwPopupChanged(lastAssociation);
}

function throwPopupChanged(association: ControlPopupAssociation | null = null): never {
  const kind = association?.kind ?? null;
  throw new Stage5BrowserError(
    kind === 'ambiguous' ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND',
    'The inspected popup capability changed before the selection dispatch gate.',
    {
      recoverable: true,
      details: {
        reason: kind === 'ambiguous' ? 'ambiguous_control_popup_after_rebind' : 'control_popup_changed',
        actionDispatched: false,
        associationProof: association?.kind === 'resolved' ? association.proof : null,
        surfaceProof: association?.kind === 'resolved' ? association.surfaceProof : null,
        renderedPopupCount: association?.renderedSurfaceCount ?? null,
        popupOwnership: association?.popupOwnership ?? null,
        suggestedAction: 'Inspect the control once more. Stage5 Browser confirmed that no selection input was dispatched.',
      },
    },
  );
}
