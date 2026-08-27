import { type ElementHandle, type FormFieldResolutionEvidence, type Frame, Stage5BrowserError } from '../dependencies.js';
import { boundedValue, type ObservedFormField, type ObservedFormInspection, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import { describeFormFieldElement, FORM_FIELD_SELECTOR } from './field-observation.js';

export interface CurrentFormField {
  field: ObservedFormField;
  fieldResolution: FormFieldResolutionEvidence;
  dispose: () => Promise<void>;
}

const MAX_REBIND_CANDIDATES = 200;

function sameStableIdentity(
  original: ObservedFormField['observation'],
  candidate: ObservedFormField['observation'],
): boolean {
  return original.name !== null &&
    original.name === candidate.name &&
    original.role === candidate.role &&
    original.kind === candidate.kind &&
    original.inputType === candidate.inputType &&
    original.multiple === candidate.multiple;
}

export const formFieldRebindOperations = {
  async resolveCurrentFormField(
    frame: Frame,
    inspection: ObservedFormInspection,
    original: ObservedFormField,
    deadlineAt: number,
  ): Promise<CurrentFormField> {
    const current = await boundedValue(
      original.locator.elementHandle() as Promise<ElementHandle<HTMLElement> | null>,
      Math.max(1, remainingUntil(deadlineAt)),
      null,
    );
    const retained = current !== null && await original.handle
      .evaluate((retainedElement, currentElement) => retainedElement === currentElement, current)
      .catch(() => false);
    await current?.dispose().catch(() => undefined);
    if (retained) {
      return {
        field: original,
        fieldResolution: {
          resolution: 'retained_exact',
          basis: 'retained_handle_identity',
          rebindAttempts: 0,
        },
        dispose: async () => undefined,
      };
    }

    if (original.observation.name === null) {
      throw this.formFieldRebindFailure('form_field_rebind_missing_identity');
    }
    const root = await this.snapshotRoot(frame);
    if (root.scope !== inspection.scope) {
      throw this.formFieldRebindFailure('form_field_rebind_scope_changed');
    }
    const candidates = root.locator.locator(FORM_FIELD_SELECTOR);
    const count = await boundedValue(
      candidates.count(),
      Math.max(1, remainingUntil(deadlineAt)),
      -1,
    );
    if (count < 0 || count > MAX_REBIND_CANDIDATES) {
      throw this.formFieldRebindFailure('form_field_rebind_unbounded');
    }

    const matches: ObservedFormField[] = [];
    for (let index = 0; index < count; index += 1) {
      const locator = candidates.nth(index);
      const handle = await boundedValue(
        locator.elementHandle() as Promise<ElementHandle<HTMLElement> | null>,
        Math.max(1, remainingUntil(deadlineAt)),
        null,
      );
      if (handle === null) continue;
      const sameOwnerForm = original.ownerFormHandle === null
        ? await boundedValue(
            handle.evaluate((candidate) => candidate.closest('form') === null),
            Math.max(1, remainingUntil(deadlineAt)),
            false,
          )
        : await boundedValue(
            original.ownerFormHandle.evaluate(
              (ownerForm, candidate) => ownerForm.isConnected && candidate.closest('form') === ownerForm,
              handle,
            ),
            Math.max(1, remainingUntil(deadlineAt)),
            false,
          );
      if (!sameOwnerForm) {
        await handle.dispose().catch(() => undefined);
        continue;
      }
      const descriptor = await boundedValue(
        handle.evaluate(describeFormFieldElement),
        Math.max(1, remainingUntil(deadlineAt)),
        null,
      );
      if (descriptor === null || !sameStableIdentity(original.observation, {
        fieldId: original.observation.fieldId,
        ...descriptor,
      })) {
        await handle.dispose().catch(() => undefined);
        continue;
      }
      matches.push({
        locator,
        handle,
        ownerFormHandle: original.ownerFormHandle,
        observation: { fieldId: original.observation.fieldId, ...descriptor },
      });
    }
    if (
      frame.isDetached() ||
      this.documentVersion(frame) !== inspection.documentVersion ||
      matches.length !== 1
    ) {
      await Promise.allSettled(matches.map(({ handle }) => handle.dispose()));
      throw this.formFieldRebindFailure(
        matches.length > 1 ? 'form_field_rebind_ambiguous' : 'form_field_rebind_missing',
      );
    }
    const field = matches[0]!;
    return {
      field,
      fieldResolution: {
        resolution: 'rebound_exact',
        basis: 'stable_role_name_kind',
        rebindAttempts: 1,
      },
      dispose: async () => {
        await field.handle.dispose().catch(() => undefined);
      },
    };
  },

  formFieldRebindFailure(reason: string): Stage5BrowserError {
    return new Stage5BrowserError(
      reason === 'form_field_rebind_ambiguous' ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND',
      'A not-yet-dispatched form field could not be uniquely re-resolved after framework rendering.',
      {
        recoverable: true,
        details: {
          reason,
          actionDispatched: false,
          fieldRebinding: { attempted: true, reboundSteps: 0, failed: true },
          suggestedAction: 'Take one fresh form summary and continue only the undispatched steps. Do not replay completed inputs.',
        },
      },
    );
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type FormFieldRebindOperations = typeof formFieldRebindOperations;
