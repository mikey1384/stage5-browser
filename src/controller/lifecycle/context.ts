import { type BrowserContext, type BrowserProduct, type BrowserSelection, type Frame, type FrameSummary, type Page, randomUUID, sanitizeUrlForJournal, Stage5BrowserError } from '../dependencies.js';
import { boundedValue } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const lifecycleContextOperations = {
  bindContext(context: BrowserContext): void {
    for (const page of context.pages()) {
      this.bindPage(page);
    }
    context.on('page', (page) => {
      this.bindPage(page);
      if (this.preferredPage() === undefined) {
        const pages = context.pages().filter((candidate) => !candidate.isClosed());
        if (pages.length === 1 && pages[0] === page) {
          this.activePage = page;
        }
      }
    });

    context.on('close', () => {
      if (this.context === context) {
        void this.ownershipLease.updatePhase('process_exited');
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
        this.runtimeProfileObservation = null;
        this.controlledStartBoundary = null;
        this.controlledBrowserProcessId = null;
        this.controlledBrowserProcess = null;
        if (this.state !== 'recovering') {
          this.state = 'stopped';
        }
      }
    });
  },

  bindPage(page: Page): void {
    if (this.boundPages.has(page)) {
      return;
    }
    this.boundPages.add(page);
    this.pageDiagnostics.bind(page);
    this.pageLifecycleManager.bind(page);
    page.on('download', (download) => this.downloadManager.capture(download));
    page.on('dialog', (dialog) => this.dialogManager.handle(dialog));
    page.on('framenavigated', (frame) => {
      this.frameDocumentVersions.set(frame, this.documentVersion(frame) + 1);
      this.discardObservedSnapshot(frame);
      this.discardControlInspectionsForFrame(frame);
      this.discardFormInspectionsForFrame(frame);
    });
    page.on('framedetached', (frame) => this.removeFrame(frame));
    page.on('crash', () => {
      this.recoverActivePageAfterLoss(page);
      this.discardObservedTab(page);
      this.removePageFrames(page);
    });
    page.on('close', () => {
      this.recoverActivePageAfterLoss(page);
      this.discardObservedTab(page);
      this.removePageFrames(page);
    });
  },

  selectionFor(browser: BrowserProduct): BrowserSelection {
    return {
      browser,
      executablePath: browser === this.config.browser ? this.config.browserExecutablePath : null,
    };
  },

  usableContext(): BrowserContext | undefined {
    if (this.context === undefined || this.context.isClosed()) {
      return undefined;
    }
    return this.context;
  },

  async ensureContext(): Promise<BrowserContext> {
    if (this.privateFieldHandoff !== null) {
      throw this.privateFieldInProgressError();
    }
    if (this.pendingHandoffRelease !== null || this.authenticationHandoff?.state === 'awaiting_user') {
      throw this.humanBootstrapInProgressError();
    }
    const context = this.usableContext();
    if (context !== undefined) {
      return context;
    }
    await this.start();
    const startedContext = this.usableContext();
    if (startedContext === undefined) {
      throw new Stage5BrowserError('BROWSER_NOT_READY', 'The browser did not become ready.', {
        recoverable: true,
      });
    }
    return startedContext;
  },

  requireContext(): BrowserContext {
    if (this.privateFieldHandoff !== null) {
      throw this.privateFieldInProgressError();
    }
    if (this.pendingHandoffRelease !== null || this.authenticationHandoff?.state === 'awaiting_user') {
      throw this.humanBootstrapInProgressError();
    }
    const context = this.usableContext();
    if (context === undefined) {
      throw new Stage5BrowserError(
        'BROWSER_NOT_READY',
        'The dedicated browser is stopped. This operation will not launch a browser implicitly.',
        {
          recoverable: true,
          details: {
            reason: 'browser_stopped',
            browser: this.selectedBrowser,
            actionDispatched: false,
            suggestedAction: 'Call browser_available, then explicitly call browser_start with the intended browser profile before continuing.',
          },
        },
      );
    }
    return context;
  },

  async ensureActivePage(context: BrowserContext): Promise<Page> {
    await this.reconcileVisiblePage(context);
    const preferred = this.preferredPage();
    if (preferred !== undefined) {
      return preferred;
    }
    if (this.authenticationHandoff !== null) {
      throw new Stage5BrowserError(
        'AUTH_HANDOFF_REQUIRED',
        'The authentication handoff target tab is no longer available.',
        {
          recoverable: true,
          details: {
            reason: 'handoff_target_tab_unavailable',
            suggestedAction: 'Call browser_tabs, then browser_select_tab with the exact visible login tab before continuing.',
          },
        },
      );
    }

    const page = context.pages().findLast((candidate) => !candidate.isClosed()) ?? (await context.newPage());
    this.bindPage(page);
    this.activePage = page;
    await this.persistNativeSelectedPage(page);
    return page;
  },

  preferredPage(): Page | undefined {
    const context = this.usableContext();
    if (context === undefined) {
      return undefined;
    }
    const pages = context.pages().filter((page) => !page.isClosed());
    const preferred = this.authenticationHandoff?.page ?? this.activePage;
    if (preferred !== null && preferred !== undefined && pages.includes(preferred)) {
      return preferred;
    }
    if (pages.length !== 1 || pages[0] === undefined) {
      return undefined;
    }
    const solePage = pages[0];
    this.activePage = solePage;
    if (this.authenticationHandoff !== null) {
      this.authenticationHandoff.page = solePage;
      this.authenticationHandoff.targetOrigin = this.urlOrigin(solePage.url());
    }
    return solePage;
  },

  async reconcileVisiblePage(context: BrowserContext): Promise<void> {
    const handoff = this.authenticationHandoff;
    const pages = context.pages().filter((page) => !page.isClosed());
    if (pages.length === 0) {
      this.activePage = undefined;
      if (handoff !== null) {
        handoff.page = null;
      }
      return;
    }
    if (pages.length === 1 && pages[0] !== undefined) {
      this.activePage = pages[0];
      await this.persistNativeSelectedPage(pages[0]);
      if (handoff !== null) {
        handoff.page = pages[0];
        handoff.targetOrigin = this.urlOrigin(pages[0].url());
      }
      return;
    }
    const preferred = this.preferredPage();
    if (preferred !== undefined && handoff === null) {
      return;
    }
    const visibility = await Promise.all(
      pages.map(async (page) => ({
        page,
        visible: await boundedValue(
          page.evaluate(() => document.visibilityState === 'visible'),
          250,
          false,
        ),
      })),
    );
    const visiblePages = visibility.filter((entry) => entry.visible).map((entry) => entry.page);
    if (visiblePages.length !== 1 || visiblePages[0] === undefined) {
      return;
    }
    this.activePage = visiblePages[0];
    await this.persistNativeSelectedPage(visiblePages[0]);
    if (handoff !== null && visiblePages[0] !== handoff.page) {
      handoff.page = visiblePages[0];
      handoff.targetOrigin = this.urlOrigin(visiblePages[0].url());
    }
  },

  recoverActivePageAfterLoss(lostPage: Page): void {
    const context = this.usableContext();
    const remainingPages = context?.pages().filter(
      (candidate) => candidate !== lostPage && !candidate.isClosed(),
    ) ?? [];
    const soleRemainingPage = remainingPages.length === 1 ? remainingPages[0] : undefined;
    if (this.activePage === lostPage) {
      this.activePage = soleRemainingPage;
    }
    if (this.authenticationHandoff?.page === lostPage) {
      this.authenticationHandoff.page = soleRemainingPage ?? null;
      if (soleRemainingPage !== undefined) {
        this.authenticationHandoff.targetOrigin = this.urlOrigin(soleRemainingPage.url());
      }
    }
  },

  resolveFrame(page: Page, frameId: string | null): Frame {
    if (frameId === null) {
      return page.mainFrame();
    }

    const frame = this.framesById.get(frameId);
    if (frame === undefined || frame.isDetached() || frame.page() !== page) {
      throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The requested frame is no longer attached to the active tab.', {
        details: { frameId, availableFrameCount: page.frames().length },
      });
    }
    return frame;
  },

  frameSummary(frame: Frame, page: Page): FrameSummary {
    const parent = frame.parentFrame();
    return {
      id: this.frameId(frame),
      parentId: parent === null ? null : this.frameId(parent),
      name: frame.name(),
      url: sanitizeUrlForJournal(frame.url()) ?? '<unavailable>',
      isMainFrame: frame === page.mainFrame(),
    };
  },

  frameId(frame: Frame): string {
    const existing = this.frameIds.get(frame);
    if (existing !== undefined) {
      return existing;
    }
    const id = `frame-${randomUUID()}`;
    this.frameIds.set(frame, id);
    this.framesById.set(id, frame);
    return id;
  },

  removeFrame(frame: Frame): void {
    const id = this.frameIds.get(frame);
    if (id !== undefined) {
      this.framesById.delete(id);
    }
    this.discardObservedSnapshot(frame);
    this.discardControlInspectionsForFrame(frame);
  },

  removePageFrames(page: Page): void {
    for (const [id, frame] of this.framesById) {
      if (frame.page() === page) {
        this.framesById.delete(id);
        this.discardObservedSnapshot(frame);
        this.discardControlInspectionsForFrame(frame);
      }
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type LifecycleContextOperations = typeof lifecycleContextOperations;
