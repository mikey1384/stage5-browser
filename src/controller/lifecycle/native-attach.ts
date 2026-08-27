import { type Browser, BROWSER_ENGINES, type BrowserContext, type BrowserLaunchIdentity, type BrowserProduct, type BrowserStatus, chromiumProfileOwnerProcessId, nativeControlEndpoint, type NativeControlRecord, type NativeReattachObservation, observeLaunchedBrowserProcess, type Page, playwrightBrowserType, processIsRunning, profileDirForBrowser, sanitizeUrlForJournal, Stage5BrowserError, writeNativeControlRecord } from '../dependencies.js';
import { boundedValue } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

const NATIVE_TARGET_SETTLE_LIMIT_MS = 750;
const NATIVE_TARGET_SETTLE_INTERVAL_MS = 50;
const MAX_REATTACH_PAGE_COUNT = 100;

function boundedPageCount(pages: Page[]): number {
  return Math.min(pages.length, MAX_REATTACH_PAGE_COUNT);
}

export const lifecycleNativeAttachOperations = {
  async attachToNativeChromium(
    record: NativeControlRecord,
    launchIdentity: BrowserLaunchIdentity,
    authenticationProbeTargetOrigin: string | null,
  ): Promise<BrowserStatus> {
    const browser = await playwrightBrowserType('chromium').connectOverCDP(
      nativeControlEndpoint(record),
      {
        artifactsDir: this.config.artifactsDir,
        isLocal: true,
        noDefaults: true,
        timeout: this.config.workerStartupTimeoutMs,
      },
    );
    const context = browser.contexts()[0];
    if (context === undefined) {
      await browser.close();
      throw new Stage5BrowserError(
        'BROWSER_NOT_READY',
        'The native Stage5 browser did not expose its persistent default context.',
        {
          recoverable: true,
          details: {
            reason: 'browser_process_exited',
            suggestedAction: 'Keep the dedicated Stage5 browser open and retry once after its login page finishes loading.',
          },
        },
      );
    }

    this.nativeAttachedBrowser = browser;
    this.nativeControlRecord = record;
    browser.once('disconnected', () => {
      if (this.nativeAttachedBrowser === browser) {
        this.clearControlledBrowserState();
      }
    });
    try {
      const status = await this.activateControlledContext(
        context,
        launchIdentity,
        'chromium',
        authenticationProbeTargetOrigin,
      );
      if (status.runtimeProfile?.matchesConfigured === false) {
        throw new Stage5BrowserError(
          'AUTH_NOT_PERSISTED',
          'The continuously running browser reported a different profile from the Stage5 control record.',
          {
            recoverable: true,
            details: {
              reason: 'auth_runtime_profile_mismatch',
              runtimeProfile: status.runtimeProfile,
              suggestedAction: 'Stop before account actions and inspect the reported configured and runtime profile paths.',
            },
          },
        );
      }
      const durableRecord = {
        ...(this.nativeControlRecord ?? record),
        state: 'controlled' as const,
      };
      const profileRoot = launchIdentity.profile.userDataDir;
      if (profileRoot === null) {
        throw new Stage5BrowserError(
          'BROWSER_NOT_READY',
          'The native Chromium control record has no configured user-data directory.',
          {
            recoverable: true,
            details: {
              reason: 'profile_locked',
              suggestedAction: 'Stop before attaching and inspect the configured Chromium profile binding.',
            },
          },
        );
      }
      await writeNativeControlRecord(profileRoot, durableRecord);
      this.nativeControlRecord = durableRecord;
      const browserProcess = await observeLaunchedBrowserProcess(
        launchIdentity,
        new Set<number>(),
        Math.min(this.config.readinessTimeoutMs, 1_000),
      );
      if (browserProcess === null || browserProcess.processId !== durableRecord.processId) {
        throw new Stage5BrowserError(
          'BROWSER_NOT_READY',
          'The native control endpoint connected, but its exact process identity could not be bound to the durable Stage5 ownership lease.',
          {
            recoverable: true,
            details: {
              reason: 'ownership_unverified',
              suggestedAction: 'Leave the dedicated browser open and call browser_diagnostics. Do not delete locks or attach to another process.',
            },
          },
        );
      }
      await this.ownershipLease.establish({
        profileRoot,
        identity: launchIdentity,
        browserProcess,
        controlMode: 'native_cdp',
        phase: 'owned_active',
      });
      this.controlledBrowserProcess = browserProcess;
      return this.status();
    } catch (error) {
      await browser.close().catch(() => undefined);
      if (this.nativeAttachedBrowser === browser) {
        this.clearControlledBrowserState();
      }
      throw error;
    }
  },

  async activateControlledContext(
    context: BrowserContext,
    launchIdentity: BrowserLaunchIdentity,
    engine: (typeof BROWSER_ENGINES)[BrowserProduct],
    authenticationProbeTargetOrigin: string | null,
  ): Promise<BrowserStatus> {
    context.setDefaultTimeout(this.config.operationTimeoutMs);
    context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    this.context = context;
    this.controlledLaunchIdentity = launchIdentity;
    this.controlledBrowserProcessId = engine === 'chromium'
      ? this.nativeControlRecord?.processId
        ?? (launchIdentity.profile.userDataDir === null
          ? null
          : await chromiumProfileOwnerProcessId(launchIdentity.profile.userDataDir))
      : null;
    this.bindContext(context);

    const settledSelection = await this.settleNativeSelectedPage(context);
    const pages = settledSelection.pages;
    const restoredSelectedPage = settledSelection.page;
    this.nativeReattachObservation = settledSelection.observation;
    if (
      this.nativeControlRecord?.selectedTargetId !== undefined
      && this.nativeControlRecord.selectedTargetId !== null
      && restoredSelectedPage === null
    ) {
      throw new Stage5BrowserError('BROWSER_NOT_READY', 'The exact selected native browser page is no longer available.', {
        recoverable: true,
        details: {
          reason: 'selected_page_unavailable_after_reattach',
          actionDispatched: false,
          nativeReattach: settledSelection.observation,
          suggestedAction: 'Wait for the browser tabs to finish settling, then call browser_start once. If exact-target resolution remains unresolved, stop and inspect browser_execution_traces; Stage5 Browser will not choose another page by URL, title, or position.',
        },
      });
    }
    this.activePage = restoredSelectedPage ?? pages.at(-1) ?? (await context.newPage());
    await this.recordNativeContinuityAfterAttach(this.activePage);
    const activePageBeforeRuntimeInspection = this.activePage;
    const initialPages = context.pages().filter((page) => !page.isClosed());
    const [runtimeProfile, controlledStartStorage, navigatorWebdriver] = await Promise.all([
      this.runtimeProfileInspector(context, launchIdentity.profile, engine),
      authenticationProbeTargetOrigin === null
        ? Promise.resolve(null)
        : this.controlledProfileStorageInspector(
            launchIdentity.profile,
            engine,
            authenticationProbeTargetOrigin,
            (urls) => context.cookies(urls).then((cookies) => cookies.map((cookie) => ({
              domain: cookie.domain,
              name: cookie.name,
              expires: cookie.expires,
            }))),
          ),
      authenticationProbeTargetOrigin === null
        ? Promise.resolve(null)
        : boundedValue(this.activePage.evaluate(() => navigator.webdriver), 500, null),
    ]);
    this.activePage = activePageBeforeRuntimeInspection;
    await this.persistNativeSelectedPage(this.activePage);
    await this.restoreNativeActionAfterAttach(this.activePage);
    await this.restoreNativePageStateRiskAfterAttach(this.activePage);
    this.runtimeProfileObservation = runtimeProfile;
    const targetOriginLoadedAtControlledStart = authenticationProbeTargetOrigin !== null
      && (
        initialPages.some(
          (candidate) => this.urlOrigin(candidate.url()) === authenticationProbeTargetOrigin,
        )
        || context.pages().some(
          (candidate) => !candidate.isClosed()
            && this.urlOrigin(candidate.url()) === authenticationProbeTargetOrigin,
        )
      );
    this.controlledStartBoundary = authenticationProbeTargetOrigin === null || controlledStartStorage === null
      ? null
      : {
          targetOrigin: authenticationProbeTargetOrigin,
          storage: controlledStartStorage,
          targetOriginLoaded: targetOriginLoadedAtControlledStart,
          navigatorWebdriver,
        };
    this.lastKnownUrl = this.activePage.url();
    this.lastLaunchFailure = null;
    this.state = 'running';
    return this.status();
  },

  async settleNativeSelectedPage(context: BrowserContext): Promise<{
    page: Page | null;
    pages: Page[];
    observation: NativeReattachObservation | null;
  }> {
    const initialPages = context.pages().filter((page) => !page.isClosed());
    if (this.nativeControlRecord === null) {
      return { page: null, pages: initialPages, observation: null };
    }
    const selectedTargetRecorded = typeof this.nativeControlRecord.selectedTargetId === 'string';
    if (!selectedTargetRecorded) {
      return {
        page: null,
        pages: initialPages,
        observation: {
          selectedTargetRecorded: false,
          initialPageCount: boundedPageCount(initialPages),
          finalPageCount: boundedPageCount(initialPages),
          selectedTargetInitiallyObserved: null,
          selectedTargetObserved: null,
          discoveryWaitAttempted: false,
          discoveryWaitMs: 0,
          resolution: 'not_recorded',
        },
      };
    }

    let page = await this.restoreNativeSelectedPage(initialPages);
    if (page !== null) {
      return {
        page,
        pages: initialPages,
        observation: {
          selectedTargetRecorded: true,
          initialPageCount: boundedPageCount(initialPages),
          finalPageCount: boundedPageCount(initialPages),
          selectedTargetInitiallyObserved: true,
          selectedTargetObserved: true,
          discoveryWaitAttempted: false,
          discoveryWaitMs: 0,
          resolution: 'initial_exact',
        },
      };
    }

    const waitBudgetMs = Math.max(
      0,
      Math.min(this.config.readinessTimeoutMs, NATIVE_TARGET_SETTLE_LIMIT_MS),
    );
    const waitStartedAt = Date.now();
    let pages = initialPages;
    while (page === null && Date.now() - waitStartedAt < waitBudgetMs) {
      const remainingMs = waitBudgetMs - (Date.now() - waitStartedAt);
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(NATIVE_TARGET_SETTLE_INTERVAL_MS, remainingMs),
      ));
      pages = context.pages().filter((candidate) => !candidate.isClosed());
      page = await this.restoreNativeSelectedPage(pages);
    }
    const discoveryWaitMs = Math.min(
      NATIVE_TARGET_SETTLE_LIMIT_MS,
      Math.max(0, Date.now() - waitStartedAt),
    );
    return {
      page,
      pages,
      observation: {
        selectedTargetRecorded: true,
        initialPageCount: boundedPageCount(initialPages),
        finalPageCount: boundedPageCount(pages),
        selectedTargetInitiallyObserved: false,
        selectedTargetObserved: page !== null,
        discoveryWaitAttempted: waitBudgetMs > 0,
        discoveryWaitMs,
        resolution: page === null ? 'unresolved' : 'settled_exact',
      },
    };
  },

  async restoreNativeSelectedPage(pages: Page[]): Promise<Page | null> {
    const targetId = this.nativeControlRecord?.selectedTargetId;
    if (targetId === undefined || targetId === null) return null;
    for (const page of pages) {
      if (await this.chromiumTargetId(page) === targetId) return page;
    }
    return null;
  },

  async persistNativeSelectedPage(page: Page): Promise<void> {
    const record = this.nativeControlRecord;
    if (record === null || page.isClosed()) return;
    const [selectedTargetId, selectedDocumentId] = await Promise.all([
      this.chromiumTargetId(page),
      this.chromiumDocumentId(page),
    ]);
    if (selectedTargetId === null) return;
    if (
      record.selectedTargetId === selectedTargetId
      && (selectedDocumentId === null || record.selectedDocumentId === selectedDocumentId)
    ) return;
    const {
      retainedAction: _staleRetainedAction,
      retainedPageStateRisk: _stalePageStateRisk,
      ...recordWithoutRetainedState
    } = record;
    const updated: NativeControlRecord = {
      ...recordWithoutRetainedState,
      selectedTargetId,
      ...(selectedDocumentId === null ? {} : { selectedDocumentId }),
    };
    try {
      await writeNativeControlRecord(
        profileDirForBrowser(this.config, this.selectedBrowser),
        updated,
      );
      this.nativeControlRecord = updated;
    } catch {
      // The current in-memory selection remains authoritative. A later explicit
      // tab selection/open will retry persistence without exposing the target ID.
    }
  },

  async recordNativeContinuityAfterAttach(page: Page): Promise<void> {
    const record = this.nativeControlRecord;
    if (
      record?.selectedTargetId === undefined
      || record.selectedTargetId === null
      || record.selectedDocumentId === undefined
      || record.selectedDocumentId === null
      || page.isClosed()
    ) return;
    const [selectedTargetId, selectedDocumentId] = await Promise.all([
      this.chromiumTargetId(page),
      this.chromiumDocumentId(page),
    ]);
    if (
      selectedTargetId === record.selectedTargetId
      && selectedDocumentId !== null
      && selectedDocumentId !== record.selectedDocumentId
    ) {
      await this.pageLifecycleManager.recordReattachedDocumentReplacement(page);
    }
  },

  async restoreNativeActionAfterAttach(page: Page): Promise<void> {
    const retained = this.nativeControlRecord?.retainedAction;
    if (retained === undefined || page.isClosed()) return;
    const [selectedTargetId, documentId] = await Promise.all([
      this.chromiumTargetId(page),
      this.chromiumDocumentId(page),
    ]);
    if (
      selectedTargetId === null ||
      documentId === null ||
      selectedTargetId !== retained.selectedTargetId ||
      documentId !== retained.documentId
    ) return;
    const currentUrl = sanitizeUrlForJournal(page.url()) ?? null;
    if (currentUrl !== retained.diagnostic.pageUrl) return;
    this.pageDiagnostics.restoreAction(page, retained.diagnostic);
  },

  async chromiumDocumentId(page: Page): Promise<string | null> {
    let session: Awaited<ReturnType<BrowserContext['newCDPSession']>> | null = null;
    try {
      session = await page.context().newCDPSession(page);
      const response = await session.send('Page.getFrameTree') as {
        frameTree?: { frame?: { loaderId?: unknown } };
      };
      const documentId = response.frameTree?.frame?.loaderId;
      return typeof documentId === 'string' && documentId.length > 0 && documentId.length <= 256
        ? documentId
        : null;
    } catch {
      return null;
    } finally {
      await session?.detach().catch(() => undefined);
    }
  },

  async chromiumTargetId(page: Page): Promise<string | null> {
    let session: Awaited<ReturnType<BrowserContext['newCDPSession']>> | null = null;
    try {
      session = await page.context().newCDPSession(page);
      const response = await session.send('Target.getTargetInfo') as {
        targetInfo?: { targetId?: unknown };
      };
      const targetId = response.targetInfo?.targetId;
      return typeof targetId === 'string' && targetId.length > 0 && targetId.length <= 256
        ? targetId
        : null;
    } catch {
      return null;
    } finally {
      await session?.detach().catch(() => undefined);
    }
  },

  async closeOwnedNativeBrowser(
    context: BrowserContext | undefined,
    browser: Browser,
    record: NativeControlRecord,
  ): Promise<void> {
    const page = context?.pages().find((candidate) => !candidate.isClosed());
    if (context !== undefined && page !== undefined) {
      try {
        const session = await context.newCDPSession(page);
        await session.send('Browser.close');
      } catch {
        // The exact owned PID below remains the bounded fallback.
      }
    }
    await browser.close().catch(() => undefined);

    const deadline = Date.now() + 3_000;
    while (processIsRunning(record.processId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (processIsRunning(record.processId)) {
      throw new Stage5BrowserError(
        'OPERATION_FAILED',
        'The dedicated native browser did not confirm a clean exit after the close request.',
        {
          recoverable: true,
          details: {
            reason: 'native_browser_close_unconfirmed',
            suggestedAction: 'Close the visibly identified dedicated Stage5 browser normally, then call browser_start once. Stage5 Browser will not signal an unverified PID.',
          },
        },
      );
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type LifecycleNativeAttachOperations = typeof lifecycleNativeAttachOperations;
