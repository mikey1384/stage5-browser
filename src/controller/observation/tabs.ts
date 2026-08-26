import { type Browser, type BrowserCommandInput, type BrowserCommandOutput, Stage5BrowserError, withReadOnlySemanticContentDetails } from '../dependencies.js';
import { boundedValue, remainingUntil, type ScrollContentObservationSurface, type ScrollContentSample, TAB_INSPECTION_RESTORE_RESERVE_MS } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const observationTabsOperations = {
  async tabs(): Promise<BrowserCommandOutput<'tabs'>> {
    const context = this.requireContext();
    await this.reconcileVisiblePage(context);
    const pages = context.pages().filter((page) => !page.isClosed());
    this.observedTabsById.clear();
    const summaries = await Promise.all(pages.map((page, index) => this.tabSummary(page, index)));
    const reportedActivePage = this.preferredPage();
    const activePageIndex = reportedActivePage === undefined ? -1 : pages.indexOf(reportedActivePage);
    return {
      pages: summaries,
      activePageIndex: activePageIndex < 0 ? null : activePageIndex,
    };
  },

  async selectTab(input: BrowserCommandInput<'selectTab'>): Promise<BrowserCommandOutput<'selectTab'>> {
    const context = this.requireContext();
    const pages = context.pages().filter((page) => !page.isClosed());
    const page = this.observedTab(input.tabId, context);

    this.activePage = page;
    const authenticationTargetUpdated = this.authenticationHandoff !== null;
    if (this.authenticationHandoff !== null) {
      this.authenticationHandoff.page = page;
      this.authenticationHandoff.targetOrigin = this.urlOrigin(page.url());
    }
    await page.bringToFront();
    await this.persistNativeSelectedPage(page);
    this.lastKnownUrl = page.url();
    return {
      page: await this.tabSummary(page, pages.indexOf(page)),
      authenticationTargetUpdated,
    };
  },

  async inspectTab(input: BrowserCommandInput<'inspectTab'>): Promise<BrowserCommandOutput<'inspectTab'>> {
    const context = this.requireContext();
    const page = this.observedTab(input.tabId, context);
    const selectedBefore = this.preferredPage();
    const temporaryActivation = input.temporaryActivation;
    if (temporaryActivation && (selectedBefore === undefined || selectedBefore.isClosed())) {
      throw new Stage5BrowserError(
        'BROWSER_NOT_READY',
        'Temporary tab activation requires one exact live controller-selected tab to restore.',
        {
          recoverable: true,
          details: {
            reason: 'temporary_tab_activation_requires_selected_tab',
            activationAttempted: false,
            suggestedAction: 'Call browser_tabs once and establish the intended controller-selected tab before requesting temporary read-only activation.',
          },
        },
      );
    }
    const frame = page.mainFrame();
    const documentVersion = this.documentVersion(frame);
    const deadlineAt = Date.now() + input.timeoutMs;
    const workDeadlineAt = temporaryActivation
      ? Math.max(Date.now() + 1, deadlineAt - TAB_INSPECTION_RESTORE_RESERVE_MS)
      : deadlineAt;
    let observationSurface: ScrollContentObservationSurface | null = null;
    let loadingBefore: ScrollContentSample | null = null;
    if (input.waitFor !== null) {
      observationSurface = await this.resolveScrollContentObservationSurface(frame, null);
      loadingBefore = await boundedValue(
        this.scrollContentObservation(frame, observationSurface),
        Math.max(1, remainingUntil(workDeadlineAt)),
        null,
      );
      if (loadingBefore === null) {
        if (observationSurface.ownsHandle) {
          await observationSurface.handle?.dispose().catch(() => undefined);
        }
        throw new Stage5BrowserError(
          'OPERATION_FAILED',
          'The exact background document could not establish a bounded loading observation.',
          {
            recoverable: true,
            details: {
              reason: 'tab_loading_observation_unavailable',
              activationAttempted: false,
              suggestedAction: 'Do not activate or inspect another tab. Call browser_tabs once and report the changed exact tab state.',
            },
          },
        );
      }
    }

    let snapshot: string | null = null;
    let rendererVisibility: 'visible' | 'hidden' | 'unknown' = 'unknown';
    let visibleModalCount = 0;
    let loadingWait: BrowserCommandOutput<'inspectTab'>['loadingWait'] = null;
    let activationAttempted = false;
    let activationRestored: boolean | null = temporaryActivation ? false : null;
    let activationRestoreRecoveryUsed = false;
    let activationVisibilityRecoveryUsed = false;
    let inspectionError: unknown = null;
    const ensureTemporaryRendererVisible = async (): Promise<void> => {
      if (!temporaryActivation) return;
      const observed = await this.observePageActivation(page);
      if (observed.visibility === 'visible') return;
      if (activationVisibilityRecoveryUsed) {
        throw new Stage5BrowserError(
          'OPERATION_FAILED',
          'The exact temporarily activated renderer became hidden again during bounded read-only inspection.',
          {
            recoverable: true,
            details: {
              reason: 'temporary_tab_activation_visibility_lost',
              activationAttempted: true,
              visibilityRecoveryAttempted: true,
              elementActionDispatched: false,
              suggestedAction: 'Do not repeat activation or inspection. Stage5 Browser will restore the exact prior selected tab before returning the failure.',
            },
          },
        );
      }
      activationVisibilityRecoveryUsed = true;
      activationAttempted = true;
      await page.bringToFront();
      const recovered = await this.waitForVisiblePageActivation(
        page,
        await this.observePageActivation(page),
        Math.max(0, remainingUntil(workDeadlineAt)),
      );
      if (recovered.visibility !== 'visible') {
        throw new Stage5BrowserError(
          'OPERATION_FAILED',
          'The exact temporarily activated renderer could not recover visible state for read-only inspection.',
          {
            recoverable: true,
            details: {
              reason: 'temporary_tab_activation_visibility_recovery_failed',
              activationAttempted: true,
              visibilityRecoveryAttempted: true,
              elementActionDispatched: false,
              suggestedAction: 'Do not repeat activation or inspection. Stage5 Browser will restore the exact prior selected tab before returning the failure.',
            },
          },
        );
      }
    };
    try {
      if (temporaryActivation && selectedBefore !== page) {
        activationAttempted = true;
        await page.bringToFront();
        const activated = await this.waitForVisiblePageActivation(
          page,
          await this.observePageActivation(page),
          Math.max(0, remainingUntil(workDeadlineAt)),
        );
        if (activated.visibility !== 'visible') {
          throw new Stage5BrowserError(
            'OPERATION_FAILED',
            'The exact background renderer did not become visible for bounded read-only inspection.',
            {
              recoverable: true,
              details: {
                reason: 'temporary_tab_activation_not_visible',
                activationAttempted: true,
                suggestedAction: 'Do not select or inspect another tab. Stage5 Browser will first restore the exact controller-selected tab.',
              },
            },
          );
        }
      }
      if (input.waitFor !== null && observationSurface !== null && loadingBefore !== null) {
        loadingWait = await this.waitForScrollContent(
          page,
          frame,
          observationSurface,
          loadingBefore,
          input.waitFor,
          Math.max(0, remainingUntil(workDeadlineAt)),
          ensureTemporaryRendererVisible,
        );
      }
      await ensureTemporaryRendererVisible();
      const rawSnapshot = await page.locator('body').ariaSnapshot({
        mode: 'ai',
        depth: input.depth,
        boxes: false,
        timeout: Math.max(1, remainingUntil(workDeadlineAt)),
      });
      const filteredSnapshot = await this.filterInactivePopupSnapshot(
        frame,
        rawSnapshot,
        workDeadlineAt,
      );
      const observedModalCount = await boundedValue(
        frame.locator('[role="dialog"]:visible, dialog[open]:visible, [aria-modal="true"]:visible').count(),
        Math.max(1, remainingUntil(workDeadlineAt)),
        -1,
      );
      const detailedSnapshot = observedModalCount === 0
        ? await withReadOnlySemanticContentDetails({
          root: page.locator('body'),
          snapshot: filteredSnapshot,
          deadlineAt: workDeadlineAt,
          filterInactivePopupSnapshot: (detail) =>
            this.filterInactivePopupSnapshot(frame, detail, workDeadlineAt),
        })
        : filteredSnapshot;
      snapshot = detailedSnapshot.replaceAll(/\s*\[ref=[^\]]+\]/gu, '');
      const observedVisibility = await boundedValue(
        page.evaluate(() => document.visibilityState),
        Math.max(1, remainingUntil(workDeadlineAt)),
        'unknown' as const,
      );
      rendererVisibility = observedVisibility === 'visible' || observedVisibility === 'hidden'
        ? observedVisibility
        : 'unknown';
      if (temporaryActivation && rendererVisibility !== 'visible') {
        throw new Stage5BrowserError(
          'OPERATION_FAILED',
          'The exact temporarily activated renderer was not visible at the semantic capture boundary.',
          {
            recoverable: true,
            details: {
              reason: 'temporary_tab_activation_hidden_at_capture',
              activationAttempted,
              visibilityRecoveryAttempted: activationVisibilityRecoveryUsed,
              elementActionDispatched: false,
              suggestedAction: 'Do not repeat activation or inspection. Stage5 Browser will restore the exact prior selected tab before returning the failure.',
            },
          },
        );
      }
      visibleModalCount = Math.max(0, observedModalCount);
    } catch (error) {
      inspectionError = error;
    } finally {
      if (observationSurface?.ownsHandle) {
        await observationSurface.handle?.dispose().catch(() => undefined);
      }
      if (temporaryActivation) {
        if (selectedBefore === page) {
          activationRestored = true;
        } else if (selectedBefore !== undefined && !selectedBefore.isClosed()) {
          const restoration = await this.restoreTemporarilyActivatedTab(selectedBefore, deadlineAt);
          activationRestored = restoration.restored;
          activationRestoreRecoveryUsed = restoration.recoveryUsed;
        }
      }
    }
    if (temporaryActivation && activationRestored !== true) {
      throw new Stage5BrowserError(
        'OPERATION_FAILED',
        'Stage5 Browser could not prove restoration of the exact controller-selected tab after temporary read-only activation.',
        {
          recoverable: true,
          details: {
            reason: 'temporary_tab_activation_restore_failed',
            activationAttempted,
            activationRestored: false,
            elementActionDispatched: false,
            suggestedAction: 'Do not select, inspect, close, dismiss, or interact with any tab. Call browser_tabs once and report the exact fresh identities and controller selection.',
          },
          cause: inspectionError,
        },
      );
    }
    if (inspectionError !== null) throw inspectionError;
    if (snapshot === null) {
      throw new Stage5BrowserError('OPERATION_FAILED', 'The exact tab inspection produced no semantic result.', {
        recoverable: true,
        details: {
          reason: 'tab_inspection_result_unavailable',
          activationAttempted,
          activationRestored,
          suggestedAction: 'Do not repeat the inspection. Call browser_tabs once and report the exact fresh tab state.',
        },
      });
    }
    if (
      frame.isDetached() ||
      page.isClosed() ||
      !context.pages().includes(page) ||
      this.observedTabsById.get(input.tabId) !== page ||
      this.documentVersion(frame) !== documentVersion
    ) {
      throw new Stage5BrowserError(
        'TARGET_NOT_FOUND',
        'The background tab document changed during read-only inspection.',
        {
          recoverable: true,
          details: {
            reason: 'document_changed_during_tab_inspection',
            actionDispatched: false,
            suggestedAction: 'Call browser_tabs once, then inspect the intended fresh opaque tabId once more.',
          },
        },
      );
    }
    const visibilityAfterRestore = await boundedValue(
      page.evaluate(() => document.visibilityState),
      Math.max(1, remainingUntil(deadlineAt)),
      'unknown' as const,
    );
    const controllerSelectionUnchanged = this.preferredPage() === selectedBefore;
    const warnings: BrowserCommandOutput<'inspectTab'>['warnings'] = [];
    if (loadingWait !== null && !loadingWait.satisfied) {
      warnings.push({
        code: 'loading_expectation_not_satisfied',
        message: 'The bounded loading/content expectation was not satisfied before the read-only snapshot.',
        suggestedAction: 'Use only the returned ref-free evidence. Do not repeat activation, select the tab, or infer that loading completed.',
      });
    }
    if (visibleModalCount > 0) {
      warnings.push({
        code: 'visible_modal_in_document',
        message: 'The inspected document contains a visible modal; its application may suppress underlying content from the accessibility tree.',
        suggestedAction: 'Use only the returned ref-free evidence. Do not infer that suppressed background content is absent or close the modal to expose it.',
      });
    }
    if (!controllerSelectionUnchanged) {
      warnings.push({
        code: 'controller_selection_changed_externally',
        message: 'The controller-selected tab changed independently while the background document was being inspected.',
        suggestedAction: 'Call browser_tabs once and re-establish the intended selected and inspected tab identities before any action.',
      });
    }
    const livePages = context.pages().filter((candidate) => !candidate.isClosed());
    return {
      page: await this.tabSummary(page, livePages.indexOf(page)),
      snapshot,
      scope: 'document',
      refCount: 0,
      elementActionsAvailable: false,
      activationAttempted,
      activationRestored,
      activationRestoreRecoveryUsed,
      rendererVisibility,
      rendererVisibilityAfterRestore: visibilityAfterRestore === 'visible' || visibilityAfterRestore === 'hidden'
        ? visibilityAfterRestore
        : 'unknown',
      loadingWait,
      visibleModalCount,
      controllerSelectionUnchanged,
      warnings,
    };
  },

  async frames(): Promise<BrowserCommandOutput<'frames'>> {
    const page = await this.ensureActivePage(this.requireContext());
    const frames = page.frames().filter((frame) => !frame.isDetached());
    return {
      page: await this.pageSummary(page),
      frames: frames.map((frame) => this.frameSummary(frame, page)),
    };
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type ObservationTabsOperations = typeof observationTabsOperations;
