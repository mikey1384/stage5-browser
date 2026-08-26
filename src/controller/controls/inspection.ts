import { randomUUID } from 'node:crypto';

import { type BrowserCommandInput, type BrowserCommandOutput, type ElementHandle, type Frame, inspectTargetState, type Locator, Stage5BrowserError } from '../dependencies.js';
import { boundedValue, type ObservedControlInspection, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import { popupRendered } from './rendering.js';

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
        const preparation = await this.dismissCompetingControlPopup(
          page,
          frame,
          controlHandle,
          deadlineAt,
        );
        competingPopupDismissed = preparation.competingPopupDismissed;
        preparationActionDispatched = preparation.preparationActionDispatched;
        let associated = await this.associatedControlPopup(frame, controlHandle, deadlineAt);
        if (associated === 'ambiguous') {
          throw new Stage5BrowserError('AMBIGUOUS_TARGET', 'Multiple popup surfaces could belong to the exact control.', {
            recoverable: true,
            details: {
              reason: 'ambiguous_control_popup',
              actionDispatched: false,
              decision: { kind: 'decision_required', responsible: 'agent' },
              suggestedAction: 'Inspect the current semantic page state and narrow to one exact control or modal before continuing.',
            },
          });
        }
        if (associated !== null) {
          popupLocator = associated.locator;
          popupHandle = associated.handle;
        }
        let rendered = await popupRendered(popupHandle, deadlineAt);
        if (!rendered && input.revealOptions) {
          await popupHandle?.dispose().catch(() => undefined);
          popupHandle = null;
          popupLocator = null;
          let revealError: unknown = null;
          try {
            await this.clickByRole({
              role: input.control.role,
              name: input.control.name,
              exact: input.control.exact,
              frameId: input.frameId,
              postcondition: {
                expectedUrl: null,
                expectedSelected: true,
                expectedVisible: null,
                expectedHidden: null,
                timeoutMs: Math.max(100, Math.min(2_000, remainingUntil(deadlineAt))),
              },
              timeoutMs: Math.max(1_000, remainingUntil(deadlineAt)),
            });
            openerActionDispatched = true;
          } catch (error) {
            revealError = error;
            if (error instanceof Stage5BrowserError) {
              const dispatched = error.details?.actionDispatched;
              openerActionDispatched = dispatched === true || dispatched === false || dispatched === 'unknown'
                ? dispatched
                : 'unknown';
            } else {
              openerActionDispatched = 'unknown';
            }
          }

          await controlHandle.dispose().catch(() => undefined);
          ({ locator: controlLocator, handle: controlHandle } = await resolveUniqueControl(
            input.control,
            frame,
            deadlineAt,
          ));
          descriptor = await this.inspectControlDescriptor(controlHandle, deadlineAt);
          associated = await this.associatedControlPopup(frame, controlHandle, deadlineAt);
          if (associated !== null && associated !== 'ambiguous') {
            popupLocator = associated.locator;
            popupHandle = associated.handle;
          }
          rendered = await popupRendered(popupHandle, deadlineAt);
          popupOpened = rendered;
          if (!rendered && revealError !== null) throw revealError;
          if (!rendered || associated === 'ambiguous') {
            throw new Stage5BrowserError(
              associated === 'ambiguous' ? 'AMBIGUOUS_TARGET' : 'POSTCONDITION_FAILED',
              associated === 'ambiguous'
                ? 'The control input exposed multiple possible popup surfaces.'
                : 'The control input did not expose one associated popup surface.',
              {
                recoverable: true,
                details: {
                  reason: associated === 'ambiguous' ? 'ambiguous_control_popup_after_reveal' : 'control_popup_not_observed',
                  actionDispatched: openerActionDispatched,
                  suggestedAction: 'Inspect authoritative page state. The opener may have received input; do not replay it automatically.',
                },
              },
            );
          }
        } else {
          popupOpened = rendered;
        }

        if (popupLocator === null || popupHandle === null || !await popupRendered(popupHandle, deadlineAt)) {
          options = new Map();
        } else {
          const popupMultiple = await boundedValue(
            popupHandle.evaluate((popup) => popup.getAttribute('aria-multiselectable') === 'true'),
            Math.max(1, remainingUntil(deadlineAt)),
            false,
          );
          const custom = await this.collectPopupControlOptions(
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
        throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The control document changed during option inspection.', {
          recoverable: true,
          details: {
            reason: 'document_changed_during_control_inspection',
            actionDispatched: openerActionDispatched,
            suggestedAction: openerActionDispatched === false
              ? 'Inspect the fresh document once. No opener input was dispatched.'
              : 'Inspect authoritative state without replaying the opener; the prior document changed after possible input.',
          },
        });
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
          },
          choice: {
            responsibility: 'agent',
            decisionRequired: inspection.options.size > 1,
            reason: inspection.options.size === 0 ? 'no_selectable_options' : 'choose_observed_option',
          },
        },
      };
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

async function resolveUniqueControl(
    input: BrowserCommandInput<'inspectControl'>['control'],
    frame: Frame,
    deadlineAt: number,
  ): Promise<{ locator: Locator; handle: ElementHandle<HTMLElement> }> {
    const locator = frame.getByRole(input.role, { name: input.name, exact: input.exact });
    const count = await boundedValue(
      locator.count(),
      Math.max(1, remainingUntil(deadlineAt)),
      -1,
    );
    if (count !== 1) {
      throw new Stage5BrowserError(
        count > 1 ? 'AMBIGUOUS_TARGET' : count === 0 ? 'TARGET_NOT_FOUND' : 'OPERATION_FAILED',
        count > 1
          ? 'Multiple controls matched; Stage5 Browser will not choose one arbitrarily.'
          : count === 0
            ? 'No control matched the requested role and accessible name.'
            : 'Control resolution exceeded the bounded inspection deadline.',
        {
          recoverable: true,
          details: {
            reason: count > 1 ? 'ambiguous_control' : count === 0 ? 'control_not_found' : 'control_resolution_timeout',
            actionDispatched: false,
            matchCount: count > 0 ? count : undefined,
            suggestedAction: 'Take one fresh semantic snapshot and identify one exact control. Stage5 Browser confirmed that no control input was dispatched.',
          },
        },
      );
    }
    const handle = await boundedValue(
      locator.elementHandle() as Promise<ElementHandle<HTMLElement> | null>,
      Math.max(1, remainingUntil(deadlineAt)),
      null,
    );
    if (handle === null) {
      throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The exact control detached before inspection.', {
        recoverable: true,
        details: {
          reason: 'control_detached_before_inspection',
          actionDispatched: false,
          suggestedAction: 'Take one fresh semantic snapshot. Stage5 Browser confirmed that no control input was dispatched.',
        },
      });
    }
    const state = await boundedValue(
      inspectTargetState(handle),
      Math.max(1, remainingUntil(deadlineAt)),
      null,
    );
    if (state === null || !state.visible || !state.enabled) {
      await handle.dispose().catch(() => undefined);
      throw new Stage5BrowserError('OPERATION_FAILED', 'The exact control is not available for bounded option inspection.', {
        recoverable: true,
        details: {
          reason: state === null ? 'control_detached_before_inspection' : !state.visible ? 'control_not_visible' : 'control_not_enabled',
          actionDispatched: false,
          suggestedAction: 'Inspect the current page state and resolve the exact control state before continuing. No control input was dispatched.',
        },
      });
    }
    return { locator, handle };
  }

export type ControlInspectionOperations = typeof controlInspectionOperations;
