import { type Frame, Stage5BrowserError } from '../dependencies.js';
import type { ObservedControlInspection } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const controlCapabilityOperations = {
  retainControlInspection(inspection: ObservedControlInspection): void {
    this.discardControlInspectionsForFrame(inspection.frame);
    this.controlInspections.set(inspection.id, inspection);
  },

  consumeControlInspection(
    frame: Frame,
    inspectionId: string,
  ): ObservedControlInspection {
    const inspection = this.controlInspections.get(inspectionId);
    this.controlInspections.delete(inspectionId);
    if (
      inspection === undefined ||
      inspection.frame !== frame ||
      frame.isDetached() ||
      inspection.documentVersion !== this.documentVersion(frame)
    ) {
      if (inspection !== undefined) void this.disposeControlInspection(inspection);
      throw new Stage5BrowserError(
        'TARGET_NOT_FOUND',
        'The control inspection capability is stale or does not belong to the active document.',
        {
          recoverable: true,
          details: {
            reason: 'stale_control_inspection',
            actionDispatched: false,
            suggestedAction: 'Inspect the intended control once more. Stage5 Browser confirmed that no selection input was dispatched.',
          },
        },
      );
    }
    return inspection;
  },

  discardControlInspectionsForFrame(frame: Frame): void {
    for (const [inspectionId, inspection] of this.controlInspections) {
      if (inspection.frame !== frame) continue;
      this.controlInspections.delete(inspectionId);
      void this.disposeControlInspection(inspection);
    }
  },

  discardAllControlInspections(): void {
    for (const inspection of this.controlInspections.values()) {
      void this.disposeControlInspection(inspection);
    }
    this.controlInspections.clear();
  },

  async disposeControlInspection(inspection: ObservedControlInspection): Promise<void> {
    await Promise.allSettled([
      inspection.controlHandle.dispose(),
      inspection.representationScopeHandle?.dispose() ?? Promise.resolve(),
      inspection.popupHandle?.dispose() ?? Promise.resolve(),
      ...[...inspection.options.values()].map(({ handle }) => handle.dispose()),
    ]);
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type ControlCapabilityOperations = typeof controlCapabilityOperations;
