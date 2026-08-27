import { randomUUID } from 'node:crypto';

import { type BrowserCommandInput, type BrowserCommandOutput, type ElementHandle, type Frame, Stage5BrowserError } from '../dependencies.js';
import { type ObservedControlInspection, type ObservedControlPopupSurface, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import type { ControlPopupAssociation } from './options.js';
import { disposePopupSurfaces, inspectPopupSurfaceSetRendering, popupSurfaceSetMultiple } from './popup-set.js';
import { resolveUniqueControl } from './resolution.js';
import { type ControlSelectionRepresentation, observeControlSelectionRepresentationsInAdaptiveScope } from './selection-evidence.js';

export const controlInspectionOperations = {
  async inspectControl(
    input: BrowserCommandInput<'inspectControl'>,
  ): Promise<BrowserCommandOutput<'inspectControl'>> {
    const page = await this.ensureActivePage(this.requireContext());
    const frame = this.resolveFrame(page, input.frameId);
    const deadlineAt = Date.now() + input.timeoutMs;
    const documentVersion = this.documentVersion(frame);
    let { locator: controlLocator, handle: controlHandle } = await resolveUniqueControl(
      input.control,
      frame,
      deadlineAt,
    );
    let popupSurfaces: ObservedControlPopupSurface[] = [];
    let representationScopeHandle: ElementHandle<HTMLElement> | null = null;
    let popupAssociationProof: BrowserCommandOutput<'inspectControl'>['inspection']['reveal']['associationProof'] = null;
    let popupSurfaceProof: BrowserCommandOutput<'inspectControl'>['inspection']['reveal']['surfaceProof'] = null;
    let renderedPopupCount: number | null = null;
    let popupOwnership: BrowserCommandOutput<'inspectControl'>['inspection']['reveal']['popupOwnership'] = null;
    let options: ObservedControlInspection['options'] | null = null;
    let retained = false;
    let openerActionDispatched: boolean | 'unknown' = false;
    let popupOpened = false;
    let competingPopupDismissed = false;
    let preparationActionDispatched: boolean | 'unknown' = false;
    let scrollSteps = 0;
    let boundaryReached = false;
    let optionsComplete = false;

    try {
      let descriptor = await this.inspectControlDescriptor(controlHandle, deadlineAt);
      if (descriptor === null) {
        throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The exact control changed during inspection.', {
          recoverable: true,
          details: { reason: 'control_changed_during_inspection', actionDispatched: false },
        });
      }

      if (descriptor.kind === 'native_select') {
        const native = await this.collectNativeControlOptions(
          controlLocator,
          controlHandle,
          input.maxOptions,
          deadlineAt,
        );
        options = native.options;
        optionsComplete = native.complete;
        boundaryReached = native.complete;
      } else {
        let associated = await this.associatedControlPopup(frame, controlHandle, deadlineAt);
        renderedPopupCount = associated.renderedSurfaceCount;
        popupOwnership = associated.popupOwnership;
        if (associated.kind === 'ambiguous') {
          throw new Stage5BrowserError('AMBIGUOUS_TARGET', 'Multiple popup surfaces could belong to the exact control.', {
            recoverable: true,
            details: {
              reason: 'ambiguous_control_popup',
              actionDispatched: false,
              renderedPopupCount,
              popupOwnership: associated.popupOwnership,
              decision: { kind: 'decision_required', responsible: 'agent' },
              suggestedAction: 'Inspect the current semantic page state and narrow to one exact control or modal before continuing.',
            },
          });
        }
        if (associated.kind === 'resolved') {
          popupSurfaces = associated.surfaces;
          popupAssociationProof = associated.proof;
          popupSurfaceProof = associated.surfaceProof;
        }
        let rendered = (await inspectPopupSurfaceSetRendering(popupSurfaces, deadlineAt))?.anyRendered === true;
        if (!rendered && input.revealOptions) {
          const preparation = await this.dismissCompetingControlPopup(
            page,
            frame,
            controlHandle,
            deadlineAt,
          );
          competingPopupDismissed = preparation.competingPopupDismissed;
          preparationActionDispatched = preparation.preparationActionDispatched;
          if (frame.isDetached() || this.documentVersion(frame) !== documentVersion) {
            throwControlDocumentChanged(
              combinedDispatchEvidence(preparationActionDispatched, openerActionDispatched),
            );
          }

          await disposePopupSurfaces(popupSurfaces);
          popupSurfaces = [];
          await controlHandle.dispose().catch(() => undefined);
          ({ locator: controlLocator, handle: controlHandle } = await resolveUniqueControl(
            input.control,
            frame,
            deadlineAt,
          ));
          descriptor = await this.inspectControlDescriptor(controlHandle, deadlineAt);
          if (preparation.targetPopupAlreadyOpen) {
            associated = await this.associatedControlPopup(
              frame,
              controlHandle,
              deadlineAt,
              { requireRendered: true },
            );
            renderedPopupCount = associated.renderedSurfaceCount;
            popupOwnership = associated.popupOwnership;
            if (associated.kind !== 'resolved') {
              throw new Stage5BrowserError(
                associated.kind === 'ambiguous' ? 'AMBIGUOUS_TARGET' : 'POSTCONDITION_FAILED',
                'The already-open target popup could not be retained as one exact owned surface set.',
                {
                  recoverable: true,
                  details: {
                    reason: associated.kind === 'ambiguous'
                      ? 'ambiguous_control_popup'
                      : 'control_popup_not_observed',
                    actionDispatched: false,
                    renderedPopupCount,
                    popupOwnership,
                  },
                },
              );
            }
            popupSurfaces = associated.surfaces;
            popupAssociationProof = associated.proof;
            popupSurfaceProof = associated.surfaceProof;
            rendered = (await inspectPopupSurfaceSetRendering(popupSurfaces, deadlineAt))?.anyRendered === true;
            popupOpened = rendered;
          } else {
            let revealError: unknown = null;
            try {
              const reveal = await this.revealControlPopup(
                page,
                frame,
                controlLocator,
                controlHandle,
                documentVersion,
                deadlineAt,
              );
              openerActionDispatched = reveal.dispatch.actionDispatched;
            } catch (error) {
              revealError = error;
              if (error instanceof Stage5BrowserError) {
                openerActionDispatched = dispatchEvidenceFromError(error);
              } else {
                openerActionDispatched = 'unknown';
              }
            }

            if (frame.isDetached() || this.documentVersion(frame) !== documentVersion) {
              throwControlDocumentChanged(
                combinedDispatchEvidence(preparationActionDispatched, openerActionDispatched),
              );
            }

            await controlHandle.dispose().catch(() => undefined);
            ({ locator: controlLocator, handle: controlHandle } = await resolveUniqueControl(
              input.control,
              frame,
              deadlineAt,
            ));
            descriptor = await this.inspectControlDescriptor(controlHandle, deadlineAt);
            associated = await this.associatedControlPopup(
              frame,
              controlHandle,
              deadlineAt,
              {
                allowUniqueRenderedAfterDispatch: openerActionDispatched !== false,
                requireRendered: true,
              },
            );
            renderedPopupCount = associated.renderedSurfaceCount;
            popupOwnership = associated.popupOwnership;
            if (associated.kind === 'resolved') {
              popupSurfaces = associated.surfaces;
              popupAssociationProof = associated.proof;
              popupSurfaceProof = associated.surfaceProof;
            }
            rendered = (await inspectPopupSurfaceSetRendering(popupSurfaces, deadlineAt))?.anyRendered === true;
            popupOpened = rendered;
            if (associated.kind === 'ambiguous') {
              throw popupAssociationFailure(associated, openerActionDispatched);
            }
            if (!rendered && revealError !== null) throw revealError;
            if (!rendered || associated.kind !== 'resolved') {
              throw new Stage5BrowserError(
                'POSTCONDITION_FAILED',
                'The control input did not expose an associated rendered popup surface set.',
                {
                  recoverable: true,
                  details: {
                    reason: 'control_popup_not_observed',
                    actionDispatched: openerActionDispatched,
                    renderedPopupCount,
                    popupOwnership: associated.popupOwnership,
                    suggestedAction: 'Inspect authoritative page state. The opener may have received input; do not replay it automatically.',
                  },
                },
              );
            }
          }
        } else {
          popupOpened = rendered;
        }

        if (!(await inspectPopupSurfaceSetRendering(popupSurfaces, deadlineAt))?.anyRendered) {
          options = new Map();
        } else {
          const popupMultiple = await popupSurfaceSetMultiple(popupSurfaces, deadlineAt);
          const custom = await this.collectPopupControlOptions(
            frame,
            popupSurfaces,
            input.maxOptions,
            deadlineAt,
          );
          options = custom.options;
          optionsComplete = custom.complete;
          scrollSteps = custom.scrollSteps;
          boundaryReached = custom.boundaryReached;
          if (descriptor !== null) {
            const optionNames = [...custom.options.values()].map(({ observation }) => observation.name);
            let representations: Map<string, ControlSelectionRepresentation> | null = null;
            const representationObservation = await observeControlSelectionRepresentationsInAdaptiveScope(
              controlHandle,
              popupSurfaces,
              optionNames,
              deadlineAt,
            );
            if (representationObservation !== null) {
              representationScopeHandle = representationObservation.scope;
              representations = representationObservation.representations;
            }
            const currentRepresentedOptionCount = applyRepresentations(
              custom.options,
              representations,
            );
            descriptor = {
              ...descriptor,
              multiple: descriptor.multiple || popupMultiple ||
                custom.multipleSignal || currentRepresentedOptionCount > 1,
            };
          }
        }
      }

      if (
        frame.isDetached() ||
        this.documentVersion(frame) !== documentVersion ||
        descriptor === null
      ) {
        throwControlDocumentChanged(
          combinedDispatchEvidence(preparationActionDispatched, openerActionDispatched),
        );
      }

      const inspectionId = `control-${randomUUID()}`;
      const inspection: ObservedControlInspection = {
        id: inspectionId,
        frame,
        documentVersion,
        kind: descriptor.kind,
        controlRole: input.control.role,
        controlName: input.control.name,
        controlExact: input.control.exact,
        controlLocator,
        controlHandle,
        popupSurfaces,
        ...(representationScopeHandle === null ? {} : { representationScopeHandle }),
        multiple: descriptor.multiple,
        optionsComplete,
        options: options ?? new Map(),
      };
      this.retainControlInspection(inspection);
      retained = true;
      return {
        page: await this.pageSummary(page, undefined, remainingUntil(deadlineAt)),
        frame: this.frameSummary(frame, page),
        inspection: {
          inspectionId,
          kind: descriptor.kind,
          expanded: descriptor.kind === 'native_select' ? null : descriptor.expanded,
          multiple: descriptor.multiple,
          disabled: descriptor.disabled,
          options: [...inspection.options.values()].map(({ observation }) => observation),
          optionsComplete,
          reveal: {
            requested: input.revealOptions,
            openerActionDispatched,
            popupOpened,
            competingPopupDismissed,
            preparationActionDispatched,
            scrollSteps,
            boundaryReached,
            associationProof: popupAssociationProof,
            surfaceProof: popupSurfaceProof,
            renderedPopupCount,
            popupOwnership,
          },
          choice: {
            responsibility: 'agent',
            decisionRequired: inspection.options.size > 1,
            reason: inspection.options.size === 0 ? 'no_selectable_options' : 'choose_observed_option',
          },
        },
      };
    } catch (error) {
      if (frame.isDetached() || this.documentVersion(frame) !== documentVersion) {
        throwControlDocumentChanged(combinedDispatchEvidence(
          preparationActionDispatched,
          openerActionDispatched,
          error instanceof Stage5BrowserError ? dispatchEvidenceFromError(error) : 'unknown',
        ));
      }
      throw error;
    } finally {
      if (!retained) {
        await Promise.allSettled([
          controlHandle.dispose(),
          representationScopeHandle?.dispose() ?? Promise.resolve(),
          disposePopupSurfaces(popupSurfaces),
          ...[...(options?.values() ?? [])].map(({ handle }) => handle.dispose()),
        ]);
      }
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

function combinedDispatchEvidence(
  ...values: Array<boolean | 'unknown'>
): boolean | 'unknown' {
  if (values.includes(true)) return true;
  if (values.includes('unknown')) return 'unknown';
  return false;
}

function dispatchEvidenceFromError(error: Stage5BrowserError): boolean | 'unknown' {
  const values = [error.details?.actionDispatched, error.details?.clickDispatched]
    .filter((value): value is boolean | 'unknown' =>
      value === true || value === false || value === 'unknown');
  return values.length === 0 ? 'unknown' : combinedDispatchEvidence(...values);
}

function throwControlDocumentChanged(
  actionDispatched: boolean | 'unknown',
): never {
  throw new Stage5BrowserError(
    'TARGET_NOT_FOUND',
    'The page document changed during control inspection, so the prior control and option state are no longer authoritative.',
    {
      recoverable: true,
      details: {
        reason: 'document_changed_during_control_inspection',
        actionDispatched,
        inspectionAborted: true,
        stateRisk: 'read_page_events_before_resuming',
        suggestedAction: actionDispatched === false
          ? 'Read browser_page_events and fresh tabs before inspecting the replacement document once. No control input was dispatched.'
          : 'Read browser_page_events and fresh tabs without replaying the opener. Treat prior unsaved form state as possibly lost when a document_replaced event is present.',
      },
    },
  );
}

export type ControlInspectionOperations = typeof controlInspectionOperations;

function popupAssociationFailure(
  association: Extract<ControlPopupAssociation, { kind: 'ambiguous' }>,
  actionDispatched: boolean | 'unknown',
): Stage5BrowserError {
  return new Stage5BrowserError(
    'AMBIGUOUS_TARGET',
    'The control input exposed multiple popup surface sets without one exact owner.',
    {
      recoverable: true,
      details: {
        reason: 'ambiguous_control_popup_after_reveal',
        actionDispatched,
        renderedPopupCount: association.renderedSurfaceCount,
        popupOwnership: association.popupOwnership,
        suggestedAction: 'Inspect authoritative control state. The opener may have received input; do not replay it automatically.',
      },
    },
  );
}

function representedOptionCount(
  options: ObservedControlInspection['options'],
  representations: Map<string, ControlSelectionRepresentation> | null,
): number {
  if (representations === null) return 0;
  let count = 0;
  for (const option of options.values()) {
    const represented = representations.get(option.observation.name);
    if (represented?.controlRepresentsOption === true ||
      (represented?.localExactRepresentationCount ?? 0) > 0) count += 1;
  }
  return count;
}

function applyRepresentations(
  options: ObservedControlInspection['options'],
  representations: Map<string, ControlSelectionRepresentation> | null,
): number {
  const count = representedOptionCount(options, representations);
  if (representations === null) return count;
  for (const option of options.values()) {
    const represented = representations.get(option.observation.name);
    if (represented === undefined || (
      !represented.controlRepresentsOption &&
      represented.localExactRepresentationCount === 0
    )) continue;
    if (option.observation.selected === null) {
      option.selectedRepresentationObserved = true;
    } else if (option.observation.selected === false) {
      option.selectionStateConflict = true;
    }
    option.observation = {
      ...option.observation,
      selected: option.observation.selected === false ? null : true,
    };
  }
  return count;
}
