import { randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { BrowserContext, Frame, Locator, Page, Request, Response } from 'playwright';

import {
  BROWSER_ENGINES,
  browserAvailability,
  playwrightBrowserType,
  resolveBrowserLaunchTarget,
  SUPPORTED_BROWSER_PRODUCTS,
  type BrowserProduct,
  type BrowserSelection,
} from './browser-provider.js';
import { profileDirForBrowser, type Stage5BrowserConfig } from './config.js';
import {
  browserLaunchPolicyDiagnostics,
  inspectProfile,
  launchFailureDiagnostic,
  suggestedActionForReason,
  type BrowserDiagnostics,
  type LaunchFailureDiagnostic,
} from './diagnostics.js';
import { Stage5BrowserError } from './errors.js';
import {
  actionDiagnosticForFailure,
  inspectTargetState,
  PageDiagnosticBuffer,
  privacyFingerprint,
  type SafeTargetState,
  type SanitizedActionDiagnostic,
} from './page-diagnostics.js';
import {
  compareProfileExitMarker,
  humanBrowserLaunchPolicy,
  inspectProfileShutdown,
  isStage5HandoffMarkerUrl,
  NativeHumanBrowserLauncher,
  waitForProfileUnlock,
  type HumanBrowserLauncher,
  type HumanBrowserSession,
  type ProfileShutdownDecision,
  type ProfileShutdownInspection,
} from './human-auth-bootstrap.js';
import {
  compareAuthenticationStorage,
  controlledProfileArguments,
  inspectControlledProfileStorage,
  inspectProfileStorage,
  inspectRuntimeProfile,
  launchIdentityForTarget,
  profileBindingForBrowser,
  sameLaunchIdentity,
  type BrowserLaunchIdentity,
  type ProfileStorageInspection,
  type RuntimeProfileObservation,
} from './profile-binding.js';
import type {
  AuthenticationBoundaryOutcome,
  BrowserCommandInput,
  BrowserCommandOutput,
  BrowserLifecycleState,
  BrowserStatus,
  AvailableBrowsers,
  AuthenticationStatus,
  ClickPostcondition,
  FrameSummary,
  NavigationWarning,
  PageSummary,
  PostconditionCheck,
  PostconditionResult,
  RedirectHop,
  ScrollPosition,
  UrlExpectation,
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

interface ObservedSnapshot {
  id: string;
  documentVersion: number;
  refs: Set<string>;
}

interface AuthenticationHandoff {
  mode: 'human_bootstrap';
  state: 'awaiting_user' | 'ready_for_agent_verification';
  targetOrigin: string | null;
  requestedAt: string;
  resumedAt: string | null;
  page: Page | null;
  profileDir: string;
  launchIdentity: BrowserLaunchIdentity;
  handoffLabel: string;
  targetUrl: string;
  beforeUrl: string | null;
  beforeSemanticFingerprint: string | null;
  beforeStorage: ProfileStorageInspection;
  beforeProfileShutdown: ProfileShutdownInspection;
  session: HumanBrowserSession;
  profileShutdown: ProfileShutdownDecision | null;
  shutdownOverrideOffered: boolean;
}

interface ControlledStartBoundaryObservation {
  targetOrigin: string;
  storage: ProfileStorageInspection;
  targetOriginLoaded: boolean;
  navigatorWebdriver: boolean | null;
}

interface SnapshotRoot {
  locator: Locator;
  scope: 'document' | 'modal';
  visibleModalCount: number;
  warnings: BrowserCommandOutput<'snapshot'>['warnings'];
}

const MAX_SEARCHABLE_TEXT_CHARACTERS = 2_000_000;
const TEXT_SNIPPET_CONTEXT = 100;

export class BrowserController {
  private context: BrowserContext | undefined;
  private activePage: Page | undefined;
  private state: BrowserLifecycleState = 'stopped';
  private lastKnownUrl: string | null = null;
  private selectedBrowser: BrowserProduct;
  private frameIds = new WeakMap<Frame, string>();
  private readonly framesById = new Map<string, Frame>();
  private frameDocumentVersions = new WeakMap<Frame, number>();
  private readonly observedSnapshots = new Map<Frame, ObservedSnapshot>();
  private readonly pageDiagnostics = new PageDiagnosticBuffer();
  private boundPages = new WeakSet<Page>();
  private lastLaunchFailure: LaunchFailureDiagnostic | null = null;
  private authenticationHandoff: AuthenticationHandoff | null = null;
  private lastHandoffOutcome: AuthenticationBoundaryOutcome | null = null;
  private controlledLaunchIdentity: BrowserLaunchIdentity | null = null;
  private runtimeProfileObservation: RuntimeProfileObservation | null = null;
  private controlledStartBoundary: ControlledStartBoundaryObservation | null = null;

  constructor(
    private readonly config: Stage5BrowserConfig,
    initialBrowser: BrowserProduct = config.browser,
    private readonly humanBrowserLauncher: HumanBrowserLauncher = new NativeHumanBrowserLauncher(),
    private readonly profileStorageInspector: typeof inspectProfileStorage = inspectProfileStorage,
    private readonly controlledProfileStorageInspector: typeof inspectControlledProfileStorage = inspectControlledProfileStorage,
    private readonly runtimeProfileInspector: typeof inspectRuntimeProfile = inspectRuntimeProfile,
  ) {
    this.selectedBrowser = initialBrowser;
  }

  async start(
    input: BrowserCommandInput<'start'> = {},
    authenticationProbeTargetOrigin: string | null = null,
  ): Promise<BrowserStatus> {
    if (this.authenticationHandoff?.state === 'awaiting_user') {
      throw this.humanBootstrapInProgressError();
    }
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
      const enableChromiumSandbox = launchTarget.engine === 'chromium' && process.platform === 'darwin';
      const profileDir = profileDirForBrowser(this.config, this.selectedBrowser);
      const launchIdentity = launchIdentityForTarget(launchTarget, profileDir);
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
        ...(launchTarget.engine === 'chromium'
          ? { args: controlledProfileArguments(launchIdentity.profile) }
          : {}),
        ...(enableChromiumSandbox ? { chromiumSandbox: true } : {}),
        ...(launchTarget.executablePath === null
          ? {}
          : { executablePath: launchTarget.executablePath }),
      });

      context.setDefaultTimeout(this.config.operationTimeoutMs);
      context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
      this.context = context;
      this.controlledLaunchIdentity = launchIdentity;
      this.bindContext(context);

      const pages = context.pages();
      this.activePage = pages.at(-1) ?? (await context.newPage());
      const activePageBeforeRuntimeInspection = this.activePage;
      const initialPages = context.pages().filter((page) => !page.isClosed());
      const [runtimeProfile, controlledStartStorage, navigatorWebdriver] = await Promise.all([
        this.runtimeProfileInspector(context, launchIdentity.profile, launchTarget.engine),
        authenticationProbeTargetOrigin === null
          ? Promise.resolve(null)
          : this.controlledProfileStorageInspector(
              launchIdentity.profile,
              launchTarget.engine,
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
    const profileBinding = currentStatus.launchIdentity?.profile
      ?? profileBindingForBrowser(profilePath, availability.engine);
    const page = this.preferredPage();
    const humanBootstrapRunning = this.authenticationHandoff?.state === 'awaiting_user';
    const controlMode = humanBootstrapRunning
      ? 'human_bootstrap'
      : this.usableContext() === undefined
        ? 'none'
        : 'playwright';
    const navigatorWebdriver = controlMode === 'playwright' && page !== undefined
      ? await boundedValue(page.evaluate(() => navigator.webdriver), 500, null)
      : null;
    return {
      browser: this.selectedBrowser,
      engine: availability.engine,
      availability,
      preflightSuggestedAction: availability.available
        ? null
        : suggestedActionForReason(availability.reason),
      profile: await inspectProfile(profilePath, currentStatus.browserConnected || humanBootstrapRunning),
      profileBinding,
      launchIdentity: currentStatus.launchIdentity,
      runtimeProfile: currentStatus.runtimeProfile,
      authenticationStorageBoundary: this.lastHandoffOutcome?.storageContinuity ?? null,
      lastLaunchFailure: this.lastLaunchFailure,
      launchPolicy: browserLaunchPolicyDiagnostics(
        this.selectedBrowser,
        this.config.headless,
        availability.source,
      ),
      automationExposure: {
        controlMode,
        controlledByPlaywright: controlMode === 'playwright',
        enableAutomationArgument: controlMode === 'human_bootstrap'
          ? 'absent'
          : controlMode === 'playwright' && availability.engine === 'chromium'
            ? 'present'
            : 'not_applicable',
        navigatorWebdriver,
        navigatorWebdriverObserved: controlMode === 'playwright' && page !== undefined,
        observation: controlMode === 'human_bootstrap'
          ? 'uncontrolled_browser_not_instrumented'
          : controlMode === 'playwright'
            ? 'controlled_page_runtime'
            : 'no_browser_running',
      },
      page: page === undefined ? null : this.pageDiagnostics.snapshot(page),
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
    if (
      this.authenticationHandoff?.state === 'awaiting_user' &&
      this.authenticationHandoff.session.state().running
    ) {
      throw this.humanBootstrapInProgressError(
        'The human authentication browser must be closed normally by the user; Stage5 Browser will not force-stop it.',
      );
    }
    const context = this.context;
    this.context = undefined;
    this.activePage = undefined;
    this.framesById.clear();
    this.observedSnapshots.clear();
    this.frameIds = new WeakMap<Frame, string>();
    this.frameDocumentVersions = new WeakMap<Frame, number>();
    this.boundPages = new WeakSet<Page>();
    this.authenticationHandoff = null;
    this.controlledLaunchIdentity = null;
    this.runtimeProfileObservation = null;
    this.controlledStartBoundary = null;
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
        launchIdentity: this.authenticationHandoff?.launchIdentity ?? this.controlledLaunchIdentity,
        runtimeProfile: null,
      };
    }

    await this.reconcileVisiblePage(context);
    const pages = context.pages().filter((page) => !page.isClosed());
    const summaries = await Promise.all(pages.map((page, index) => this.pageSummary(page, index)));
    const reportedActivePage = this.preferredPage();
    const activePageIndex = reportedActivePage === undefined ? -1 : pages.indexOf(reportedActivePage);
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
    };
  }

  async open(input: BrowserCommandInput<'open'>): Promise<BrowserCommandOutput<'open'>> {
    const context = await this.ensureContext();
    const page = input.newTab ? await context.newPage() : await this.ensureActivePage(context);
    this.activePage = page;
    if (
      this.authenticationHandoff?.state === 'awaiting_user' &&
      !this.authenticationHandoff.session.state().running &&
      this.authenticationHandoff.profileShutdown?.state === 'unclean'
    ) {
      this.authenticationHandoff = null;
    }

    if (this.authenticationHandoff !== null) {
      this.authenticationHandoff.page = page;
    }

    const targetUrl = validateNavigationUrl(input.url);
    const requestedUrl = this.safeObservedUrl(targetUrl);
    const observedUrls: string[] = [];
    const recordObservedUrl = (value: string): void => {
      const sanitized = this.safeObservedUrl(value);
      if (observedUrls.at(-1) !== sanitized) {
        observedUrls.push(sanitized);
      }
    };
    recordObservedUrl(targetUrl);
    const onFrameNavigated = (frame: Frame): void => {
      if (frame === page.mainFrame()) {
        recordObservedUrl(frame.url());
      }
    };
    page.on('framenavigated', onFrameNavigated);

    const startedAt = Date.now();
    let response: Response | null;
    try {
      response = await page.goto(targetUrl, {
        waitUntil: 'commit',
        timeout: input.timeoutMs,
      });
    } catch (error) {
      page.off('framenavigated', onFrameNavigated);
      throw error;
    }

    this.lastKnownUrl = page.url();
    let readiness: 'commit' | 'domcontentloaded' = 'commit';
    const warnings: NavigationWarning[] = [];
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(250, input.timeoutMs - elapsed);

    try {
      await page.waitForLoadState('domcontentloaded', {
        timeout: Math.min(this.config.readinessTimeoutMs, remaining),
      });
      readiness = 'domcontentloaded';
    } catch {
      warnings.push({
        code: 'dom_readiness_timeout',
        message: 'Navigation committed, but DOM readiness did not arrive before the bounded readiness deadline.',
        status: response?.status() ?? null,
        suggestedAction: 'Inspect the committed page before deciding whether another navigation is necessary.',
      });
    }

    const requestedStabilizationMs = input.stabilizationMs ?? 750;
    const stabilizationMs = Math.min(
      requestedStabilizationMs,
      Math.max(0, input.timeoutMs - (Date.now() - startedAt)),
    );
    if (stabilizationMs > 0) {
      await page.waitForTimeout(stabilizationMs);
    }
    page.off('framenavigated', onFrameNavigated);
    recordObservedUrl(page.url());
    this.lastKnownUrl = page.url();
    if (this.authenticationHandoff !== null) {
      this.authenticationHandoff.targetOrigin = this.urlOrigin(page.url());
    }

    const responseStatus = response?.status() ?? null;
    warnings.push(...this.httpWarnings(responseStatus));
    const redirectChain = await this.redirectChain(response);
    const finalUrl = this.safeObservedUrl(page.url());

    return {
      page: await this.pageSummary(page),
      requestedUrl,
      finalUrl,
      responseStatus,
      readiness,
      redirected: redirectChain.length > 0 || finalUrl !== requestedUrl,
      redirectChain,
      observedUrls,
      stabilizationMs,
      warnings,
    };
  }

  async snapshot(input: BrowserCommandInput<'snapshot'>): Promise<BrowserCommandOutput<'snapshot'>> {
    const page = await this.ensureActivePage(await this.ensureContext());
    const frame = this.resolveFrame(page, input.frameId);
    const root = await this.snapshotRoot(frame);
    const snapshot = await root.locator.ariaSnapshot({
      mode: 'ai',
      depth: input.depth,
      boxes: input.boxes,
      timeout: input.timeoutMs,
    });
    const refs = new Set(snapshot.match(/\[ref=([^\]]+)\]/g)?.map((value) => value.slice(5, -1)) ?? []);
    const snapshotId = randomUUID();
    this.observedSnapshots.set(frame, {
      id: snapshotId,
      documentVersion: this.documentVersion(frame),
      refs,
    });

    this.lastKnownUrl = page.url();
    if (
      this.authenticationHandoff?.state === 'ready_for_agent_verification' &&
      this.authenticationHandoff.page === page
    ) {
      this.authenticationHandoff = null;
    }
    return {
      page: await this.pageSummary(page),
      frame: this.frameSummary(frame, page),
      snapshotId,
      refCount: refs.size,
      scope: root.scope,
      visibleModalCount: root.visibleModalCount,
      warnings: root.warnings,
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
    await this.reconcileVisiblePage(context);
    const pages = context.pages().filter((page) => !page.isClosed());
    const summaries = await Promise.all(pages.map((page, index) => this.pageSummary(page, index)));
    const reportedActivePage = this.preferredPage();
    const activePageIndex = reportedActivePage === undefined ? -1 : pages.indexOf(reportedActivePage);
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
    const authenticationTargetUpdated = this.authenticationHandoff !== null;
    if (this.authenticationHandoff !== null) {
      this.authenticationHandoff.page = page;
      this.authenticationHandoff.targetOrigin = this.urlOrigin(page.url());
    }
    await page.bringToFront();
    this.lastKnownUrl = page.url();
    return { page: await this.pageSummary(page, input.index), authenticationTargetUpdated };
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
    const targetState = await this.requireUniqueClickTarget(
      page,
      locator,
      'click_by_role',
      input.role,
      input.name,
    );
    const startedAt = Date.now();
    const actionStartedAt = new Date(startedAt).toISOString();
    this.pageDiagnostics.beginAction(page, actionStartedAt);
    try {
      await locator.click({ timeout: input.timeoutMs });
    } catch (error) {
      const diagnostic = actionDiagnosticForFailure(
        'click_by_role',
        page,
        error,
        await inspectTargetState(locator) ?? targetState,
        actionStartedAt,
      );
      this.pageDiagnostics.recordAction(page, diagnostic);
      throw this.clickFailureError(diagnostic, error);
    }
    try {
      const postcondition = await this.verifyClickPostcondition(
        page,
        frame,
        locator,
        input.postcondition,
        Math.max(0, input.timeoutMs - (Date.now() - startedAt)),
      );
      this.pageDiagnostics.recordAction(
        page,
        this.successfulActionDiagnostic('click_by_role', page, targetState, actionStartedAt),
      );
      this.lastKnownUrl = page.url();
      return {
        page: await this.pageSummary(page),
        frame: this.frameSummary(frame, page),
        postcondition,
      };
    } catch (error) {
      if (error instanceof Stage5BrowserError && error.code === 'POSTCONDITION_FAILED') {
        this.pageDiagnostics.recordAction(
          page,
          this.postconditionFailureDiagnostic('click_by_role', page, targetState, actionStartedAt),
        );
      }
      throw error;
    } finally {
      this.observedSnapshots.delete(frame);
    }
  }

  async clickRef(input: BrowserCommandInput<'clickRef'>): Promise<BrowserCommandOutput<'clickRef'>> {
    const page = await this.ensureActivePage(await this.ensureContext());
    const frame = this.resolveFrame(page, input.frameId);
    const observed = this.observedSnapshots.get(frame);
    if (
      observed === undefined ||
      observed.id !== input.snapshotId ||
      observed.documentVersion !== this.documentVersion(frame)
    ) {
      throw new Stage5BrowserError(
        'TARGET_NOT_FOUND',
        'The element reference does not belong to the latest snapshot of the current document.',
        {
          details: {
            reason: 'stale_or_unknown_snapshot',
            snapshotId: input.snapshotId,
            frameId: input.frameId,
          },
        },
      );
    }
    if (!observed.refs.has(input.ref)) {
      throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The requested reference was not present in that snapshot.', {
        details: { reason: 'reference_not_observed', ref: input.ref, snapshotId: input.snapshotId },
      });
    }

    const locator = frame.locator(`aria-ref=${input.ref}`);
    const count = await locator.count();
    if (count !== 1) {
      this.pageDiagnostics.recordAction(
        page,
        this.targetingFailureDiagnostic(
          'click_by_ref',
          page,
          count === 0 ? 'target_missing' : 'ambiguous_target',
        ),
      );
      throw new Stage5BrowserError(
        count === 0 ? 'TARGET_NOT_FOUND' : 'AMBIGUOUS_TARGET',
        count === 0
          ? 'The observed reference no longer resolves in the current document.'
          : 'The observed reference resolved to multiple elements; Stage5 Browser will not choose one.',
        { details: { reason: 'reference_resolution_changed', ref: input.ref, matchCount: count } },
      );
    }

    const targetState = await inspectTargetState(locator);
    const startedAt = Date.now();
    const actionStartedAt = new Date(startedAt).toISOString();
    this.pageDiagnostics.beginAction(page, actionStartedAt);
    try {
      await locator.click({ timeout: input.timeoutMs });
    } catch (error) {
      const diagnostic = actionDiagnosticForFailure(
        'click_by_ref',
        page,
        error,
        await inspectTargetState(locator) ?? targetState,
        actionStartedAt,
      );
      this.pageDiagnostics.recordAction(page, diagnostic);
      throw this.clickFailureError(diagnostic, error);
    }
    try {
      const postcondition = await this.verifyClickPostcondition(
        page,
        frame,
        locator,
        input.postcondition,
        Math.max(0, input.timeoutMs - (Date.now() - startedAt)),
      );
      this.pageDiagnostics.recordAction(
        page,
        this.successfulActionDiagnostic('click_by_ref', page, targetState, actionStartedAt),
      );
      this.lastKnownUrl = page.url();
      return {
        page: await this.pageSummary(page),
        frame: this.frameSummary(frame, page),
        postcondition,
      };
    } catch (error) {
      if (error instanceof Stage5BrowserError && error.code === 'POSTCONDITION_FAILED') {
        this.pageDiagnostics.recordAction(
          page,
          this.postconditionFailureDiagnostic('click_by_ref', page, targetState, actionStartedAt),
        );
      }
      throw error;
    } finally {
      this.observedSnapshots.delete(frame);
    }
  }

  async fillByRole(input: BrowserCommandInput<'fillByRole'>): Promise<BrowserCommandOutput<'fillByRole'>> {
    const page = await this.ensureActivePage(await this.ensureContext());
    const frame = this.resolveFrame(page, input.frameId);
    const locator = frame.getByRole(input.role, { name: input.name, exact: input.exact });
    await this.requireUniqueTarget(locator.count(), input.role, input.name);
    await locator.fill(input.value, { timeout: input.timeoutMs });
    this.lastKnownUrl = page.url();
    this.observedSnapshots.delete(frame);
    return { page: await this.pageSummary(page), frame: this.frameSummary(frame, page) };
  }

  async scroll(input: BrowserCommandInput<'scroll'>): Promise<BrowserCommandOutput<'scroll'>> {
    const page = await this.ensureActivePage(await this.ensureContext());
    const frame = this.resolveFrame(page, input.frameId);
    const before = await this.scrollPosition(frame);
    const startedAt = Date.now();
    let stepsCompleted = 0;

    for (let step = 0; step < input.count; step += 1) {
      if (Date.now() - startedAt + input.settleMs >= input.timeoutMs) {
        break;
      }
      await this.performScrollStep(frame, input.direction, input.amount);
      stepsCompleted += 1;
      if (input.settleMs > 0) {
        await page.waitForTimeout(input.settleMs);
      }
      if (input.amount === 'document_start' || input.amount === 'document_end') {
        break;
      }
    }

    const after = await this.scrollPosition(frame);
    const moved = before.x !== after.x || before.y !== after.y;
    const contentGrew = after.contentHeight > before.contentHeight || after.contentWidth > before.contentWidth;
    const endReached = input.amount === 'document_start'
      ? after.y <= 0
      : input.amount === 'document_end'
        ? after.y >= after.maxY
        : input.direction === 'down'
          ? after.y >= after.maxY
          : after.y <= 0;
    this.lastKnownUrl = page.url();
    this.observedSnapshots.delete(frame);
    return {
      page: await this.pageSummary(page),
      frame: this.frameSummary(frame, page),
      before,
      after,
      stepsCompleted,
      moved,
      contentGrew,
      endReached,
      warnings: moved || contentGrew
        ? []
        : [{
            code: 'scroll_position_unchanged',
            message: 'The requested scroll did not change the document position or size.',
            suggestedAction: 'Inspect the current snapshot for a nested scroll container or confirm that the timeline end was reached.',
          }],
    };
  }

  async findText(input: BrowserCommandInput<'findText'>): Promise<BrowserCommandOutput<'findText'>> {
    const page = await this.ensureActivePage(await this.ensureContext());
    const frame = this.resolveFrame(page, input.frameId);
    const body = frame.locator('body');
    const rawText = await body.innerText({ timeout: input.timeoutMs });
    const textTruncated = rawText.length > MAX_SEARCHABLE_TEXT_CHARACTERS;
    const text = rawText.slice(0, MAX_SEARCHABLE_TEXT_CHARACTERS);
    const lines = text.split(/\r?\n/);
    const needle = input.caseSensitive ? input.query : input.query.toLocaleLowerCase();
    const matches: Array<{ line: number; snippet: string }> = [];
    let matchCount = 0;

    for (const [index, originalLine] of lines.entries()) {
      const line = originalLine.trim();
      if (line.length === 0) {
        continue;
      }
      const candidate = input.caseSensitive ? line : line.toLocaleLowerCase();
      const matched = input.mode === 'exact_line' ? candidate === needle : candidate.includes(needle);
      if (!matched) {
        continue;
      }
      matchCount += 1;
      if (matches.length < input.maxResults) {
        const position = input.mode === 'exact_line' ? 0 : Math.max(0, candidate.indexOf(needle));
        const start = Math.max(0, position - TEXT_SNIPPET_CONTEXT);
        const end = Math.min(line.length, position + input.query.length + TEXT_SNIPPET_CONTEXT);
        matches.push({
          line: index + 1,
          snippet: `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`,
        });
      }
    }

    this.lastKnownUrl = page.url();
    return {
      page: await this.pageSummary(page),
      frame: this.frameSummary(frame, page),
      query: input.query,
      matchCount,
      returnedCount: matches.length,
      truncated: matchCount > matches.length,
      textTruncated,
      matches,
    };
  }

  async waitForUrl(input: BrowserCommandInput<'waitForUrl'>): Promise<BrowserCommandOutput<'waitForUrl'>> {
    const page = await this.ensureActivePage(await this.ensureContext());
    await this.waitForUrlExpectation(page, input.expected, input.timeoutMs, 'URL wait');
    this.lastKnownUrl = page.url();
    return { page: await this.pageSummary(page), matched: true, expected: input.expected };
  }

  async authStatus(): Promise<BrowserCommandOutput<'authStatus'>> {
    const context = this.usableContext();
    if (context !== undefined) {
      await this.reconcileVisiblePage(context);
    }
    const page = context === undefined ? undefined : this.preferredPage();
    return this.authenticationStatus(page);
  }

  async requestLoginHandoff(
    input: BrowserCommandInput<'requestLoginHandoff'>,
  ): Promise<BrowserCommandOutput<'requestLoginHandoff'>> {
    if (this.config.headless) {
      throw new Stage5BrowserError(
        'AUTH_HANDOFF_UNAVAILABLE',
        'Login handoff requires a visible Stage5 Browser window.',
        {
          recoverable: true,
          details: {
            reason: 'headless_profile',
            suggestedAction: 'Run the persistent Stage5 Browser profile in headed mode, then request the handoff again.',
          },
        },
      );
    }

    if (this.authenticationHandoff !== null) {
      throw new Stage5BrowserError(
        'AUTH_HANDOFF_REQUIRED',
        'An authentication handoff is already active.',
        {
          recoverable: true,
          details: {
            reason: 'handoff_already_active',
            suggestedAction: this.authenticationHandoff.state === 'awaiting_user'
              ? 'Finish authentication and quit the dedicated browser normally so its process exits, then call browser_resume_after_login.'
              : 'Take the required fresh semantic snapshot before requesting another handoff.',
          },
        },
      );
    }

    const launchTarget = await resolveBrowserLaunchTarget(this.selectionFor(this.selectedBrowser));
    const profileDir = profileDirForBrowser(this.config, this.selectedBrowser);
    const launchIdentity = launchIdentityForTarget(launchTarget, profileDir);
    if (
      this.controlledLaunchIdentity !== null
      && !sameLaunchIdentity(this.controlledLaunchIdentity, launchIdentity)
    ) {
      throw new Stage5BrowserError(
        'AUTH_NOT_PERSISTED',
        'The controlled browser identity changed before authentication handoff.',
        {
          recoverable: true,
          details: {
            reason: 'auth_launch_identity_mismatch',
            controlledIdentity: this.controlledLaunchIdentity,
            requestedIdentity: launchIdentity,
            suggestedAction: 'Stop before entering credentials. Start the intended backend once, then request a new handoff from that same backend.',
          },
        },
      );
    }
    const humanPolicy = humanBrowserLaunchPolicy(launchTarget);
    if (!humanPolicy.supported) {
      throw new Stage5BrowserError(
        'AUTH_HANDOFF_UNAVAILABLE',
        'Human authentication bootstrap is not available for the selected browser engine.',
        {
          recoverable: true,
          details: {
            reason: 'human_bootstrap_engine_unsupported',
            browser: this.selectedBrowser,
            engine: launchTarget.engine,
            suggestedAction: 'Select Brave, Chrome, Edge, Chromium, or Firefox for authentication.',
          },
        },
      );
    }

    let page = await this.ensureActivePage(await this.ensureContext());
    if (input.url !== null) {
      await this.open({ url: input.url, newTab: false, stabilizationMs: 750, timeoutMs: input.timeoutMs });
      page = await this.ensureActivePage(await this.ensureContext());
    }
    await page.bringToFront();

    const targetUrl = this.humanBootstrapTargetUrl(page.url());
    const targetOrigin = this.urlOrigin(targetUrl);
    const beforeUrl = sanitizeUrlForJournal(page.url()) ?? null;
    const beforeSemanticFingerprint = await this.semanticFingerprint(page);
    const context = this.usableContext();
    if (context === undefined) {
      throw new Stage5BrowserError('BROWSER_NOT_READY', 'The controlled profile disappeared before handoff.');
    }

    await context.close({ reason: 'Stage5 Browser released the profile for private human authentication.' });
    this.clearControlledBrowserState();
    if (!(await waitForProfileUnlock(profileDir, Math.min(input.timeoutMs, 5_000)))) {
      throw new Stage5BrowserError(
        'BROWSER_NOT_READY',
        'The dedicated profile did not unlock after Stage5 Browser released control.',
        {
          recoverable: true,
          details: {
            reason: 'profile_locked',
            browser: this.selectedBrowser,
            suggestedAction: 'Wait for the previous dedicated browser process to finish closing, then request the handoff once.',
          },
        },
      );
    }
    const beforeStorage = await this.profileStorageInspector(
      launchIdentity.profile,
      launchIdentity.engine,
      targetOrigin,
    );
    const beforeProfileShutdown = await inspectProfileShutdown(
      profileDir,
      this.selectedBrowser,
      launchIdentity.profile.profileDirectory,
    );
    const handoffLabel = this.authenticationHandoffLabel(launchIdentity, targetOrigin);

    let session: HumanBrowserSession;
    try {
      session = await this.humanBrowserLauncher.launch({
        target: launchTarget,
        profileDir,
        handoffLabel,
        url: targetUrl,
      });
    } catch (error) {
      this.state = 'failed';
      const diagnostic = launchFailureDiagnostic(this.selectedBrowser, error);
      this.lastLaunchFailure = diagnostic;
      throw new Stage5BrowserError(
        'BROWSER_NOT_READY',
        'The private human authentication browser could not be launched.',
        {
          recoverable: true,
          details: {
            browser: diagnostic.browser,
            engine: diagnostic.engine,
            reason: diagnostic.reason,
            occurredAt: diagnostic.occurredAt,
            suggestedAction: diagnostic.suggestedAction,
          },
          cause: error,
        },
      );
    }

    const humanLaunchIdentity = session.identity();
    if (!sameLaunchIdentity(launchIdentity, humanLaunchIdentity)) {
      throw new Stage5BrowserError(
        'AUTH_NOT_PERSISTED',
        'The native authentication browser did not launch with the controlled browser identity.',
        {
          recoverable: true,
          details: {
            reason: 'auth_launch_identity_mismatch',
            controlledIdentity: launchIdentity,
            humanIdentity: humanLaunchIdentity,
            suggestedAction: 'Do not enter credentials in the opened window. Quit it normally and correct the configured backend before requesting another handoff.',
          },
        },
      );
    }

    this.authenticationHandoff = {
      mode: 'human_bootstrap',
      state: 'awaiting_user',
      targetOrigin,
      requestedAt: new Date().toISOString(),
      resumedAt: null,
      page: null,
      profileDir,
      launchIdentity: humanLaunchIdentity,
      handoffLabel,
      targetUrl,
      beforeUrl,
      beforeSemanticFingerprint,
      beforeStorage,
      beforeProfileShutdown,
      session,
      profileShutdown: null,
      shutdownOverrideOffered: false,
    };
    this.state = 'stopped';
    return {
      ...(await this.authenticationStatus(undefined)),
      userActionRequired: true,
      instructions: `Authenticate only in the newly opened ${humanLaunchIdentity.applicationName} window identified as “${handoffLabel}”. It uses the Stage5 ${humanLaunchIdentity.browser} profile partition “${humanLaunchIdentity.profile.profileDirectory ?? 'profile root'}” for ${targetOrigin ?? 'the requested page'}. Then quit ${humanLaunchIdentity.applicationName} normally so its process exits. On macOS, use Cmd-Q in that exact application; closing only a tab or window may leave it running. Do not send credentials, passkeys, CAPTCHAs, or OTPs to the agent. After it has quit, tell the agent to call browser_resume_after_login.`,
    };
  }

  async resumeAfterLogin(
    input: BrowserCommandInput<'resumeAfterLogin'>,
  ): Promise<BrowserCommandOutput<'resumeAfterLogin'>> {
    if (this.authenticationHandoff?.state !== 'awaiting_user') {
      throw new Stage5BrowserError('AUTH_HANDOFF_REQUIRED', 'No login handoff is currently awaiting the user.', {
        recoverable: true,
        details: {
          reason: 'no_pending_handoff',
          suggestedAction: 'Call browser_request_login_handoff before asking the user to authenticate.',
        },
      });
    }

    if (input.expected !== null) {
      this.validateAuthenticationUrlExpectation(input.expected);
    }

    const handoff = this.authenticationHandoff;
    const processState = handoff.session.state();
    if (processState.running) {
      throw new Stage5BrowserError(
        'AUTH_HANDOFF_REQUIRED',
        'The private human authentication browser is still running.',
        {
          recoverable: true,
          details: {
            reason: 'human_browser_still_running',
            suggestedAction: `Finish authentication and quit ${handoff.launchIdentity.applicationName} normally so its process exits, then call browser_resume_after_login once. On macOS, use Cmd-Q in that exact application; closing only a tab or window may leave it running.`,
          },
        },
      );
    }

    if (!(await waitForProfileUnlock(handoff.profileDir, Math.min(input.timeoutMs, 5_000)))) {
      throw new Stage5BrowserError(
        'AUTH_HANDOFF_REQUIRED',
        'The private browser process exited, but its profile is still locked.',
        {
          recoverable: true,
          details: {
            reason: 'profile_locked_after_handoff',
            suggestedAction: 'Wait for the dedicated browser to finish closing, then call browser_resume_after_login once. Do not delete profile lock files.',
          },
        },
      );
    }

    const observedShutdown = await inspectProfileShutdown(
      handoff.profileDir,
      this.selectedBrowser,
      handoff.launchIdentity.profile.profileDirectory,
    );
    const exitTypeComparison = compareProfileExitMarker(handoff.beforeProfileShutdown, observedShutdown);
    const processExitedNormally = processState.exitCode === 0 && processState.exitSignal === null;
    const processExitedAbnormally = processState.exitSignal !== null
      || (processState.exitCode !== null && processState.exitCode !== 0);
    const explicitUnlockedProfileOverride = !processExitedNormally && handoff.shutdownOverrideOffered;
    const shutdown: ProfileShutdownDecision = {
      ...observedShutdown,
      state: processExitedNormally
        ? 'clean'
        : explicitUnlockedProfileOverride
          ? 'unknown'
          : processExitedAbnormally
            ? 'unclean'
            : 'unknown',
      exitedCleanly: processExitedNormally ? true : processExitedAbnormally ? false : null,
      exitedCleanlySource: processExitedNormally || processExitedAbnormally
        ? 'process_exit'
        : 'insufficient_evidence',
      exitTypeComparison,
      currentSessionEvidence: processExitedNormally
        ? 'clean_process_exit'
        : processExitedAbnormally
          ? 'abnormal_process_exit'
          : 'process_exit_unknown',
      reattachmentDecision: processExitedNormally
        ? 'allowed'
        : explicitUnlockedProfileOverride
          ? 'explicit_unlocked_profile_override'
          : 'override_available',
    };
    handoff.profileShutdown = shutdown;
    if (!processExitedNormally && !explicitUnlockedProfileOverride) {
      handoff.shutdownOverrideOffered = true;
      throw new Stage5BrowserError(
        'AUTH_HANDOFF_REQUIRED',
        processExitedAbnormally
          ? 'The private authentication browser process exited abnormally, but the profile is unlocked.'
          : 'The private authentication browser stopped and unlocked its profile, but did not report a process exit result.',
        {
          recoverable: true,
          details: {
            reason: processExitedAbnormally
              ? 'abnormal_human_browser_process_exit'
              : 'human_browser_process_exit_unknown',
            exitType: shutdown.exitType,
            exitTypeComparison: shutdown.exitTypeComparison,
            exitedCleanly: shutdown.exitedCleanly,
            exitedCleanlySource: shutdown.exitedCleanlySource,
            profileDirectory: shutdown.profileDirectory,
            profileLocks: shutdown.profileLocks,
            processExitCode: processState.exitCode,
            processExitSignal: processState.exitSignal,
            overrideAvailable: true,
            suggestedAction: 'Do not repeat authentication or reopen the browser. Because the human process is gone and the profile has zero locks, call browser_resume_after_login once more with the same expectation to explicitly reattach this same isolated profile. Stage5 Browser will not rewrite its Chromium preferences.',
          },
        },
      );
    }

    const afterHumanStorage = await this.profileStorageInspector(
      handoff.launchIdentity.profile,
      handoff.launchIdentity.engine,
      handoff.targetOrigin,
    );
    const resumeTarget = await resolveBrowserLaunchTarget(this.selectionFor(this.selectedBrowser));
    const resumeIdentity = launchIdentityForTarget(resumeTarget, handoff.profileDir);
    if (!sameLaunchIdentity(handoff.launchIdentity, resumeIdentity)) {
      throw new Stage5BrowserError(
        'AUTH_NOT_PERSISTED',
        'The browser executable or profile partition changed before controlled reattachment.',
        {
          recoverable: true,
          details: {
            reason: 'auth_launch_identity_mismatch',
            humanIdentity: handoff.launchIdentity,
            reattachmentIdentity: resumeIdentity,
            suggestedAction: 'Do not repeat the login. Restore the same selected backend and dedicated profile binding, then resume once.',
          },
        },
      );
    }

    handoff.state = 'ready_for_agent_verification';
    let page: Page;
    try {
      await this.start({}, handoff.targetOrigin);
      if (
        this.controlledLaunchIdentity === null
        || !sameLaunchIdentity(handoff.launchIdentity, this.controlledLaunchIdentity)
      ) {
        throw new Stage5BrowserError(
          'AUTH_NOT_PERSISTED',
          'Controlled reattachment did not use the native authentication browser identity.',
          {
            recoverable: true,
            details: {
              reason: 'auth_launch_identity_mismatch',
              humanIdentity: handoff.launchIdentity,
              reattachmentIdentity: this.controlledLaunchIdentity,
              suggestedAction: 'Do not repeat the login. Inspect the reported executable and profile binding mismatch first.',
            },
          },
        );
      }
      const context = this.usableContext();
      if (context === undefined) {
        throw new Stage5BrowserError('BROWSER_NOT_READY', 'The controlled browser did not reconnect after login.');
      }
      if (this.runtimeProfileObservation?.matchesConfigured === false) {
        throw new Stage5BrowserError(
          'AUTH_NOT_PERSISTED',
          'The running browser reported a different profile path from the authentication handoff.',
          {
            recoverable: true,
            details: {
              reason: 'auth_runtime_profile_mismatch',
              configuredProfile: handoff.launchIdentity.profile,
              runtimeProfile: this.runtimeProfileObservation,
              suggestedAction: 'Do not repeat login. Stop before navigation and inspect the reported runtime profile path mismatch.',
            },
          },
        );
      }
      const markerPages = context.pages().filter((candidate) => isStage5HandoffMarkerUrl(candidate.url()));
      await Promise.all(markerPages.map(async (candidate) => candidate.close({ runBeforeUnload: false })));
      page = context.pages().findLast((candidate) => !candidate.isClosed()) ?? (await context.newPage());
      this.bindPage(page);
      this.activePage = page;
      handoff.page = page;
      if (!this.isWebUrl(page.url()) && handoff.targetUrl !== 'about:blank') {
        await this.open({
          url: handoff.targetUrl,
          newTab: false,
          stabilizationMs: 750,
          timeoutMs: input.timeoutMs,
        });
        page = this.preferredPage() ?? page;
      }
    } catch (error) {
      handoff.state = 'awaiting_user';
      handoff.page = null;
      throw error;
    }
    let authenticationUrlFailure: Stage5BrowserError | null = null;
    if (input.expected !== null) {
      try {
        await this.waitForUrlExpectation(page, input.expected, input.timeoutMs, 'Login handoff');
      } catch (error) {
        if (!(error instanceof Stage5BrowserError)) {
          throw error;
        }
        authenticationUrlFailure = error;
      }
    }
    const resumedContext = this.usableContext();
    if (resumedContext === undefined) {
      throw new Stage5BrowserError('BROWSER_NOT_READY', 'The controlled browser disappeared during storage-boundary inspection.');
    }
    const controlledStartBoundary = this.controlledStartBoundary?.targetOrigin === handoff.targetOrigin
      ? this.controlledStartBoundary
      : null;
    const afterControlledStartStorage = controlledStartBoundary?.storage
      ?? await this.controlledProfileStorageInspector(
        handoff.launchIdentity.profile,
        handoff.launchIdentity.engine,
        handoff.targetOrigin,
        (urls) => resumedContext.cookies(urls).then((cookies) => cookies.map((cookie) => ({
          domain: cookie.domain,
          name: cookie.name,
          expires: cookie.expires,
        }))),
      );
    const afterTargetLoadStorage = await this.controlledProfileStorageInspector(
      handoff.launchIdentity.profile,
      handoff.launchIdentity.engine,
      handoff.targetOrigin,
      (urls) => resumedContext.cookies(urls).then((cookies) => cookies.map((cookie) => ({
        domain: cookie.domain,
        name: cookie.name,
        expires: cookie.expires,
      }))),
    );
    const storageComparison = compareAuthenticationStorage(
      handoff.beforeStorage,
      afterHumanStorage,
      afterControlledStartStorage,
      afterTargetLoadStorage,
      {
        targetOriginLoadedAtControlledStart: controlledStartBoundary?.targetOriginLoaded ?? false,
        navigatorWebdriverAtControlledStart: controlledStartBoundary?.navigatorWebdriver ?? null,
      },
    );
    handoff.resumedAt = new Date().toISOString();
    const afterUrl = sanitizeUrlForJournal(page.url()) ?? null;
    const afterSemanticFingerprint = await this.semanticFingerprint(page);
    this.lastHandoffOutcome = {
      observation: 'sanitized_before_after_boundary',
      exactUserInteractionsObserved: false,
      beforeUrl: handoff.beforeUrl,
      afterUrl,
      routeChanged: handoff.beforeUrl === null || afterUrl === null
        ? null
        : handoff.beforeUrl !== afterUrl,
      semanticStructureChanged:
        handoff.beforeSemanticFingerprint === null || afterSemanticFingerprint === null
          ? null
          : handoff.beforeSemanticFingerprint !== afterSemanticFingerprint,
      launchIdentityMatched: true,
      runtimeProfile: this.runtimeProfileObservation,
      storageContinuity: storageComparison.continuity,
      comparedAt: handoff.resumedAt,
    };
    this.lastKnownUrl = page.url();
    const verificationPreview = await this.authenticationVerificationPreview(page);
    if (storageComparison.authNotPersisted) {
      throw new Stage5BrowserError(
        'AUTH_NOT_PERSISTED',
        'Target-origin session metadata was lost across controlled reattachment.',
        {
          recoverable: true,
          details: {
            reason: 'authentication_storage_lost',
            runtimeProfile: this.runtimeProfileObservation,
            storageContinuity: storageComparison.continuity,
            currentUrl: sanitizeUrlForJournal(page.url()) ?? null,
            suggestedAction: 'Do not repeat login. Report the loss boundary, automation correlation, restored-target flag, runtime profile, and visible site state before changing the control architecture.',
          },
        },
      );
    }
    if (
      authenticationUrlFailure !== null
      && storageComparison.continuity.humanSessionEvidenceObserved === true
      && input.expected !== null
    ) {
      throw new Stage5BrowserError(
        'AUTH_NOT_PERSISTED',
        'The human login changed target-origin session metadata, but controlled reattachment did not reach the requested post-login route.',
        {
          recoverable: true,
          details: {
            reason: 'post_login_url_not_reached',
            launchIdentity: handoff.launchIdentity,
            storageContinuity: storageComparison.continuity,
            expected: input.expected,
            currentUrl: sanitizeUrlForJournal(page.url()) ?? null,
            suggestedAction: 'Do not repeat the login yet. Inspect the bounded verification preview and profile binding evidence; the controlled browser remains available for diagnosis.',
          },
        },
      );
    }
    if (authenticationUrlFailure !== null) {
      throw authenticationUrlFailure;
    }
    return {
      ...(await this.authenticationStatus(page)),
      userActionRequired: false,
      instructions: 'Storage continuity is not treated as proof of authentication. Inspect verificationPreview now; if it still shows signed-out controls, stop and report that site state rather than proceeding or repeating login. Then take a fresh full semantic snapshot before any account action.',
      verificationPreview,
    };
  }

  private bindContext(context: BrowserContext): void {
    for (const page of context.pages()) {
      this.bindPage(page);
    }
    context.on('page', (page) => {
      if (this.authenticationHandoff === null) {
        this.activePage = page;
      }
      this.bindPage(page);
    });

    context.on('close', () => {
      if (this.context === context) {
        this.context = undefined;
        this.activePage = undefined;
        this.framesById.clear();
        this.observedSnapshots.clear();
        this.frameIds = new WeakMap<Frame, string>();
        this.frameDocumentVersions = new WeakMap<Frame, number>();
        this.boundPages = new WeakSet<Page>();
        this.authenticationHandoff = null;
        this.runtimeProfileObservation = null;
        this.controlledStartBoundary = null;
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
    this.pageDiagnostics.bind(page);
    page.on('framenavigated', (frame) => {
      this.frameDocumentVersions.set(frame, this.documentVersion(frame) + 1);
      this.observedSnapshots.delete(frame);
    });
    page.on('framedetached', (frame) => this.removeFrame(frame));
    page.on('crash', () => {
      if (this.activePage === page) {
        this.activePage = undefined;
      }
      if (this.authenticationHandoff?.page === page) {
        this.authenticationHandoff.page = null;
      }
      this.removePageFrames(page);
    });
    page.on('close', () => {
      if (this.activePage === page) {
        this.activePage = undefined;
      }
      if (this.authenticationHandoff?.page === page) {
        this.authenticationHandoff.page = null;
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
    if (this.authenticationHandoff?.state === 'awaiting_user') {
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
  }

  private async ensureActivePage(context: BrowserContext): Promise<Page> {
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
    return page;
  }

  private preferredPage(): Page | undefined {
    if (this.authenticationHandoff !== null) {
      const handoffPage = this.authenticationHandoff.page;
      return handoffPage !== null && !handoffPage.isClosed() ? handoffPage : undefined;
    }
    return this.activePage !== undefined && !this.activePage.isClosed()
      ? this.activePage
      : undefined;
  }

  private async reconcileVisiblePage(context: BrowserContext): Promise<void> {
    const handoff = this.authenticationHandoff;
    const pages = context.pages().filter((page) => !page.isClosed());
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
    if (handoff !== null && visiblePages[0] !== handoff.page) {
      handoff.page = visiblePages[0];
      handoff.targetOrigin = this.urlOrigin(visiblePages[0].url());
    }
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
    this.observedSnapshots.delete(frame);
  }

  private removePageFrames(page: Page): void {
    for (const [id, frame] of this.framesById) {
      if (frame.page() === page) {
        this.framesById.delete(id);
        this.observedSnapshots.delete(frame);
      }
    }
  }

  private async snapshotRoot(frame: Frame): Promise<SnapshotRoot> {
    const dialogs = frame.locator(
      '[role="dialog"]:visible, dialog[open]:visible, [aria-modal="true"]:visible',
    );
    const visibleModalCount = await dialogs.count();
    if (visibleModalCount === 0) {
      return {
        locator: frame.locator('body'),
        scope: 'document',
        visibleModalCount,
        warnings: [],
      };
    }

    const modalIndex = await dialogs.evaluateAll((elements) => {
      if (elements.length === 1) {
        return 0;
      }
      const activeElement = document.activeElement;
      const containingActiveElement = elements
        .map((element, index) => ({ element, index }))
        .filter(({ element }) => activeElement !== null && element.contains(activeElement));
      if (containingActiveElement.length === 1) {
        return containingActiveElement[0]?.index ?? -1;
      }
      const explicitModals = elements
        .map((element, index) => ({ element, index }))
        .filter(({ element }) => element.getAttribute('aria-modal') === 'true');
      return explicitModals.length === 1 ? explicitModals[0]?.index ?? -1 : -1;
    });

    if (modalIndex >= 0) {
      return {
        locator: dialogs.nth(modalIndex),
        scope: 'modal',
        visibleModalCount,
        warnings: [],
      };
    }

    return {
      locator: frame.locator('body'),
      scope: 'document',
      visibleModalCount,
      warnings: [{
        code: 'ambiguous_visible_modals',
        message: 'Multiple visible dialogs were present, but no unique active modal could be established.',
        suggestedAction: 'Inspect the document snapshot and use a unique semantic target; Stage5 Browser did not choose a dialog arbitrarily.',
      }],
    };
  }

  private documentVersion(frame: Frame): number {
    const current = this.frameDocumentVersions.get(frame);
    if (current !== undefined) {
      return current;
    }
    this.frameDocumentVersions.set(frame, 0);
    return 0;
  }

  private safeObservedUrl(value: string): string {
    return sanitizeUrlForJournal(value) ?? '<unavailable>';
  }

  private httpWarnings(status: number | null): NavigationWarning[] {
    if (status === null || status < 400) {
      return [];
    }
    if (status === 401) {
      return [{
        code: 'http_authentication_required',
        message: 'The navigation response requires authentication (HTTP 401).',
        status,
        suggestedAction: 'Inspect the page, then use the login handoff if authentication is required.',
      }];
    }
    if (status === 403) {
      return [{
        code: 'http_forbidden',
        message: 'The navigation response was forbidden (HTTP 403).',
        status,
        suggestedAction: 'Do not retry blindly. Inspect the page for an access or bot-protection challenge.',
      }];
    }
    if (status === 429) {
      return [{
        code: 'http_rate_limited',
        message: 'The navigation response was rate limited (HTTP 429).',
        status,
        suggestedAction: 'Pause requests and honor any visible retry guidance; do not immediately repeat the request.',
      }];
    }
    if (status >= 500) {
      return [{
        code: 'http_server_error',
        message: `The navigation response returned a server error (HTTP ${status}).`,
        status,
        suggestedAction: 'Inspect the committed response before deciding whether a later bounded retry is appropriate.',
      }];
    }
    return [{
      code: 'http_client_error',
      message: `The navigation response returned a client error (HTTP ${status}).`,
      status,
      suggestedAction: 'Inspect the response and correct the target or authentication state before retrying.',
    }];
  }

  private async redirectChain(response: Response | null): Promise<RedirectHop[]> {
    if (response === null) {
      return [];
    }

    const requests: Request[] = [];
    let request: Request | null = response.request();
    while (request !== null) {
      requests.unshift(request);
      request = request.redirectedFrom();
    }

    const hops: RedirectHop[] = [];
    for (let index = 0; index < requests.length - 1; index += 1) {
      const from = requests[index];
      const to = requests[index + 1];
      if (from === undefined || to === undefined) {
        continue;
      }
      const redirectResponse = await boundedValue(from.response(), 1_000, null);
      hops.push({
        kind: 'server',
        from: this.safeObservedUrl(from.url()),
        to: this.safeObservedUrl(to.url()),
        status: redirectResponse?.status() ?? null,
      });
    }
    return hops;
  }

  private async verifyClickPostcondition(
    page: Page,
    clickedFrame: Frame,
    clickedLocator: Locator,
    postcondition: ClickPostcondition | null,
    remainingTimeoutMs: number,
  ): Promise<PostconditionResult | null> {
    if (postcondition === null) {
      return null;
    }

    const timeoutMs = Math.min(postcondition.timeoutMs, remainingTimeoutMs);
    const startedAt = Date.now();
    let checks: PostconditionCheck[] = [];
    do {
      checks = await this.postconditionChecks(page, clickedFrame, clickedLocator, postcondition);
      if (checks.length > 0 && checks.every((check) => check.passed)) {
        return { passed: true, checks };
      }
      if (Date.now() - startedAt >= timeoutMs) {
        break;
      }
      await page.waitForTimeout(Math.min(100, Math.max(1, timeoutMs - (Date.now() - startedAt))));
    } while (Date.now() - startedAt < timeoutMs);

    throw new Stage5BrowserError(
      'POSTCONDITION_FAILED',
      'The click was dispatched, but the requested postcondition was not observed before its deadline.',
      {
        recoverable: true,
        details: {
          reason: 'click_postcondition_not_met',
          clickDispatched: true,
          actionOutcome: 'click_dispatched_postcondition_failed',
          checks: checks.map((check) => ({
            ...check,
            ...(check.kind === 'url' && typeof check.observed === 'string'
              ? { observed: this.safeObservedUrl(check.observed) }
              : {}),
            ...(check.kind === 'url' && typeof check.expected === 'string'
              ? { expected: this.safeObservedUrl(check.expected) }
              : {}),
          })),
          currentUrl: this.safeObservedUrl(page.url()),
          suggestedAction: 'Inspect the current page state. Do not repeat the click unless a fresh observation shows that retrying is safe.',
        },
      },
    );
  }

  private async postconditionChecks(
    page: Page,
    clickedFrame: Frame,
    clickedLocator: Locator,
    postcondition: ClickPostcondition,
  ): Promise<PostconditionCheck[]> {
    const checks: PostconditionCheck[] = [];

    if (postcondition.expectedUrl !== null) {
      const observed = page.url();
      checks.push({
        kind: 'url',
        passed: this.urlMatches(observed, postcondition.expectedUrl),
        expected: postcondition.expectedUrl.url,
        observed,
      });
    }

    if (postcondition.expectedSelected !== null) {
      const observed = await this.selectedState(clickedLocator);
      checks.push({
        kind: 'selected',
        passed: observed === postcondition.expectedSelected,
        expected: postcondition.expectedSelected,
        observed,
      });
    }

    if (postcondition.expectedVisible !== null) {
      const expectation = postcondition.expectedVisible;
      let observed = false;
      try {
        const frame = expectation.frameId === null
          ? page.mainFrame()
          : this.resolveFrame(page, expectation.frameId);
        const locator = frame.getByRole(expectation.role, {
          name: expectation.name,
          exact: expectation.exact,
        });
        observed = (await locator.count()) === 1 && await locator.isVisible();
      } catch {
        observed = false;
      }
      checks.push({
        kind: 'visible',
        passed: observed,
        expected: true,
        observed,
      });
    }

    if (clickedFrame.isDetached() && postcondition.expectedSelected !== null) {
      const selected = checks.find((check) => check.kind === 'selected');
      if (selected !== undefined) {
        selected.passed = false;
        selected.observed = null;
      }
    }
    return checks;
  }

  private async selectedState(locator: Locator): Promise<boolean | null> {
    try {
      return await locator.evaluate((element) => {
        const ariaSelected = element.getAttribute('aria-selected');
        if (ariaSelected !== null) {
          return ariaSelected === 'true';
        }
        const ariaChecked = element.getAttribute('aria-checked');
        if (ariaChecked !== null) {
          return ariaChecked === 'true';
        }
        const ariaPressed = element.getAttribute('aria-pressed');
        if (ariaPressed !== null) {
          return ariaPressed === 'true';
        }
        const ariaCurrent = element.getAttribute('aria-current');
        if (ariaCurrent !== null) {
          return ariaCurrent !== 'false';
        }
        if (element instanceof HTMLOptionElement) {
          return element.selected;
        }
        if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
          return element.checked;
        }
        return null;
      });
    } catch {
      return null;
    }
  }

  private urlMatches(actual: string, expected: UrlExpectation): boolean {
    switch (expected.match) {
      case 'exact':
        return actual === expected.url;
      case 'prefix':
        return actual.startsWith(expected.url);
      case 'contains':
        return actual.includes(expected.url);
    }
  }

  private async waitForUrlExpectation(
    page: Page,
    expected: UrlExpectation,
    timeoutMs: number,
    operation: string,
  ): Promise<void> {
    const startedAt = Date.now();
    do {
      if (this.urlMatches(page.url(), expected)) {
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        break;
      }
      await page.waitForTimeout(Math.min(100, Math.max(1, timeoutMs - (Date.now() - startedAt))));
    } while (Date.now() - startedAt < timeoutMs);

    throw new Stage5BrowserError('POSTCONDITION_FAILED', `${operation} did not observe the expected URL.`, {
      recoverable: true,
      details: {
        reason: 'url_expectation_not_met',
        expected: { ...expected, url: this.safeObservedUrl(expected.url) },
        currentUrl: this.safeObservedUrl(page.url()),
        suggestedAction: 'Inspect the current page and redirect state before deciding whether another action is safe.',
      },
    });
  }

  private async scrollPosition(frame: Frame): Promise<ScrollPosition> {
    return frame.evaluate(() => {
      const root = (document.scrollingElement ?? document.documentElement) as HTMLElement;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const contentWidth = Math.max(
        root.scrollWidth,
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0,
      );
      const contentHeight = Math.max(
        root.scrollHeight,
        document.documentElement.scrollHeight,
        document.body?.scrollHeight ?? 0,
      );
      return {
        x: root.scrollLeft,
        y: root.scrollTop,
        maxX: Math.max(0, contentWidth - viewportWidth),
        maxY: Math.max(0, contentHeight - viewportHeight),
        viewportWidth,
        viewportHeight,
        contentWidth,
        contentHeight,
      };
    });
  }

  private async performScrollStep(
    frame: Frame,
    direction: 'up' | 'down',
    amount: 'half_viewport' | 'viewport' | 'document_start' | 'document_end',
  ): Promise<void> {
    await frame.evaluate(({ direction: fixedDirection, amount: fixedAmount }) => {
      const root = (document.scrollingElement ?? document.documentElement) as HTMLElement;
      if (fixedAmount === 'document_start') {
        root.scrollTo({ top: 0, behavior: 'instant' });
        return;
      }
      if (fixedAmount === 'document_end') {
        root.scrollTo({ top: root.scrollHeight, behavior: 'instant' });
        return;
      }
      const multiplier = fixedAmount === 'half_viewport' ? 0.5 : 1;
      const sign = fixedDirection === 'down' ? 1 : -1;
      root.scrollBy({ top: window.innerHeight * multiplier * sign, behavior: 'instant' });
    }, { direction, amount });
  }

  private async authenticationStatus(page: Page | undefined): Promise<AuthenticationStatus> {
    const context = this.usableContext();
    const connected = context !== undefined;
    const handoff = this.authenticationHandoff;
    const targetPageIndex = page === undefined || context === undefined
      ? -1
      : context.pages().filter((candidate) => !candidate.isClosed()).indexOf(page);
    const state = handoff?.state ?? (connected ? 'profile_ready' : 'browser_stopped');
    const processState = handoff?.session.state() ?? null;
    const profileBinding = handoff?.launchIdentity.profile
      ?? this.controlledLaunchIdentity?.profile
      ?? profileBindingForBrowser(
        profileDirForBrowser(this.config, this.selectedBrowser),
        BROWSER_ENGINES[this.selectedBrowser],
      );
    return {
      browser: this.selectedBrowser,
      browserConnected: connected,
      state,
      authenticated: 'unknown',
      persistentProfile: true,
      profileBinding,
      targetOrigin: handoff?.targetOrigin ?? (page === undefined ? null : this.urlOrigin(page.url())),
      requestedAt: handoff?.requestedAt ?? null,
      resumedAt: handoff?.resumedAt ?? null,
      targetPageIndex: targetPageIndex < 0 ? null : targetPageIndex,
      targetPageAvailable: targetPageIndex >= 0,
      page: page === undefined ? null : await this.pageSummary(page),
      verificationRequired: state === 'ready_for_agent_verification',
      controlMode: handoff?.state === 'awaiting_user'
        ? 'human_bootstrap'
        : connected
          ? 'playwright'
          : 'none',
      humanBootstrap: handoff === null || processState === null
        ? null
        : {
            running: processState.running,
            processId: processState.processId,
            launchedAt: processState.launchedAt,
            controlledByPlaywright: false,
            automationFlagsPresent: false,
            exactUserInteractionsObserved: false,
            launchIdentity: handoff.launchIdentity,
            handoffLabel: handoff.handoffLabel,
            profileShutdown: handoff.profileShutdown,
          },
      lastHandoffOutcome: this.lastHandoffOutcome,
    };
  }

  private humanBootstrapInProgressError(
    message = 'Private human authentication is in progress in the dedicated Stage5 browser window.',
  ): Stage5BrowserError {
    const applicationName = this.authenticationHandoff?.launchIdentity.applicationName ?? 'the dedicated browser';
    return new Stage5BrowserError('AUTH_HANDOFF_REQUIRED', message, {
      recoverable: true,
      details: {
        reason: 'human_authentication_in_progress',
        suggestedAction: `Finish authentication and quit ${applicationName} normally so its process exits, then call browser_resume_after_login. On macOS, use Cmd-Q in that exact application; closing only a tab or window may leave it running. Stage5 Browser will not control or force-close it.`,
      },
    });
  }

  private clearControlledBrowserState(): void {
    this.context = undefined;
    this.activePage = undefined;
    this.framesById.clear();
    this.observedSnapshots.clear();
    this.frameIds = new WeakMap<Frame, string>();
    this.frameDocumentVersions = new WeakMap<Frame, number>();
    this.boundPages = new WeakSet<Page>();
    this.runtimeProfileObservation = null;
    this.controlledStartBoundary = null;
    this.state = 'stopped';
  }

  private humanBootstrapTargetUrl(value: string): string {
    if (value === 'about:blank') {
      return value;
    }
    return validateNavigationUrl(value);
  }

  private authenticationHandoffLabel(
    identity: BrowserLaunchIdentity,
    targetOrigin: string | null,
  ): string {
    const target = targetOrigin === null ? 'local page' : new URL(targetOrigin).hostname;
    return `Stage5 ${identity.browser} · ${identity.applicationName} · ${target} · ${randomUUID().slice(0, 8).toLocaleUpperCase()}`;
  }

  private validateAuthenticationUrlExpectation(expected: UrlExpectation): void {
    try {
      const parsed = new URL(expected.url);
      const originOnly = (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        && (parsed.pathname === '' || parsed.pathname === '/')
        && parsed.search.length === 0
        && parsed.hash.length === 0;
      if (!originOnly) {
        return;
      }
    } catch {
      return;
    }

    throw new Stage5BrowserError(
      'OPERATION_FAILED',
      'An origin-only URL is not strong enough to verify an authentication handoff.',
      {
        recoverable: true,
        details: {
          reason: 'auth_url_expectation_too_weak',
          expected: expected.url,
          match: expected.match,
          suggestedAction: 'Use a post-login path such as an account home route, or pass no URL expectation and verify the returned semantic preview plus a fresh snapshot.',
        },
      },
    );
  }

  private async authenticationVerificationPreview(
    page: Page,
  ): Promise<BrowserCommandOutput<'resumeAfterLogin'>['verificationPreview']> {
    const depth = 6;
    const snapshot = await boundedValue(
      page.locator('body').ariaSnapshot({ mode: 'ai', depth, boxes: false, timeout: 1_000 }),
      1_500,
      null,
    );
    if (snapshot === null) {
      return {
        observation: 'bounded_semantic_preview',
        available: false,
        depth,
        snapshot: null,
      };
    }

    const privacyMinimizedSnapshot = snapshot
      .split('\n')
      .filter((line) => !/\b(textbox|searchbox|combobox)\b/i.test(line))
      .slice(0, 200)
      .join('\n')
      .slice(0, 20_000);
    return {
      observation: 'bounded_semantic_preview',
      available: true,
      depth,
      snapshot: privacyMinimizedSnapshot,
    };
  }

  private isWebUrl(value: string): boolean {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private async semanticFingerprint(page: Page): Promise<string | null> {
    const snapshot = await boundedValue(
      page.locator('body').ariaSnapshot({ mode: 'ai', depth: 10, boxes: false, timeout: 1_000 }),
      1_500,
      null,
    );
    if (snapshot === null) {
      return null;
    }
    const normalized = snapshot
      .replaceAll(/\[ref=[^\]]+\]/g, '')
      .replaceAll(/\s+/g, ' ')
      .trim()
      .slice(0, 500_000);
    return privacyFingerprint(normalized);
  }

  private urlOrigin(value: string): string | null {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
    } catch {
      return null;
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

  private async requireUniqueClickTarget(
    page: Page,
    locator: Locator,
    action: SanitizedActionDiagnostic['action'],
    role: string,
    name: string,
  ): Promise<SafeTargetState | null> {
    const count = await locator.count();
    if (count === 0) {
      this.pageDiagnostics.recordAction(
        page,
        this.targetingFailureDiagnostic(action, page, 'target_missing'),
      );
      throw new Stage5BrowserError('TARGET_NOT_FOUND', 'No element matched the requested role and accessible name.', {
        details: { role, name },
      });
    }
    if (count > 1) {
      this.pageDiagnostics.recordAction(
        page,
        this.targetingFailureDiagnostic(action, page, 'ambiguous_target'),
      );
      throw new Stage5BrowserError('AMBIGUOUS_TARGET', 'Multiple elements matched; Stage5 Browser will not choose one arbitrarily.', {
        details: { role, name, matchCount: count },
      });
    }
    return inspectTargetState(locator);
  }

  private targetingFailureDiagnostic(
    action: SanitizedActionDiagnostic['action'],
    page: Page,
    reason: 'ambiguous_target' | 'target_missing',
  ): SanitizedActionDiagnostic {
    const occurredAt = new Date().toISOString();
    return {
      action,
      outcome: 'blocked',
      reason,
      clickDispatched: false,
      targetState: null,
      pageUrl: sanitizeUrlForJournal(page.url()) ?? null,
      startedAt: occurredAt,
      occurredAt,
    };
  }

  private successfulActionDiagnostic(
    action: SanitizedActionDiagnostic['action'],
    page: Page,
    targetState: SafeTargetState | null,
    startedAt: string,
  ): SanitizedActionDiagnostic {
    return {
      action,
      outcome: 'succeeded',
      reason: null,
      clickDispatched: true,
      targetState,
      pageUrl: sanitizeUrlForJournal(page.url()) ?? null,
      startedAt,
      occurredAt: new Date().toISOString(),
    };
  }

  private postconditionFailureDiagnostic(
    action: SanitizedActionDiagnostic['action'],
    page: Page,
    targetState: SafeTargetState | null,
    startedAt: string,
  ): SanitizedActionDiagnostic {
    return {
      action,
      outcome: 'postcondition_failed',
      reason: 'postcondition_not_met',
      clickDispatched: true,
      targetState,
      pageUrl: sanitizeUrlForJournal(page.url()) ?? null,
      startedAt,
      occurredAt: new Date().toISOString(),
    };
  }

  private clickFailureError(
    diagnostic: SanitizedActionDiagnostic,
    cause: unknown,
  ): Stage5BrowserError {
    return new Stage5BrowserError(
      'OPERATION_FAILED',
      'The click did not complete. Sanitized actionability evidence is available from browser_diagnostics.',
      {
        recoverable: true,
        details: {
          reason: diagnostic.reason,
          clickDispatched: diagnostic.clickDispatched,
          actionOutcome: diagnostic.outcome,
          targetState: diagnostic.targetState,
          suggestedAction: diagnostic.clickDispatched === false
            ? 'Correct the reported visibility, enabled-state, or pointer-interception condition before retrying.'
            : 'Inspect authoritative page state before retrying because dispatch could not be ruled out.',
        },
        cause,
      },
    );
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
