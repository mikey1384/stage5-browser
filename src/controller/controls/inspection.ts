import { randomUUID } from 'node:crypto';

import { type BrowserCommandInput, type BrowserCommandOutput, type ElementHandle, type Frame, type Locator, Stage5BrowserError } from '../dependencies.js';
import { boundedValue, type ObservedControlInspection, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import { popupRendered } from './rendering.js';
import { resolveUniqueControl } from './resolution.js';

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
    let popupLocator: Locator | null = null;
    let popupHandle: ElementHandle<HTMLElement> | null = null;
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
          popupLocator = associated.locator;
          popupHandle = associated.handle;
          popupAssociationProof = associated.proof;
          popupSurfaceProof = associated.surfaceProof;
        }
        let rendered = await popupRendered(popupHandle, deadlineAt);
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

          await popupHandle?.dispose().catch(() => undefined);
          popupHandle = null;
          popupLocator = null;
          await controlHandle.dispose().catch(() => undefined);
          ({ locator: controlLocator, handle: controlHandle } = await resolveUniqueControl(
            input.control,
            frame,
            deadlineAt,
          ));
          descriptor = await this.inspectControlDescriptor(controlHandle, deadlineAt);
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
            popupLocator = associated.locator;
            popupHandle = associated.handle;
            popupAssociationProof = associated.proof;
            popupSurfaceProof = associated.surfaceProof;
          }
          rendered = await popupRendered(popupHandle, deadlineAt);
          popupOpened = rendered;
          if (!rendered && revealError !== null) throw revealError;
          if (!rendered || associated.kind !== 'resolved') {
            throw new Stage5BrowserError(
              associated.kind === 'ambiguous' ? 'AMBIGUOUS_TARGET' : 'POSTCONDITION_FAILED',
              associated.kind === 'ambiguous'
                ? 'The control input exposed multiple possible popup surfaces.'
                : 'The control input did not expose one associated popup surface.',
              {
                recoverable: true,
                details: {
                  reason: associated.kind === 'ambiguous' ? 'ambiguous_control_popup_after_reveal' : 'control_popup_not_observed',
                  actionDispatched: openerActionDispatched,
                  renderedPopupCount,
                  popupOwnership: associated.popupOwnership,
                  suggestedAction: 'Inspect authoritative page state. The opener may have received input; do not replay it automatically.',
                },
              },
            );
          }
        } else {
          popupOpened = rendered;
        }

        if (popupHandle === null || !await popupRendered(popupHandle, deadlineAt)) {
          options = new Map();
        } else {
          const popupMultiple = await boundedValue(
            popupHandle.evaluate((popup) => popup.getAttribute('aria-multiselectable') === 'true'),
            Math.max(1, remainingUntil(deadlineAt)),
            false,
          );
          const custom = await this.collectPopupControlOptions(
            frame,
            popupLocator,
            popupHandle,
            input.maxOptions,
            deadlineAt,
          );
          options = custom.options;
          optionsComplete = custom.complete;
          scrollSteps = custom.scrollSteps;
          boundaryReached = custom.boundaryReached;
          if (descriptor !== null) {
            descriptor = {
              ...descriptor,
              multiple: descriptor.multiple || popupMultiple ||
                [...custom.options.values()].some(({ observation }) => observation.role === 'menuitemcheckbox'),
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
        popupLocator,
        popupHandle,
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
          popupHandle?.dispose() ?? Promise.resolve(),
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
