import { randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { BrowserContext, Frame, Page } from 'playwright';

import {
  browserAvailability,
  playwrightBrowserType,
  resolveBrowserLaunchTarget,
  SUPPORTED_BROWSER_PRODUCTS,
  type BrowserProduct,
  type BrowserSelection,
} from './browser-provider.js';
import { profileDirForBrowser, type Stage5BrowserConfig } from './config.js';
import {
  inspectProfile,
  launchFailureDiagnostic,
  suggestedActionForReason,
  type BrowserDiagnostics,
  type LaunchFailureDiagnostic,
} from './diagnostics.js';
import { Stage5BrowserError } from './errors.js';
import type {
  BrowserCommandInput,
  BrowserCommandOutput,
  BrowserLifecycleState,
  BrowserStatus,
  AvailableBrowsers,
  FrameSummary,
  PageSummary,
} from './protocol.js';
import { sanitizeUrlForJournal, validateNavigationUrl } from './url-policy.js';

async function boundedValue<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export class BrowserController {
  private context: BrowserContext | undefined;
  private activePage: Page | undefined;
  private state: BrowserLifecycleState = 'stopped';
  private lastKnownUrl: string | null = null;
  private selectedBrowser: BrowserProduct;
  private frameIds = new WeakMap<Frame, string>();
  private readonly framesById = new Map<string, Frame>();
  private boundPages = new WeakSet<Page>();
  private lastLaunchFailure: LaunchFailureDiagnostic | null = null;

  constructor(
    private readonly config: Stage5BrowserConfig,
    initialBrowser: BrowserProduct = config.browser,
  ) {
    this.selectedBrowser = initialBrowser;
  }

  async start(input: BrowserCommandInput<'start'> = {}): Promise<BrowserStatus> {
    if (this.context !== undefined && !this.context.isClosed()) {
      if (input.browser !== undefined && input.browser !== this.selectedBrowser) {
        throw new Stage5BrowserError(
          'OPERATION_FAILED',
          'Another browser profile is already running. Use browser_switch to close it and change browsers.',
          {
            details: {
              currentBrowser: this.selectedBrowser,
              requestedBrowser: input.browser,
              reason: 'browser_already_running',
            },
          },
        );
      }
      this.state = 'running';
      return this.status();
    }

    if (input.browser !== undefined && input.browser !== this.selectedBrowser) {
      await resolveBrowserLaunchTarget(this.selectionFor(input.browser));
      this.selectedBrowser = input.browser;
      this.lastKnownUrl = null;
    }

    this.state = 'starting';
    try {
      const launchTarget = await resolveBrowserLaunchTarget(this.selectionFor(this.selectedBrowser));
      const profileDir = profileDirForBrowser(this.config, this.selectedBrowser);
      await Promise.all([
        mkdir(profileDir, { recursive: true, mode: 0o700 }),
        mkdir(this.config.artifactsDir, { recursive: true, mode: 0o700 }),
        mkdir(path.join(this.config.artifactsDir, 'downloads'), { recursive: true, mode: 0o700 }),
      ]);

      const context = await playwrightBrowserType(launchTarget.engine).launchPersistentContext(profileDir, {
        headless: this.config.headless,
        acceptDownloads: true,
        downloadsPath: path.join(this.config.artifactsDir, 'downloads'),
        viewport: { width: 1440, height: 900 },
        ...(launchTarget.executablePath === null
          ? {}
          : { executablePath: launchTarget.executablePath }),
      });

      context.setDefaultTimeout(this.config.operationTimeoutMs);
      context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
      this.context = context;
      this.bindContext(context);

      const pages = context.pages();
      this.activePage = pages.at(-1) ?? (await context.newPage());
      this.lastKnownUrl = this.activePage.url();
      this.lastLaunchFailure = null;
      this.state = 'running';
      return this.status();
    } catch (error) {
      this.state = 'failed';
      const diagnostic = launchFailureDiagnostic(this.selectedBrowser, error);
      this.lastLaunchFailure = diagnostic;
      if (error instanceof Stage5BrowserError) {
        throw new Stage5BrowserError(error.code, error.message, {
          recoverable: error.recoverable,
          details: {
            ...error.details,
            browser: diagnostic.browser,
            engine: diagnostic.engine,
            reason: diagnostic.reason,
            suggestedAction: diagnostic.suggestedAction,
            occurredAt: diagnostic.occurredAt,
          },
          cause: error,
        });
      }
      throw new Stage5BrowserError('BROWSER_NOT_READY', 'The dedicated browser profile could not be started.', {
        recoverable: true,
        details: { ...diagnostic },
        cause: error,
      });
    }
  }

  async availableBrowsers(): Promise<AvailableBrowsers> {
    const browsers = await Promise.all(
      SUPPORTED_BROWSER_PRODUCTS.map(async (browser) =>
        browserAvailability(this.selectionFor(browser)),
      ),
    );
    return {
      defaultBrowser: this.config.browser,
      currentBrowser: this.selectedBrowser,
      browsers,
    };
  }

  async diagnostics(status?: BrowserStatus): Promise<BrowserDiagnostics> {
    const currentStatus = status ?? (await this.status());
    const availability = await browserAvailability(this.selectionFor(this.selectedBrowser));
    const profilePath = profileDirForBrowser(this.config, this.selectedBrowser);
    return {
      browser: this.selectedBrowser,
      engine: availability.engine,
      availability,
      preflightSuggestedAction: availability.available
        ? null
        : suggestedActionForReason(availability.reason),
      profile: await inspectProfile(profilePath, currentStatus.browserConnected),
      lastLaunchFailure: this.lastLaunchFailure,
    };
  }

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
  }

  async stop(): Promise<BrowserStatus> {
    const context = this.context;
    this.context = undefined;
    this.activePage = undefined;
    this.framesById.clear();
    this.frameIds = new WeakMap<Frame, string>();
    this.boundPages = new WeakSet<Page>();
    this.state = 'stopped';

    if (context !== undefined && !context.isClosed()) {
      await context.close({ reason: 'Stage5 Browser stopped the owned browser context.' });
    }

    return this.status();
  }

  async status(): Promise<BrowserStatus> {
    const context = this.usableContext();
    if (context === undefined) {
      if (this.state !== 'failed' && this.state !== 'recovering') {
        this.state = 'stopped';
      }
      return {
        browser: this.selectedBrowser,
        state: this.state,
        workerPid: process.pid,
        browserConnected: false,
        pages: [],
        activePageIndex: null,
        lastKnownUrl: this.lastKnownUrl,
      };
    }

    const pages = context.pages().filter((page) => !page.isClosed());
    const summaries = await Promise.all(pages.map((page, index) => this.pageSummary(page, index)));
    const activePageIndex = this.activePage === undefined ? -1 : pages.indexOf(this.activePage);
    this.state = 'running';

    return {
      browser: this.selectedBrowser,
      state: this.state,
      workerPid: process.pid,
      browserConnected: context.browser()?.isConnected() ?? true,
      pages: summaries,
      activePageIndex: activePageIndex < 0 ? null : activePageIndex,
      lastKnownUrl: this.lastKnownUrl,
    };
  }

  async open(input: BrowserCommandInput<'open'>): Promise<BrowserCommandOutput<'open'>> {
    const context = await this.ensureContext();
    const page = input.newTab ? await context.newPage() : await this.ensureActivePage(context);
    this.activePage = page;

    const targetUrl = validateNavigationUrl(input.url);
    const startedAt = Date.now();
    const response = await page.goto(targetUrl, {
      waitUntil: 'commit',
      timeout: input.timeoutMs,
    });

    this.lastKnownUrl = page.url();
    let readiness: 'commit' | 'domcontentloaded' = 'commit';
    const warnings: string[] = [];
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(250, input.timeoutMs - elapsed);

    try {
      await page.waitForLoadState('domcontentloaded', {
        timeout: Math.min(this.config.readinessTimeoutMs, remaining),
      });
      readiness = 'domcontentloaded';
    } catch {
      warnings.push('Navigation committed, but DOM readiness did not arrive before the bounded readiness deadline.');
    }

    return {
      page: await this.pageSummary(page),
      responseStatus: response?.status() ?? null,
      readiness,
      warnings,
    };
  }

  async snapshot(input: BrowserCommandInput<'snapshot'>): Promise<BrowserCommandOutput<'snapshot'>> {
    const page = await this.ensureActivePage(await this.ensureContext());
    const frame = this.resolveFrame(page, input.frameId);
    const snapshot = await frame.locator('body').ariaSnapshot({
      mode: 'ai',
      depth: input.depth,
      boxes: input.boxes,
      timeout: input.timeoutMs,
    });

    this.lastKnownUrl = page.url();
    return {
      page: await this.pageSummary(page),
      frame: this.frameSummary(frame, page),
      snapshot,
    };
  }

  async screenshot(input: BrowserCommandInput<'screenshot'>): Promise<BrowserCommandOutput<'screenshot'>> {
    const page = await this.ensureActivePage(await this.ensureContext());
    const screenshotDir = path.join(this.config.artifactsDir, 'screenshots');
    await mkdir(screenshotDir, { recursive: true, mode: 0o700 });
    const screenshotPath = path.join(
      screenshotDir,
      `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.png`,
    );
    const data = await page.screenshot({
      path: screenshotPath,
      type: 'png',
      fullPage: input.fullPage,
      timeout: input.timeoutMs,
    });
    await chmod(screenshotPath, 0o600);

    return {
      page: await this.pageSummary(page),
      path: screenshotPath,
      mimeType: 'image/png',
      dataBase64: data.toString('base64'),
    };
  }

  async tabs(): Promise<BrowserCommandOutput<'tabs'>> {
    const context = await this.ensureContext();
    const pages = context.pages().filter((page) => !page.isClosed());
    const summaries = await Promise.all(pages.map((page, index) => this.pageSummary(page, index)));
    const activePageIndex = this.activePage === undefined ? -1 : pages.indexOf(this.activePage);
    return {
      pages: summaries,
      activePageIndex: activePageIndex < 0 ? null : activePageIndex,
    };
  }

  async selectTab(input: BrowserCommandInput<'selectTab'>): Promise<BrowserCommandOutput<'selectTab'>> {
    const context = await this.ensureContext();
    const pages = context.pages().filter((page) => !page.isClosed());
    const page = pages[input.index];
    if (page === undefined) {
      throw new Stage5BrowserError('TARGET_NOT_FOUND', 'No open tab exists at that index.', {
        details: { requestedIndex: input.index, tabCount: pages.length },
      });
    }

    this.activePage = page;
    await page.bringToFront();
    this.lastKnownUrl = page.url();
    return { page: await this.pageSummary(page, input.index) };
  }

  async frames(): Promise<BrowserCommandOutput<'frames'>> {
    const page = await this.ensureActivePage(await this.ensureContext());
    const frames = page.frames().filter((frame) => !frame.isDetached());
    return {
      page: await this.pageSummary(page),
      frames: frames.map((frame) => this.frameSummary(frame, page)),
    };
  }

  async clickByRole(input: BrowserCommandInput<'clickByRole'>): Promise<BrowserCommandOutput<'clickByRole'>> {
    const page = await this.ensureActivePage(await this.ensureContext());
    const frame = this.resolveFrame(page, input.frameId);
    const locator = frame.getByRole(input.role, { name: input.name, exact: input.exact });
    await this.requireUniqueTarget(locator.count(), input.role, input.name);
    await locator.click({ timeout: input.timeoutMs });
    this.lastKnownUrl = page.url();
    return { page: await this.pageSummary(page), frame: this.frameSummary(frame, page) };
  }

  async fillByRole(input: BrowserCommandInput<'fillByRole'>): Promise<BrowserCommandOutput<'fillByRole'>> {
    const page = await this.ensureActivePage(await this.ensureContext());
    const frame = this.resolveFrame(page, input.frameId);
    const locator = frame.getByRole(input.role, { name: input.name, exact: input.exact });
    await this.requireUniqueTarget(locator.count(), input.role, input.name);
    await locator.fill(input.value, { timeout: input.timeoutMs });
    this.lastKnownUrl = page.url();
    return { page: await this.pageSummary(page), frame: this.frameSummary(frame, page) };
  }

  private bindContext(context: BrowserContext): void {
    for (const page of context.pages()) {
      this.bindPage(page);
    }
    context.on('page', (page) => {
      this.activePage = page;
      this.bindPage(page);
    });

    context.on('close', () => {
      if (this.context === context) {
        this.context = undefined;
        this.activePage = undefined;
        this.framesById.clear();
        this.frameIds = new WeakMap<Frame, string>();
        this.boundPages = new WeakSet<Page>();
        if (this.state !== 'recovering') {
          this.state = 'stopped';
        }
      }
    });
  }

  private bindPage(page: Page): void {
    if (this.boundPages.has(page)) {
      return;
    }
    this.boundPages.add(page);
    page.on('framedetached', (frame) => this.removeFrame(frame));
    page.on('crash', () => {
      if (this.activePage === page) {
        this.activePage = undefined;
      }
      this.removePageFrames(page);
    });
    page.on('close', () => {
      if (this.activePage === page) {
        this.activePage = undefined;
      }
      this.removePageFrames(page);
    });
  }

  private selectionFor(browser: BrowserProduct): BrowserSelection {
    return {
      browser,
      executablePath: browser === this.config.browser ? this.config.browserExecutablePath : null,
    };
  }

  private usableContext(): BrowserContext | undefined {
    if (this.context === undefined || this.context.isClosed()) {
      return undefined;
    }
    return this.context;
  }

  private async ensureContext(): Promise<BrowserContext> {
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
  }

  private async ensureActivePage(context: BrowserContext): Promise<Page> {
    if (this.activePage !== undefined && !this.activePage.isClosed()) {
      return this.activePage;
    }

    const page = context.pages().findLast((candidate) => !candidate.isClosed()) ?? (await context.newPage());
    this.bindPage(page);
    this.activePage = page;
    return page;
  }

  private resolveFrame(page: Page, frameId: string | null): Frame {
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
  }

  private frameSummary(frame: Frame, page: Page): FrameSummary {
    const parent = frame.parentFrame();
    return {
      id: this.frameId(frame),
      parentId: parent === null ? null : this.frameId(parent),
      name: frame.name(),
      url: sanitizeUrlForJournal(frame.url()) ?? '<unavailable>',
      isMainFrame: frame === page.mainFrame(),
    };
  }

  private frameId(frame: Frame): string {
    const existing = this.frameIds.get(frame);
    if (existing !== undefined) {
      return existing;
    }
    const id = `frame-${randomUUID()}`;
    this.frameIds.set(frame, id);
    this.framesById.set(id, frame);
    return id;
  }

  private removeFrame(frame: Frame): void {
    const id = this.frameIds.get(frame);
    if (id !== undefined) {
      this.framesById.delete(id);
    }
  }

  private removePageFrames(page: Page): void {
    for (const [id, frame] of this.framesById) {
      if (frame.page() === page) {
        this.framesById.delete(id);
      }
    }
  }

  private async pageSummary(page: Page, suppliedIndex?: number): Promise<PageSummary> {
    const context = this.usableContext();
    const pages = context?.pages().filter((candidate) => !candidate.isClosed()) ?? [];
    const index = suppliedIndex ?? Math.max(0, pages.indexOf(page));
    const title = await boundedValue(page.title(), 1_000, '<unavailable>');
    const readyState = await boundedValue(
      page.evaluate(() => document.readyState),
      1_000,
      'unknown',
    );

    return {
      index,
      url: page.url(),
      title,
      readyState,
    };
  }

  private async requireUniqueTarget(countPromise: Promise<number>, role: string, name: string): Promise<void> {
    const count = await countPromise;
    if (count === 0) {
      throw new Stage5BrowserError('TARGET_NOT_FOUND', 'No element matched the requested role and accessible name.', {
        details: { role, name },
      });
    }
    if (count > 1) {
      throw new Stage5BrowserError('AMBIGUOUS_TARGET', 'Multiple elements matched; Stage5 Browser will not choose one arbitrarily.', {
        details: { role, name, matchCount: count },
      });
    }
  }
}
