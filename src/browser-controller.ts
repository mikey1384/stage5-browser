import { randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { chromium, type BrowserContext, type Page } from 'playwright';

import type { Stage5BrowserConfig } from './config.js';
import { Stage5BrowserError } from './errors.js';
import type {
  BrowserCommandInput,
  BrowserCommandOutput,
  BrowserLifecycleState,
  BrowserStatus,
  PageSummary,
} from './protocol.js';
import { validateNavigationUrl } from './url-policy.js';

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

  constructor(private readonly config: Stage5BrowserConfig) {}

  async start(): Promise<BrowserStatus> {
    if (this.context !== undefined && !this.context.isClosed()) {
      this.state = 'running';
      return this.status();
    }

    this.state = 'starting';
    try {
      await Promise.all([
        mkdir(this.config.profileDir, { recursive: true, mode: 0o700 }),
        mkdir(this.config.artifactsDir, { recursive: true, mode: 0o700 }),
        mkdir(path.join(this.config.artifactsDir, 'downloads'), { recursive: true, mode: 0o700 }),
      ]);

      const context = await chromium.launchPersistentContext(this.config.profileDir, {
        headless: this.config.headless,
        acceptDownloads: true,
        downloadsPath: path.join(this.config.artifactsDir, 'downloads'),
        viewport: { width: 1440, height: 900 },
      });

      context.setDefaultTimeout(this.config.operationTimeoutMs);
      context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
      this.context = context;
      this.bindContext(context);

      const pages = context.pages();
      this.activePage = pages.at(-1) ?? (await context.newPage());
      this.lastKnownUrl = this.activePage.url();
      this.state = 'running';
      return this.status();
    } catch (error) {
      this.state = 'failed';
      throw new Stage5BrowserError('BROWSER_NOT_READY', 'The dedicated browser profile could not be started.', {
        recoverable: true,
        cause: error,
      });
    }
  }

  async stop(): Promise<BrowserStatus> {
    const context = this.context;
    this.context = undefined;
    this.activePage = undefined;
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
    const snapshot = await page.locator('body').ariaSnapshot({
      mode: 'ai',
      depth: input.depth,
      boxes: input.boxes,
      timeout: input.timeoutMs,
    });

    this.lastKnownUrl = page.url();
    return {
      page: await this.pageSummary(page),
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

  async clickByRole(input: BrowserCommandInput<'clickByRole'>): Promise<BrowserCommandOutput<'clickByRole'>> {
    const page = await this.ensureActivePage(await this.ensureContext());
    const locator = page.getByRole(input.role, { name: input.name, exact: input.exact });
    await this.requireUniqueTarget(locator.count(), input.role, input.name);
    await locator.click({ timeout: input.timeoutMs });
    this.lastKnownUrl = page.url();
    return { page: await this.pageSummary(page) };
  }

  async fillByRole(input: BrowserCommandInput<'fillByRole'>): Promise<BrowserCommandOutput<'fillByRole'>> {
    const page = await this.ensureActivePage(await this.ensureContext());
    const locator = page.getByRole(input.role, { name: input.name, exact: input.exact });
    await this.requireUniqueTarget(locator.count(), input.role, input.name);
    await locator.fill(input.value, { timeout: input.timeoutMs });
    this.lastKnownUrl = page.url();
    return { page: await this.pageSummary(page) };
  }

  private bindContext(context: BrowserContext): void {
    context.on('page', (page) => {
      this.activePage = page;
      page.on('crash', () => {
        if (this.activePage === page) {
          this.activePage = undefined;
        }
      });
      page.on('close', () => {
        if (this.activePage === page) {
          this.activePage = undefined;
        }
      });
    });

    context.on('close', () => {
      if (this.context === context) {
        this.context = undefined;
        this.activePage = undefined;
        if (this.state !== 'recovering') {
          this.state = 'stopped';
        }
      }
    });
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
    this.activePage = page;
    return page;
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
