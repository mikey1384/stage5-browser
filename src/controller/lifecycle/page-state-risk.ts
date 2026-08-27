import {
  type NativeControlRecord,
  type Page,
  profileDirForBrowser,
  writeNativeControlRecord,
} from '../dependencies.js';
import type { BrowserControllerContext } from '../runtime.js';

export const lifecyclePageStateRiskOperations = {
  async persistNativePageStateRisk(page: Page): Promise<void> {
    const record = this.nativeControlRecord;
    if (record === null || page.isClosed()) return;
    const [selectedTargetId, documentId] = await Promise.all([
      this.chromiumTargetId(page),
      this.chromiumDocumentId(page),
    ]);
    if (selectedTargetId === null || documentId === null) return;
    const stateRisk = this.pageStateRiskManager.current(page);
    const { retainedPageStateRisk: _staleRisk, ...recordWithoutRisk } = record;
    const updated: NativeControlRecord = {
      ...recordWithoutRisk,
      selectedTargetId,
      selectedDocumentId: documentId,
      ...(stateRisk === null ? {} : {
        retainedPageStateRisk: { selectedTargetId, documentId, stateRisk },
      }),
    };
    try {
      await writeNativeControlRecord(
        profileDirForBrowser(this.config, this.selectedBrowser),
        updated,
      );
      this.nativeControlRecord = updated;
    } catch {
      // This value-free continuity hint must never change the browser action result.
    }
  },

  async restoreNativePageStateRiskAfterAttach(page: Page): Promise<void> {
    const retained = this.nativeControlRecord?.retainedPageStateRisk;
    if (retained === undefined || page.isClosed()) return;
    const [selectedTargetId, documentId] = await Promise.all([
      this.chromiumTargetId(page),
      this.chromiumDocumentId(page),
    ]);
    if (
      selectedTargetId !== retained.selectedTargetId ||
      documentId !== retained.documentId
    ) return;
    this.pageStateRiskManager.restore(page, retained.stateRisk);
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type LifecyclePageStateRiskOperations = typeof lifecyclePageStateRiskOperations;
