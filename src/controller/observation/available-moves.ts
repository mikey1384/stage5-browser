import { type BrowserCommandInput, type BrowserCommandOutput, type BrowserControlMode, deriveBrowserAvailableMoves } from '../dependencies.js';
import type { BrowserControllerContext } from '../runtime.js';

export const observationAvailableMovesOperations = {
  async availableMoves(
    input: BrowserCommandInput<'availableMoves'>,
  ): Promise<BrowserCommandOutput<'availableMoves'>> {
    const status = await this.status();
    const activePage = this.preferredPage();
    const currentFrame = (frame: import('playwright').Frame): boolean =>
      activePage !== undefined &&
      !activePage.isClosed() &&
      !frame.isDetached() &&
      frame.page() === activePage;

    const snapshots = [...this.observedSnapshots.entries()].filter(([frame, snapshot]) =>
      currentFrame(frame) && snapshot.documentVersion === this.documentVersion(frame));
    const controlInspections = [...this.controlInspections.values()].filter((inspection) =>
      currentFrame(inspection.frame) && inspection.documentVersion === this.documentVersion(inspection.frame));
    const formInspections = [...this.formInspections.values()].filter((inspection) =>
      currentFrame(inspection.frame) && inspection.documentVersion === this.documentVersion(inspection.frame));
    const context = this.usableContext();
    const observedTabs = context === undefined
      ? 0
      : [...this.observedTabsById.values()].filter((page) =>
        !page.isClosed() && page.context() === context).length;

    const controlMode: BrowserControlMode = this.privateFieldHandoff !== null
      ? 'private_field'
      : this.pendingHandoffRelease !== null
        ? 'authentication_release'
        : this.authenticationHandoff?.state === 'awaiting_user'
          ? 'authentication_user'
          : 'agent';

    return deriveBrowserAvailableMoves({
      lifecycleState: status.state,
      browserConnected: status.browserConnected,
      livePageCount: status.pages.length,
      selectedPage: status.activePageIndex !== null,
      controlMode,
      policyMode: this.actionPolicy.status().mode,
      capabilityCounts: {
        observedTabs,
        semanticSnapshots: snapshots.length,
        snapshotRefs: snapshots.reduce((count, [, snapshot]) => count + snapshot.refs.size, 0),
        textEditorRefs: snapshots.reduce((count, [, snapshot]) => count + snapshot.textEditors.size, 0),
        fileInputRefs: snapshots.reduce((count, [, snapshot]) => count + snapshot.fileInputs.size, 0),
        scrollContainerRefs: snapshots.reduce((count, [, snapshot]) => count + snapshot.scrollContainers.size, 0),
        controlInspections: controlInspections.length,
        controlOptions: controlInspections.reduce((count, inspection) => count + inspection.options.size, 0),
        formInspections: formInspections.length,
        formFields: formInspections.reduce((count, inspection) => count + inspection.fields.size, 0),
      },
    }, input);
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type ObservationAvailableMovesOperations = typeof observationAvailableMovesOperations;
