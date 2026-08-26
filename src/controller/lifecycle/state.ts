import { type Browser, type BrowserCommandInput, type BrowserStatus, type Frame, inspectProfile, type NativeControlRecord, type Page, processIsRunning, profileDirForBrowser, removeNativeControlRecord, resolveBrowserLaunchTarget, Stage5BrowserError, waitForProfileUnlock, writeNativeControlRecord } from '../dependencies.js';
import type { BrowserControllerContext } from '../runtime.js';

export const lifecycleStateOperations = {
  async switchBrowser(input: BrowserCommandInput<'switchBrowser'>): Promise<BrowserStatus> {
    if (input.browser === this.selectedBrowser) {
      return this.start();
    }

    // Confirm the target is launchable before closing the current browser and its tabs.
    await resolveBrowserLaunchTarget(this.selectionFor(input.browser));
    await this.stop();
    this.selectedBrowser = input.browser;
    this.lastKnownUrl = null;
    return this.start();
  },

  async stop(): Promise<BrowserStatus> {
    if (this.privateFieldHandoff !== null) {
      throw this.privateFieldInProgressError();
    }
    if (this.pendingHandoffRelease !== null) {
      throw this.humanBootstrapInProgressError(
        'The private interaction handoff is still releasing the exact owned profile and must be resumed before Stage5 Browser can stop or switch it.',
      );
    }
    if (
      this.authenticationHandoff?.state === 'awaiting_user' &&
      this.authenticationHandoff.session.state().running
    ) {
      throw this.humanBootstrapInProgressError(
        'The private authentication handoff must be completed by the user before Stage5 Browser can stop or switch it.',
      );
    }
    const context = this.context;
    const nativeBrowser = this.nativeAttachedBrowser;
    const nativeRecord = this.nativeControlRecord;
    const profileRoot = profileDirForBrowser(this.config, this.selectedBrowser);
    const browserWasOwned = nativeBrowser !== undefined || context !== undefined;
    if (browserWasOwned) {
      await this.ownershipLease.updatePhase('close_requested');
    }
    this.context = undefined;
    this.activePage = undefined;
    this.framesById.clear();
    this.observedTabsById.clear();
    this.discardAllObservedSnapshots();
    this.discardAllControlInspections();
    this.discardAllFormInspections();
    this.frameIds = new WeakMap<Frame, string>();
    this.tabIds = new WeakMap<Page, string>();
    this.frameDocumentVersions = new WeakMap<Frame, number>();
    this.boundPages = new WeakSet<Page>();
    this.authenticationHandoff = null;
    this.controlledLaunchIdentity = null;
    this.runtimeProfileObservation = null;
    this.controlledStartBoundary = null;
    this.nativeAttachedBrowser = undefined;
    this.nativeControlRecord = null;
    this.controlledBrowserProcessId = null;
    this.controlledBrowserProcess = null;
    this.state = 'stopped';

    if (nativeBrowser !== undefined && nativeRecord !== null) {
      await this.closeOwnedNativeBrowser(context, nativeBrowser, nativeRecord);
      await removeNativeControlRecord(profileRoot);
    } else if (context !== undefined && !context.isClosed()) {
      await context.close({ reason: 'Stage5 Browser stopped the owned browser context.' });
    }

    if (browserWasOwned) {
      await this.ownershipLease.updatePhase('process_exited');
      let unlocked = await waitForProfileUnlock(
        profileRoot,
        Math.min(this.config.operationTimeoutMs, 10_000),
      );
      if (!unlocked) {
        const releaseProfile = await inspectProfile(profileRoot, false);
        unlocked = releaseProfile.lockFiles.length === 0;
        if (unlocked) {
          await this.ownershipLease.updatePhase('profile_unlocked');
          await this.ownershipLease.release();
        }
      }
      if (!unlocked) {
        const releaseProfile = await inspectProfile(profileRoot, false);
        throw new Stage5BrowserError(
          'BROWSER_NOT_READY',
          'The owned browser close completed, but the dedicated profile has not released its lock.',
          {
            recoverable: true,
            details: {
              reason: 'profile_locked',
              ownershipReason: 'owned_release_pending',
              profileLockFiles: releaseProfile.lockFiles,
              suggestedAction: 'Wait for the exact dedicated Stage5 browser process to finish exiting, then call browser_status once. Do not delete profile locks or launch another backend as a workaround.',
            },
          },
        );
      }
      await this.ownershipLease.updatePhase('profile_unlocked');
      await this.ownershipLease.release();
    }

    return this.status();
  },

  async detachForWorkerShutdown(): Promise<void> {
    if (this.privateFieldHandoff !== null || this.pendingHandoffRelease !== null || this.authenticationHandoff?.state === 'awaiting_user') {
      await this.ownershipLease.detach();
      return;
    }
    const nativeBrowser = this.nativeAttachedBrowser;
    if (nativeBrowser === undefined) {
      await this.stop();
      return;
    }

    const nativeRecord = this.nativeControlRecord;
    if (nativeRecord !== null) {
      await this.persistActionDiagnosticsForWorkerHandoff();
      await writeNativeControlRecord(
        profileDirForBrowser(this.config, this.selectedBrowser),
        { ...(this.nativeControlRecord ?? nativeRecord), state: 'controlled' },
      ).catch(() => undefined);
      await this.ownershipLease.updatePhase('owned_active').catch(() => undefined);
    }

    this.context = undefined;
    this.activePage = undefined;
    this.framesById.clear();
    this.observedTabsById.clear();
    this.discardAllObservedSnapshots();
    this.discardAllControlInspections();
    this.discardAllFormInspections();
    this.frameIds = new WeakMap<Frame, string>();
    this.tabIds = new WeakMap<Page, string>();
    this.frameDocumentVersions = new WeakMap<Frame, number>();
    this.boundPages = new WeakSet<Page>();
    this.nativeAttachedBrowser = undefined;
    this.nativeControlRecord = null;
    this.controlledBrowserProcessId = null;
    this.controlledBrowserProcess = null;
    this.state = 'stopped';
    await this.ownershipLease.detach();
    await nativeBrowser.close().catch(() => undefined);
  },

  async persistActionDiagnosticsForWorkerHandoff(): Promise<void> {
    const page = this.preferredPage();
    const record = this.nativeControlRecord;
    if (page === undefined || page.isClosed() || record === null || record.state !== 'controlled') return;
    const diagnostic = this.pageDiagnostics.snapshot(page).lastAction;
    const [selectedTargetId, documentId] = await Promise.all([
      this.chromiumTargetId(page),
      this.chromiumDocumentId(page),
    ]);
    if (selectedTargetId === null || documentId === null) return;
    const { retainedAction: _staleRetainedAction, ...recordWithoutRetainedAction } = record;
    const updated: NativeControlRecord = {
      ...recordWithoutRetainedAction,
      selectedTargetId,
      selectedDocumentId: documentId,
      ...(diagnostic === null
        ? {}
        : {
          retainedAction: {
            selectedTargetId,
            documentId,
            diagnostic,
          },
        }),
    };
    try {
      await writeNativeControlRecord(
        profileDirForBrowser(this.config, this.selectedBrowser),
        updated,
      );
      this.nativeControlRecord = updated;
    } catch {
      // Diagnostics retention must never change the browser action's terminal result.
    }
  },

  async status(): Promise<BrowserStatus> {
    const context = this.usableContext();
    const profilePath = profileDirForBrowser(this.config, this.selectedBrowser);
    if (context === undefined) {
      if (this.state !== 'failed' && this.state !== 'recovering') {
        this.state = 'stopped';
      }
      const handoffProcessRunning = this.authenticationHandoff?.session.state().running === true
        || (this.pendingHandoffRelease !== null
          && processIsRunning(this.pendingHandoffRelease.controlledBrowserProcess.processId));
      const handoffIdentity = this.authenticationHandoff?.launchIdentity
        ?? this.pendingHandoffRelease?.launchIdentity
        ?? this.controlledLaunchIdentity;
      const profile = await inspectProfile(profilePath, handoffProcessRunning);
      return {
        browser: this.selectedBrowser,
        state: this.state,
        workerPid: process.pid,
        browserConnected: false,
        pages: [],
        activePageIndex: null,
        lastKnownUrl: this.lastKnownUrl,
        launchIdentity: handoffIdentity,
        runtimeProfile: null,
        profileLockState: profile.lockState,
        profileLockFiles: profile.lockFiles,
        profileOwner: await this.profileOwnerEvidence(
          profile,
          handoffIdentity,
          handoffProcessRunning,
        ),
      };
    }

    await this.reconcileVisiblePage(context);
    const pages = context.pages().filter((page) => !page.isClosed());
    const summaries = await Promise.all(pages.map((page, index) => this.pageSummary(page, index)));
    const reportedActivePage = this.preferredPage();
    const activePageIndex = reportedActivePage === undefined ? -1 : pages.indexOf(reportedActivePage);
    const profile = await inspectProfile(profilePath, true);
    this.state = 'running';

    return {
      browser: this.selectedBrowser,
      state: this.state,
      workerPid: process.pid,
      browserConnected: context.browser()?.isConnected() ?? true,
      pages: summaries,
      activePageIndex: activePageIndex < 0 ? null : activePageIndex,
      lastKnownUrl: this.lastKnownUrl,
      launchIdentity: this.controlledLaunchIdentity,
      runtimeProfile: this.runtimeProfileObservation,
      profileLockState: profile.lockState,
      profileLockFiles: profile.lockFiles,
      profileOwner: await this.profileOwnerEvidence(
        profile,
        this.controlledLaunchIdentity,
        false,
      ),
    };
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type LifecycleStateOperations = typeof lifecycleStateOperations;
