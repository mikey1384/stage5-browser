import { type Frame, Stage5BrowserError } from '../dependencies.js';
import type { ObservedFormInspection } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const formCapabilityOperations = {
  retainFormInspection(inspection: ObservedFormInspection): void {
    this.discardFormInspectionsForFrame(inspection.frame);
    this.formInspections.set(inspection.id, inspection);
  },

  consumeFormInspection(frame: Frame, formId: string): ObservedFormInspection {
    const inspection = this.formInspections.get(formId);
    if (inspection === undefined) {
      throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The form capability is stale or was already consumed.', {
        recoverable: true,
        details: {
          reason: 'stale_form_inspection',
          actionDispatched: false,
          suggestedAction: 'Take one fresh browser_form_summary and use only its exact formId and fieldIds.',
        },
      });
    }
    this.formInspections.delete(formId);
    if (
      inspection.frame !== frame ||
      frame.isDetached() ||
      inspection.documentVersion !== this.documentVersion(frame)
    ) {
      void this.disposeFormInspection(inspection);
      throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The form document changed after its summary.', {
        recoverable: true,
        details: {
          reason: 'form_document_changed',
          actionDispatched: false,
          suggestedAction: 'Take one fresh form summary. Stage5 Browser confirmed that no form-plan input was dispatched.',
        },
      });
    }
    return inspection;
  },

  discardFormInspectionsForFrame(frame: Frame): void {
    for (const [formId, inspection] of this.formInspections) {
      if (inspection.frame !== frame) continue;
      this.formInspections.delete(formId);
      void this.disposeFormInspection(inspection);
    }
  },

  discardAllFormInspections(): void {
    for (const inspection of this.formInspections.values()) {
      void this.disposeFormInspection(inspection);
    }
    this.formInspections.clear();
  },

  async disposeFormInspection(inspection: ObservedFormInspection): Promise<void> {
    await Promise.allSettled([...inspection.fields.values()].flatMap(({ handle, ownerFormHandle }) => [
      handle.dispose(),
      ...(ownerFormHandle === null ? [] : [ownerFormHandle.dispose()]),
    ]));
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type FormCapabilityOperations = typeof formCapabilityOperations;
