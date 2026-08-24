import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import type {
  Browser,
  BrowserContext,
  ElementHandle,
  Frame,
  Locator,
  Page,
  Request,
  Response,
} from 'playwright';

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
  nativeControlEndpoint,
  processIsRunning,
  readNativeControlRecord,
  removeNativeControlRecord,
  writeNativeControlRecord,
  type NativeControlRecord,
} from './native-control-channel.js';
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
  FileInputObservation,
  FileProcessingExpectation,
  FileSelectionWarning,
  FrameSummary,
  NavigationWarning,
  PageSummary,
  PostconditionCheck,
  PostconditionResult,
  RedirectHop,
  ScrollPosition,
  ScrollEndState,
  UrlExpectation,
  VisibleElementExpectation,
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
  fileInputs: Map<string, ObservedFileInput>;
}

interface ObservedFileInput {
  handle: ElementHandle<HTMLInputElement>;
  observation: FileInputObservation;
}

interface LocalFileSelection {
  canonicalPath: string;
  name: string;
  sizeBytes: number;
}

interface FileInputEventObservation {
  inputEventObserved: boolean;
  changeEventObserved: boolean;
  files: Array<{ name: string; sizeBytes: number }>;
}

interface ProgressSample {
  visibleCount: number;
  activeCount: number;
  completedCount: number;
  maxPercent: number | null;
}

interface ScrollHistory {
  dynamicGrowthObserved: boolean;
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
const MAX_FILE_INPUTS_PER_SNAPSHOT = 20;

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
  private readonly scrollHistories = new WeakMap<Frame, ScrollHistory>();
  private readonly pageDiagnostics = new PageDiagnosticBuffer();
  private boundPages = new WeakSet<Page>();
  private lastLaunchFailure: LaunchFailureDiagnostic | null = null;
  private authenticationHandoff: AuthenticationHandoff | null = null;
  private lastHandoffOutcome: AuthenticationBoundaryOutcome | null = null;
  private controlledLaunchIdentity: BrowserLaunchIdentity | null = null;
  private runtimeProfileObservation: RuntimeProfileObservation | null = null;
  private controlledStartBoundary: ControlledStartBoundaryObservation | null = null;
  private nativeAttachedBrowser: Browser | undefined;
  private nativeControlRecord: NativeControlRecord | null = null;

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

      if (launchTarget.engine === 'chromium') {
        const nativeRecord = await readNativeControlRecord(profileDir, this.selectedBrowser);
        if (nativeRecord !== null) {
          if (processIsRunning(nativeRecord.processId)) {
            if (nativeRecord.state === 'awaiting_user') {
              throw new Stage5BrowserError(
                'AUTH_HANDOFF_REQUIRED',
                'A private Chromium login handoff is still awaiting explicit resume.',
                {
                  recoverable: true,
                  details: {
                    reason: 'native_handoff_awaiting_user',
                    suggestedAction: 'Return to the agent that requested the handoff and call browser_resume_after_login after private login. If that agent session is unavailable, close the dedicated browser normally, then start a new handoff.',
                  },
                },
              );
            }
            return await this.attachToNativeChromium(
              nativeRecord,
              launchIdentity,
              authenticationProbeTargetOrigin,
            );
          }
          await removeNativeControlRecord(profileDir);
        }
      }

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
      return await this.activateControlledContext(
        context,
        launchIdentity,
        launchTarget.engine,
        authenticationProbeTargetOrigin,
      );
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
            reason: error.details?.reason ?? diagnostic.reason,
            suggestedAction: error.details?.suggestedAction ?? diagnostic.suggestedAction,
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
    const nativeChromiumProcess = this.nativeAttachedBrowser !== undefined
      || this.authenticationHandoff?.session.controlChannel?.()?.kind === 'chromium_cdp';
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
        process.platform,
        nativeChromiumProcess,
      ),
      automationExposure: {
        controlMode,
        controlledByPlaywright: controlMode === 'playwright',
        enableAutomationArgument: controlMode === 'human_bootstrap' || nativeChromiumProcess
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
        'The private authentication handoff must be completed by the user before Stage5 Browser can stop or switch it.',
      );
    }
    const context = this.context;
    const nativeBrowser = this.nativeAttachedBrowser;
    const nativeRecord = this.nativeControlRecord;
    this.context = undefined;
    this.activePage = undefined;
    this.framesById.clear();
    this.discardAllObservedSnapshots();
    this.frameIds = new WeakMap<Frame, string>();
    this.frameDocumentVersions = new WeakMap<Frame, number>();
    this.boundPages = new WeakSet<Page>();
    this.authenticationHandoff = null;
    this.controlledLaunchIdentity = null;
    this.runtimeProfileObservation = null;
    this.controlledStartBoundary = null;
    this.nativeAttachedBrowser = undefined;
    this.nativeControlRecord = null;
    this.state = 'stopped';

    if (nativeBrowser !== undefined && nativeRecord !== null) {
      await this.closeOwnedNativeBrowser(context, nativeBrowser, nativeRecord);
      await removeNativeControlRecord(profileDirForBrowser(this.config, this.selectedBrowser));
    } else if (context !== undefined && !context.isClosed()) {
      await context.close({ reason: 'Stage5 Browser stopped the owned browser context.' });
    }

    return this.status();
  }

  async detachForWorkerShutdown(): Promise<void> {
    const nativeBrowser = this.nativeAttachedBrowser;
    if (nativeBrowser === undefined) {
      await this.stop();
      return;
    }

    this.context = undefined;
    this.activePage = undefined;
    this.nativeAttachedBrowser = undefined;
    this.nativeControlRecord = null;
    this.state = 'stopped';
    await nativeBrowser.close().catch(() => undefined);
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
    const documentVersion = this.documentVersion(frame);
    const root = await this.snapshotRoot(frame);
    const snapshot = await root.locator.ariaSnapshot({
      mode: 'ai',
      depth: input.depth,
      boxes: input.boxes,
      timeout: input.timeoutMs,
    });
    const refs = new Set(snapshot.match(/\[ref=([^\]]+)\]/g)?.map((value) => value.slice(5, -1)) ?? []);
    const observedFileInputs = await this.observeFileInputs(root.locator);
    if (frame.isDetached() || this.documentVersion(frame) !== documentVersion) {
      for (const { handle } of observedFileInputs.inputs.values()) {
        await handle.dispose().catch(() => undefined);
      }
      throw new Stage5BrowserError(
        'TARGET_NOT_FOUND',
        'The document changed while the semantic snapshot was being captured.',
        {
          recoverable: true,
          details: {
            reason: 'document_changed_during_snapshot',
            suggestedAction: 'Wait for the current page to stabilize, then take one fresh snapshot.',
          },
        },
      );
    }
    const snapshotId = randomUUID();
    this.discardObservedSnapshot(frame);
    this.observedSnapshots.set(frame, {
      id: snapshotId,
      documentVersion,
      refs,
      fileInputs: observedFileInputs.inputs,
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
      fileInputCount: observedFileInputs.inputs.size,
      fileInputs: [...observedFileInputs.inputs.values()].map(({ observation }) => observation),
      scope: root.scope,
      visibleModalCount: root.visibleModalCount,
      warnings: [
        ...root.warnings,
        ...(observedFileInputs.truncated
          ? [{
              code: 'file_input_list_truncated' as const,
              message: `The frame contains more than ${MAX_FILE_INPUTS_PER_SNAPSHOT} file inputs; only the first bounded set was observed.`,
              suggestedAction: 'Narrow to the intended frame or page state before selecting a file input; Stage5 Browser will not guess among unobserved controls.',
            }]
          : []),
      ],
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
      this.discardObservedSnapshot(frame);
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
      this.discardObservedSnapshot(frame);
    }
  }

  async setInputFiles(
    input: BrowserCommandInput<'setInputFiles'>,
  ): Promise<BrowserCommandOutput<'setInputFiles'>> {
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
        'The file-input reference does not belong to the latest snapshot of the current document.',
        {
          details: {
            reason: 'stale_or_unknown_snapshot',
            snapshotId: input.snapshotId,
            frameId: input.frameId,
          },
        },
      );
    }
    const target = observed.fileInputs.get(input.ref);
    if (target === undefined) {
      throw new Stage5BrowserError(
        'TARGET_NOT_FOUND',
        'The requested file-input reference was not present in that snapshot.',
        {
          details: {
            reason: 'file_input_reference_not_observed',
            ref: input.ref,
            snapshotId: input.snapshotId,
          },
        },
      );
    }

    const files = await this.preflightLocalFiles(input.paths);
    const liveInput = await this.inspectFileInput(target.handle);
    if (liveInput === null) {
      throw new Stage5BrowserError(
        'TARGET_NOT_FOUND',
        'The observed file input is no longer attached to the current document.',
        {
          details: {
            reason: 'file_input_detached',
            ref: input.ref,
            snapshotId: input.snapshotId,
          },
        },
      );
    }
    if (liveInput.disabled) {
      throw new Stage5BrowserError('OPERATION_FAILED', 'The observed file input is disabled.', {
        recoverable: true,
        details: {
          reason: 'file_input_disabled',
          ref: input.ref,
          suggestedAction: 'Inspect the current page state and obtain a fresh snapshot after the upload control becomes enabled.',
        },
      });
    }
    if (!liveInput.multiple && files.length > 1) {
      throw new Stage5BrowserError('INVALID_FILE', 'The observed file input accepts only one file.', {
        details: {
          reason: 'file_input_does_not_accept_multiple',
          suppliedFileCount: files.length,
        },
      });
    }

    const diagnosticsBefore = this.pageDiagnostics.snapshot(page);
    const processingBaseline = {
      completeVisible: input.completion?.expectedComplete === null || input.completion === null
        ? false
        : await this.visibleExpectationObserved(page, input.completion.expectedComplete),
      errorVisible: input.completion?.expectedError === null || input.completion === null
        ? false
        : await this.visibleExpectationObserved(page, input.completion.expectedError),
      progress: await this.progressSample(frame),
    };
    const startedAtMs = Date.now();
    this.consumeObservedSnapshot(frame, target.handle);
    const eventObservationKey = await this.armFileInputEventObservation(target.handle);
    try {
      await target.handle.setInputFiles(
        files.map((file) => file.canonicalPath),
        { timeout: input.timeoutMs },
      );
    } catch (error) {
      if (eventObservationKey !== null) {
        await this.collectFileInputEventObservation(target.handle, eventObservationKey);
      }
      await target.handle.dispose().catch(() => undefined);
      throw new Stage5BrowserError(
        'OPERATION_FAILED',
        'The browser could not set the observed file input.',
        {
          recoverable: true,
          details: {
            reason: 'file_selection_failed',
            fileSelectionDispatched: 'unknown',
            actionOutcome: 'file_selection_outcome_unknown',
            suggestedAction: 'Inspect the current composer before selecting the file again; the failed operation is not replayed automatically.',
          },
          cause: error,
        },
      );
    }

    const selectedFiles = await this.selectedFileMetadata(target.handle);
    const eventObservation = eventObservationKey === null
      ? null
      : await this.collectFileInputEventObservation(target.handle, eventObservationKey);
    await target.handle.dispose().catch(() => undefined);
    const retainedSelectionConfirmed = this.fileMetadataMatches(selectedFiles, files);
    const eventSelectionConfirmed = eventObservation !== null
      && (eventObservation.inputEventObserved || eventObservation.changeEventObserved)
      && this.fileMetadataMatches(eventObservation.files, files);
    const selectionConfirmed = retainedSelectionConfirmed || eventSelectionConfirmed;
    if (!selectionConfirmed) {
      throw new Stage5BrowserError(
        'POSTCONDITION_FAILED',
        'The file selection was dispatched, but the browser did not expose the expected file metadata during selection.',
        {
          recoverable: true,
          details: {
            reason: 'file_selection_not_confirmed',
            fileSelectionDispatched: true,
            actionOutcome: 'file_selection_dispatched_postcondition_failed',
            expectedFileCount: files.length,
            observedFileCount: selectedFiles.length,
            selectionEventObserved:
              eventObservation?.inputEventObserved === true || eventObservation?.changeEventObserved === true,
            suggestedAction: 'Inspect the current composer before any retry. Do not select the file again unless a fresh snapshot proves no attachment exists.',
          },
        },
      );
    }

    const processing = await this.observeFileProcessing(
      page,
      frame,
      input.completion,
      input.observationMs,
      Math.max(0, input.timeoutMs - (Date.now() - startedAtMs)),
      diagnosticsBefore,
      processingBaseline,
    );

    let attachmentPreview: BrowserCommandOutput<'setInputFiles'>['attachmentPreview'] = {
      observation: 'bounded_semantic_preview',
      available: false,
      depth: input.previewDepth,
      snapshotId: null,
      snapshot: null,
    };
    const warnings: FileSelectionWarning[] = [...processing.warnings];
    try {
      const remaining = Math.max(100, input.timeoutMs - (Date.now() - startedAtMs));
      const preview = await this.snapshot({
        depth: input.previewDepth,
        boxes: false,
        frameId: input.frameId,
        timeoutMs: remaining,
      });
      attachmentPreview = {
        observation: 'bounded_semantic_preview',
        available: true,
        depth: input.previewDepth,
        snapshotId: preview.snapshotId,
        snapshot: preview.snapshot,
      };
    } catch {
      warnings.push({
        code: 'attachment_preview_unavailable',
        message: 'The browser input event confirmed the selected file, but a bounded semantic preview could not be captured.',
        suggestedAction: 'Do not select the file again. Take one fresh snapshot to inspect attachment and processing state.',
      });
    }

    this.lastKnownUrl = page.url();
    return {
      page: await this.pageSummary(page),
      frame: this.frameSummary(frame, page),
      selection: {
        dispatched: true,
        confirmedByInput: true,
        fileCount: files.length,
        totalBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
        files: files.map(({ name, sizeBytes }) => ({ name, sizeBytes })),
      },
      attachmentPreview,
      processing: processing.result,
      warnings,
    };
  }

  async fillByRole(input: BrowserCommandInput<'fillByRole'>): Promise<BrowserCommandOutput<'fillByRole'>> {
    const page = await this.ensureActivePage(await this.ensureContext());
    const frame = this.resolveFrame(page, input.frameId);
    const locator = frame.getByRole(input.role, { name: input.name, exact: input.exact });
    await this.requireUniqueTarget(locator.count(), input.role, input.name);
    await locator.fill(input.value, { timeout: input.timeoutMs });
    this.lastKnownUrl = page.url();
    this.discardObservedSnapshot(frame);
    return { page: await this.pageSummary(page), frame: this.frameSummary(frame, page) };
  }

  async scroll(input: BrowserCommandInput<'scroll'>): Promise<BrowserCommandOutput<'scroll'>> {
    const page = await this.ensureActivePage(await this.ensureContext());
    const frame = this.resolveFrame(page, input.frameId);
    const before = await this.scrollPosition(frame);
    const startedAt = Date.now();
    let stepsCompleted = 0;
    let previous = before;
    let contentGrew = false;
    let finalStepMoved = false;
    let finalStepGrew = false;

    for (let step = 0; step < input.count; step += 1) {
      if (Date.now() - startedAt + input.settleMs >= input.timeoutMs) {
        break;
      }
      await this.performScrollStep(frame, input.direction, input.amount);
      stepsCompleted += 1;
      if (input.settleMs > 0) {
        await page.waitForTimeout(input.settleMs);
      }
      const current = await this.scrollPosition(frame);
      finalStepMoved = previous.x !== current.x || previous.y !== current.y;
      finalStepGrew =
        current.contentHeight > previous.contentHeight ||
        current.contentWidth > previous.contentWidth;
      contentGrew ||= finalStepGrew;
      previous = current;
      if (input.amount === 'document_start' || input.amount === 'document_end') {
        break;
      }
    }

    const after = stepsCompleted === 0 ? await this.scrollPosition(frame) : previous;
    const moved = before.x !== after.x || before.y !== after.y;
    contentGrew ||=
      after.contentHeight > before.contentHeight ||
      after.contentWidth > before.contentWidth;
    const documentBoundaryReached = input.amount === 'document_start'
      ? after.y <= 0
      : input.amount === 'document_end'
        ? after.y >= after.maxY
        : input.direction === 'down'
          ? after.y >= after.maxY
          : after.y <= 0;
    const priorHistory = this.scrollHistories.get(frame);
    const dynamicGrowthObserved = contentGrew || priorHistory?.dynamicGrowthObserved === true;
    this.scrollHistories.set(frame, { dynamicGrowthObserved });
    const endMarkerObserved = input.endMarker === null
      ? false
      : await this.visibleExpectationObserved(page, input.endMarker);
    const movingTowardDocumentStart =
      input.amount === 'document_start' ||
      (input.amount !== 'document_end' && input.direction === 'up');
    const dynamicContentStalled =
      documentBoundaryReached &&
      !movingTowardDocumentStart &&
      !finalStepMoved &&
      !finalStepGrew &&
      dynamicGrowthObserved;
    let endState: ScrollEndState;
    if (endMarkerObserved) {
      endState = 'confirmed_by_marker';
    } else if (documentBoundaryReached && movingTowardDocumentStart) {
      endState = 'confirmed_document_start';
    } else if (dynamicContentStalled) {
      endState = 'dynamic_content_stalled';
    } else if (documentBoundaryReached) {
      endState = 'geometric_boundary_unconfirmed';
    } else {
      endState = 'not_at_boundary';
    }
    const endReached = endState === 'confirmed_by_marker' || endState === 'confirmed_document_start';
    this.lastKnownUrl = page.url();
    this.discardObservedSnapshot(frame);
    const warnings: BrowserCommandOutput<'scroll'>['warnings'] = [];
    if (!moved && !contentGrew) {
      warnings.push({
        code: 'scroll_position_unchanged',
        message: 'The requested scroll did not change the document position or size.',
        suggestedAction: 'Inspect the current snapshot for a nested scroll container, a stalled dynamic feed, or an explicit end marker.',
      });
    }
    if (dynamicContentStalled) {
      warnings.push({
        code: 'dynamic_content_stalled',
        message: 'The document is at its current geometric boundary after earlier dynamic growth, but the feed end is not confirmed.',
        suggestedAction: 'Do not treat this as the end of the feed. Inspect for loading, rate-limit, or retry state, or supply a visible end marker on a later bounded scroll.',
      });
    } else if (endState === 'geometric_boundary_unconfirmed') {
      warnings.push({
        code: 'scroll_end_unconfirmed',
        message: 'The document reached its current geometric boundary without an explicit end marker.',
        suggestedAction: 'Treat the feed end as unconfirmed; inspect the page or provide a visible end marker instead of assuming all dynamic content loaded.',
      });
    }
    return {
      page: await this.pageSummary(page),
      frame: this.frameSummary(frame, page),
      before,
      after,
      stepsCompleted,
      moved,
      contentGrew,
      documentBoundaryReached,
      endReached,
      endState,
      warnings,
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
              ? this.authenticationHandoff.session.controlChannel?.()?.kind === 'chromium_cdp'
                ? 'Finish authentication, leave the dedicated browser open, then call browser_resume_after_login so Stage5 attaches to that same process.'
                : 'Finish authentication and quit the dedicated browser normally so its process exits, then call browser_resume_after_login.'
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
    const continuousAttachment = session.controlChannel?.()?.kind === 'chromium_cdp';
    return {
      ...(await this.authenticationStatus(undefined)),
      userActionRequired: true,
      instructions: continuousAttachment
        ? `Authenticate only in the newly opened ${humanLaunchIdentity.applicationName} window identified as “${handoffLabel}”. It uses the Stage5 ${humanLaunchIdentity.browser} profile partition “${humanLaunchIdentity.profile.profileDirectory ?? 'profile root'}” for ${targetOrigin ?? 'the requested page'}. Leave that exact browser application open after login and tell the agent to call browser_resume_after_login; Stage5 Browser will attach to the same running process without restarting it. Do not send credentials, passkeys, CAPTCHAs, or OTPs to the agent.`
        : `Authenticate only in the newly opened ${humanLaunchIdentity.applicationName} window identified as “${handoffLabel}”. It uses the Stage5 ${humanLaunchIdentity.browser} profile partition “${humanLaunchIdentity.profile.profileDirectory ?? 'profile root'}” for ${targetOrigin ?? 'the requested page'}. Then quit ${humanLaunchIdentity.applicationName} normally so its process exits. On macOS, use Cmd-Q in that exact application; closing only a tab or window may leave it running. Do not send credentials, passkeys, CAPTCHAs, or OTPs to the agent. After it has quit, tell the agent to call browser_resume_after_login.`,
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
    const continuousChromiumHandoff = handoff.launchIdentity.engine === 'chromium'
      && handoff.session.controlChannel?.()?.kind === 'chromium_cdp';
    if (continuousChromiumHandoff && !processState.running) {
      await removeNativeControlRecord(handoff.profileDir);
      this.authenticationHandoff = null;
      this.state = 'stopped';
      throw new Stage5BrowserError(
        'AUTH_NOT_PERSISTED',
        'The dedicated browser was closed before Stage5 Browser could attach to the authenticated process.',
        {
          recoverable: true,
          details: {
            reason: 'human_browser_exited_before_attach',
            suggestedAction: 'Request a new login handoff and leave that dedicated browser open after authentication; Stage5 Browser now attaches without restarting it.',
          },
        },
      );
    }
    if (!continuousChromiumHandoff && processState.running) {
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

    let afterHumanStorage: ProfileStorageInspection | null = null;
    if (!continuousChromiumHandoff) {
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

      afterHumanStorage = await this.profileStorageInspector(
        handoff.launchIdentity.profile,
        handoff.launchIdentity.engine,
        handoff.targetOrigin,
      );
    }
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

    let continuousRecord: NativeControlRecord | null = null;
    if (continuousChromiumHandoff) {
      continuousRecord = await readNativeControlRecord(handoff.profileDir, this.selectedBrowser);
      if (
        continuousRecord === null
        || continuousRecord.processId !== processState.processId
        || !processIsRunning(continuousRecord.processId)
      ) {
        throw new Stage5BrowserError(
          'AUTH_NOT_PERSISTED',
          'The private browser control record no longer matches the authenticated process.',
          {
            recoverable: true,
            details: {
              reason: 'native_control_identity_mismatch',
              suggestedAction: 'Do not attach to another process. Close the dedicated Stage5 browser if it is still visible, then request a new handoff.',
            },
          },
        );
      }
      continuousRecord = { ...continuousRecord, state: 'controlled' };
      await writeNativeControlRecord(handoff.profileDir, continuousRecord);
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
      if (continuousRecord !== null && processIsRunning(continuousRecord.processId)) {
        await writeNativeControlRecord(handoff.profileDir, {
          ...continuousRecord,
          state: 'awaiting_user',
        }).catch(() => undefined);
      }
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
    const effectiveAfterHumanStorage = afterHumanStorage ?? afterControlledStartStorage;
    const storageComparison = compareAuthenticationStorage(
      handoff.beforeStorage,
      effectiveAfterHumanStorage,
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

  private async attachToNativeChromium(
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
      return status;
    } catch (error) {
      await browser.close().catch(() => undefined);
      if (this.nativeAttachedBrowser === browser) {
        this.clearControlledBrowserState();
      }
      throw error;
    }
  }

  private async activateControlledContext(
    context: BrowserContext,
    launchIdentity: BrowserLaunchIdentity,
    engine: (typeof BROWSER_ENGINES)[BrowserProduct],
    authenticationProbeTargetOrigin: string | null,
  ): Promise<BrowserStatus> {
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
  }

  private async closeOwnedNativeBrowser(
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
  }

  private bindContext(context: BrowserContext): void {
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
        this.context = undefined;
        this.activePage = undefined;
        this.framesById.clear();
        this.discardAllObservedSnapshots();
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
      this.discardObservedSnapshot(frame);
    });
    page.on('framedetached', (frame) => this.removeFrame(frame));
    page.on('crash', () => {
      this.recoverActivePageAfterLoss(page);
      this.removePageFrames(page);
    });
    page.on('close', () => {
      this.recoverActivePageAfterLoss(page);
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
  }

  private async reconcileVisiblePage(context: BrowserContext): Promise<void> {
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
    if (handoff !== null && visiblePages[0] !== handoff.page) {
      handoff.page = visiblePages[0];
      handoff.targetOrigin = this.urlOrigin(visiblePages[0].url());
    }
  }

  private recoverActivePageAfterLoss(lostPage: Page): void {
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
    this.discardObservedSnapshot(frame);
  }

  private removePageFrames(page: Page): void {
    for (const [id, frame] of this.framesById) {
      if (frame.page() === page) {
        this.framesById.delete(id);
        this.discardObservedSnapshot(frame);
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

  private async observeFileInputs(
    root: Locator,
  ): Promise<{ inputs: Map<string, ObservedFileInput>; truncated: boolean }> {
    const locator = root.locator('input[type="file"]');
    const total = await locator.count();
    const inputs = new Map<string, ObservedFileInput>();
    try {
      for (let index = 0; index < Math.min(total, MAX_FILE_INPUTS_PER_SNAPSHOT); index += 1) {
        const handle = await locator.nth(index).elementHandle() as ElementHandle<HTMLInputElement> | null;
        if (handle === null) {
          continue;
        }
        const live = await this.inspectFileInput(handle);
        if (live === null) {
          await handle.dispose().catch(() => undefined);
          continue;
        }
        const ref = `file-${randomUUID()}`;
        inputs.set(ref, {
          handle,
          observation: { ref, ...live },
        });
      }
    } catch (error) {
      for (const { handle } of inputs.values()) {
        await handle.dispose().catch(() => undefined);
      }
      throw error;
    }
    return { inputs, truncated: total > MAX_FILE_INPUTS_PER_SNAPSHOT };
  }

  private async inspectFileInput(
    handle: ElementHandle<HTMLInputElement>,
  ): Promise<Omit<FileInputObservation, 'ref'> | null> {
    try {
      return await handle.evaluate((element) => {
        if (!(element instanceof HTMLInputElement) || element.type.toLocaleLowerCase() !== 'file') {
          return null;
        }
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0';
        const labelledBy = (element.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ');
        const associatedLabels = Array.from(element.labels ?? [])
          .map((label) => label.innerText || label.textContent || '')
          .join(' ');
        const rawLabel = [
          element.getAttribute('aria-label') ?? '',
          labelledBy,
          associatedLabels,
          element.getAttribute('title') ?? '',
        ].find((candidate) => candidate.trim().length > 0) ?? '';
        const label = rawLabel.replace(/\s+/g, ' ').trim().slice(0, 200);
        const accept = element.accept.trim().slice(0, 500);
        return {
          accept: accept.length === 0 ? null : accept,
          multiple: element.multiple,
          disabled: element.disabled || element.getAttribute('aria-disabled') === 'true',
          visible,
          label: label.length === 0 ? null : label,
        };
      });
    } catch {
      return null;
    }
  }

  private async selectedFileMetadata(
    handle: ElementHandle<HTMLInputElement>,
  ): Promise<Array<{ name: string; sizeBytes: number }>> {
    try {
      return await handle.evaluate((element) => Array.from(element.files ?? []).map((file) => ({
        name: file.name,
        sizeBytes: file.size,
      })));
    } catch {
      return [];
    }
  }

  private async armFileInputEventObservation(
    handle: ElementHandle<HTMLInputElement>,
  ): Promise<string | null> {
    const key = `__stage5_file_input_${randomUUID().replaceAll('-', '')}`;
    try {
      await handle.evaluate((element, observationKey) => {
        const record: FileInputEventObservation = {
          inputEventObserved: false,
          changeEventObserved: false,
          files: [],
        };
        const listener = (event: Event): void => {
          if (event.target !== element) {
            return;
          }
          if (event.type === 'input') {
            record.inputEventObserved = true;
          }
          if (event.type === 'change') {
            record.changeEventObserved = true;
          }
          const observedFiles = Array.from(element.files ?? []).map((file) => ({
            name: file.name,
            sizeBytes: file.size,
          }));
          if (observedFiles.length > 0) {
            record.files = observedFiles;
          }
        };
        const eventTarget: EventTarget = element.ownerDocument.defaultView ?? element.ownerDocument;
        Object.defineProperty(element, observationKey, {
          configurable: true,
          enumerable: false,
          value: { eventTarget, record, listener },
        });
        eventTarget.addEventListener('input', listener, { capture: true });
        eventTarget.addEventListener('change', listener, { capture: true });
      }, key);
      return key;
    } catch {
      return null;
    }
  }

  private async collectFileInputEventObservation(
    handle: ElementHandle<HTMLInputElement>,
    key: string,
  ): Promise<FileInputEventObservation | null> {
    try {
      return await handle.evaluate((element, observationKey) => {
        const observedElement = element as HTMLInputElement & Record<string, unknown>;
        const stored = observedElement[observationKey] as {
          eventTarget: EventTarget;
          record: FileInputEventObservation;
          listener: EventListener;
        } | undefined;
        if (stored === undefined) {
          return null;
        }
        stored.eventTarget.removeEventListener('input', stored.listener, true);
        stored.eventTarget.removeEventListener('change', stored.listener, true);
        delete observedElement[observationKey];
        return stored.record;
      }, key);
    } catch {
      return null;
    }
  }

  private fileMetadataMatches(
    observed: Array<{ name: string; sizeBytes: number }>,
    expected: LocalFileSelection[],
  ): boolean {
    return observed.length === expected.length && observed.every((file, index) => {
      const expectedFile = expected[index];
      return expectedFile !== undefined
        && file.name === expectedFile.name
        && file.sizeBytes === expectedFile.sizeBytes;
    });
  }

  private async preflightLocalFiles(paths: string[]): Promise<LocalFileSelection[]> {
    const files: LocalFileSelection[] = [];
    for (let index = 0; index < paths.length; index += 1) {
      const suppliedPath = paths[index];
      if (suppliedPath === undefined || !path.isAbsolute(suppliedPath)) {
        throw new Stage5BrowserError('INVALID_FILE', 'Every selected file must use an absolute local path.', {
          details: { reason: 'file_path_not_absolute', fileIndex: index },
        });
      }
      let metadata;
      try {
        metadata = await lstat(suppliedPath);
      } catch {
        throw new Stage5BrowserError('INVALID_FILE', 'A selected local file does not exist or cannot be inspected.', {
          details: { reason: 'file_not_accessible', fileIndex: index },
        });
      }
      if (metadata.isSymbolicLink()) {
        throw new Stage5BrowserError('INVALID_FILE', 'Symbolic links cannot be selected for upload.', {
          details: { reason: 'file_is_symbolic_link', fileIndex: index },
        });
      }
      if (!metadata.isFile()) {
        throw new Stage5BrowserError('INVALID_FILE', 'Only regular local files can be selected for upload.', {
          details: { reason: 'file_is_not_regular', fileIndex: index },
        });
      }
      try {
        await access(suppliedPath, fsConstants.R_OK);
      } catch {
        throw new Stage5BrowserError('INVALID_FILE', 'A selected local file is not readable.', {
          details: { reason: 'file_not_readable', fileIndex: index },
        });
      }
      const canonicalPath = await realpath(suppliedPath);
      files.push({
        canonicalPath,
        name: path.basename(canonicalPath),
        sizeBytes: metadata.size,
      });
    }
    return files;
  }

  private consumeObservedSnapshot(
    frame: Frame,
    retainedHandle: ElementHandle<HTMLInputElement> | null = null,
  ): void {
    const observed = this.observedSnapshots.get(frame);
    this.observedSnapshots.delete(frame);
    if (observed === undefined) {
      return;
    }
    for (const { handle } of observed.fileInputs.values()) {
      if (handle !== retainedHandle) {
        void handle.dispose().catch(() => undefined);
      }
    }
  }

  private discardObservedSnapshot(frame: Frame): void {
    this.consumeObservedSnapshot(frame);
  }

  private discardAllObservedSnapshots(): void {
    for (const frame of this.observedSnapshots.keys()) {
      this.discardObservedSnapshot(frame);
    }
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
    while (true) {
      checks = await this.postconditionChecks(page, clickedFrame, clickedLocator, postcondition);
      if (checks.length > 0 && checks.every((check) => check.passed)) {
        return { passed: true, checks };
      }
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        break;
      }
      await page.waitForTimeout(Math.min(100, remaining));
    }

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
        const candidates: Element[] = [element];
        let ancestor = element.parentElement;
        for (let depth = 0; depth < 3 && ancestor !== null; depth += 1) {
          candidates.push(ancestor);
          ancestor = ancestor.parentElement;
        }
        for (const candidate of candidates) {
          const ariaSelected = candidate.getAttribute('aria-selected');
          if (ariaSelected !== null) {
            return ariaSelected === 'true';
          }
          const ariaChecked = candidate.getAttribute('aria-checked');
          if (ariaChecked !== null) {
            return ariaChecked === 'true';
          }
          const ariaPressed = candidate.getAttribute('aria-pressed');
          if (ariaPressed !== null) {
            return ariaPressed === 'true';
          }
          const ariaCurrent = candidate.getAttribute('aria-current');
          if (ariaCurrent !== null) {
            return ariaCurrent !== 'false';
          }
          if (candidate instanceof HTMLOptionElement) {
            return candidate.selected;
          }
          if (candidate instanceof HTMLInputElement && (candidate.type === 'checkbox' || candidate.type === 'radio')) {
            return candidate.checked;
          }
        }
        return null;
      });
    } catch {
      return null;
    }
  }

  private async visibleExpectationObserved(
    page: Page,
    expectation: VisibleElementExpectation,
  ): Promise<boolean> {
    try {
      const frame = expectation.frameId === null
        ? page.mainFrame()
        : this.resolveFrame(page, expectation.frameId);
      const locator = frame.getByRole(expectation.role, {
        name: expectation.name,
        exact: expectation.exact,
      });
      return (await locator.count()) === 1 && await locator.isVisible();
    } catch {
      return false;
    }
  }

  private async progressSample(frame: Frame): Promise<ProgressSample> {
    try {
      return await frame.locator('progress, [role="progressbar"]').evaluateAll((elements) => {
        let visibleCount = 0;
        let activeCount = 0;
        let completedCount = 0;
        let maxPercent: number | null = null;
        for (const element of elements) {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const visible =
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0';
          if (!visible) {
            continue;
          }
          visibleCount += 1;
          const nativeNow = element instanceof HTMLProgressElement ? element.value : Number.NaN;
          const nativeMax = element instanceof HTMLProgressElement ? element.max : Number.NaN;
          const ariaNow = Number.parseFloat(element.getAttribute('aria-valuenow') ?? '');
          const ariaMax = Number.parseFloat(element.getAttribute('aria-valuemax') ?? '');
          const now = Number.isFinite(nativeNow) ? nativeNow : ariaNow;
          const max = Number.isFinite(nativeMax) && nativeMax > 0 ? nativeMax : ariaMax;
          if (Number.isFinite(now) && Number.isFinite(max) && max > 0) {
            const percent = Math.max(0, Math.min(100, (now / max) * 100));
            maxPercent = maxPercent === null ? percent : Math.max(maxPercent, percent);
            if (now >= max) {
              completedCount += 1;
            } else {
              activeCount += 1;
            }
          } else {
            activeCount += 1;
          }
        }
        return { visibleCount, activeCount, completedCount, maxPercent };
      });
    } catch {
      return { visibleCount: 0, activeCount: 0, completedCount: 0, maxPercent: null };
    }
  }

  private async observeFileProcessing(
    page: Page,
    frame: Frame,
    expectation: FileProcessingExpectation | null,
    observationMs: number,
    remainingTimeoutMs: number,
    diagnosticsBefore: ReturnType<PageDiagnosticBuffer['snapshot']>,
    baseline: {
      completeVisible: boolean;
      errorVisible: boolean;
      progress: ProgressSample;
    },
  ): Promise<{
    result: BrowserCommandOutput<'setInputFiles'>['processing'];
    warnings: FileSelectionWarning[];
  }> {
    const budgetMs = Math.max(
      0,
      Math.min(expectation?.timeoutMs ?? observationMs, remainingTimeoutMs),
    );
    const startedAt = Date.now();
    let progressObserved = false;
    let completionValueObserved = false;
    let maxPercentObserved: number | null = null;
    let finalProgress: ProgressSample = {
      visibleCount: 0,
      activeCount: 0,
      completedCount: 0,
      maxPercent: null,
    };
    let expectedCompletionObserved = false;
    let expectedErrorObserved = false;
    let completionMarkerWasAbsent = !baseline.completeVisible;
    let errorMarkerWasAbsent = !baseline.errorVisible;
    let completedProgressWasAbsent = baseline.progress.completedCount === 0;

    while (true) {
      finalProgress = await this.progressSample(frame);
      progressObserved ||= finalProgress.visibleCount > 0;
      if (finalProgress.completedCount === 0) {
        completedProgressWasAbsent = true;
      } else if (completedProgressWasAbsent) {
        completionValueObserved = true;
      }
      if (finalProgress.maxPercent !== null) {
        maxPercentObserved = maxPercentObserved === null
          ? finalProgress.maxPercent
          : Math.max(maxPercentObserved, finalProgress.maxPercent);
      }
      if (expectation?.expectedError !== null && expectation?.expectedError !== undefined) {
        const visible = await this.visibleExpectationObserved(page, expectation.expectedError);
        if (!visible) {
          errorMarkerWasAbsent = true;
        } else if (errorMarkerWasAbsent) {
          expectedErrorObserved = true;
        }
      }
      if (!expectedErrorObserved && expectation?.expectedComplete !== null && expectation?.expectedComplete !== undefined) {
        const visible = await this.visibleExpectationObserved(page, expectation.expectedComplete);
        if (!visible) {
          completionMarkerWasAbsent = true;
        } else if (completionMarkerWasAbsent) {
          expectedCompletionObserved = true;
        }
      }
      if (expectedErrorObserved || expectedCompletionObserved || completionValueObserved) {
        break;
      }
      const remaining = budgetMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        break;
      }
      await page.waitForTimeout(Math.min(200, remaining));
    }

    const diagnosticsAfter = this.pageDiagnostics.snapshot(page);
    const successfulResponses = Math.max(
      0,
      diagnosticsAfter.totals.httpSuccesses - diagnosticsBefore.totals.httpSuccesses,
    );
    const redirects = Math.max(
      0,
      diagnosticsAfter.totals.httpRedirects - diagnosticsBefore.totals.httpRedirects,
    );
    const httpErrors = Math.max(
      0,
      diagnosticsAfter.totals.httpErrors - diagnosticsBefore.totals.httpErrors,
    );
    const failedRequests = Math.max(
      0,
      diagnosticsAfter.totals.failedRequests - diagnosticsBefore.totals.failedRequests,
    );
    const networkErrorObserved = httpErrors > 0 || failedRequests > 0;
    const activeAtReturn = finalProgress.activeCount > 0;
    const disappearedAfterObservation = progressObserved && finalProgress.visibleCount === 0;

    let state: BrowserCommandOutput<'setInputFiles'>['processing']['state'];
    let evidence: BrowserCommandOutput<'setInputFiles'>['processing']['evidence'];
    if (expectedErrorObserved) {
      state = 'error_observed';
      evidence = 'expected_error_visible';
    } else if (expectedCompletionObserved) {
      state = 'completion_observed';
      evidence = 'expected_completion_visible';
    } else if (completionValueObserved) {
      state = 'completion_observed';
      evidence = 'progress_complete';
    } else if (activeAtReturn) {
      state = 'in_progress';
      evidence = 'progress_active';
    } else if (networkErrorObserved) {
      state = 'error_observed';
      evidence = 'network_error_observed';
    } else if (disappearedAfterObservation) {
      state = 'unverified';
      evidence = 'progress_disappeared';
    } else {
      state = 'unverified';
      evidence = 'none';
    }

    const warnings: FileSelectionWarning[] = [];
    if (
      (baseline.completeVisible && !expectedCompletionObserved) ||
      (baseline.errorVisible && !expectedErrorObserved) ||
      (baseline.progress.visibleCount > 0 && !completionValueObserved)
    ) {
      warnings.push({
        code: 'processing_marker_preexisting',
        message: 'A supplied completion/error marker or completed progress control was already present before file selection and did not make a new transition.',
        suggestedAction: 'Treat the pre-existing marker as non-causal and inspect the fresh attachment preview for a new processing state.',
      });
    }
    if (state === 'error_observed') {
      warnings.push({
        code: 'processing_error_observed',
        message: expectedErrorObserved
          ? 'The caller-supplied processing error marker became visible.'
          : 'A failed request or HTTP error occurred during the bounded post-selection window; attribution to this upload is temporal only.',
        suggestedAction: 'Inspect the fresh attachment preview and page diagnostics before retrying or removing the attachment.',
      });
    }
    if (disappearedAfterObservation && !completionValueObserved && !expectedCompletionObserved) {
      warnings.push({
        code: 'progress_disappeared_unverified',
        message: 'A semantic progress control disappeared without an explicit completion value or caller-supplied completion marker.',
        suggestedAction: 'Treat processing as unverified and inspect the fresh preview; do not assume disappearance means success.',
      });
    }
    if (state === 'unverified') {
      warnings.push({
        code: 'processing_completion_unverified',
        message: 'The file-selection event was confirmed, but no explicit processing-completion signal was observed.',
        suggestedAction: 'Use the returned fresh snapshotId and preview, then inspect or wait for a service-visible completion state before posting.',
      });
    }

    return {
      result: {
        state,
        evidence,
        progress: {
          observed: progressObserved,
          activeAtReturn,
          completionValueObserved,
          disappearedAfterObservation,
          maxPercentObserved,
        },
        pageActivity: {
          attribution: 'temporal_only',
          observationMs: Date.now() - startedAt,
          successfulResponses,
          redirects,
          httpErrors,
          failedRequests,
        },
      },
      warnings,
    };
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
            controlledByPlaywright:
              connected
              && handoff.state === 'ready_for_agent_verification'
              && handoff.session.controlChannel?.()?.kind === 'chromium_cdp',
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
    const continuousAttachment = this.authenticationHandoff?.session.controlChannel?.()?.kind === 'chromium_cdp';
    return new Stage5BrowserError('AUTH_HANDOFF_REQUIRED', message, {
      recoverable: true,
      details: {
        reason: 'human_authentication_in_progress',
        suggestedAction: continuousAttachment
          ? `Finish authentication in ${applicationName}, leave that exact application open, then call browser_resume_after_login. Stage5 Browser will attach only after that explicit call.`
          : `Finish authentication and quit ${applicationName} normally so its process exits, then call browser_resume_after_login. On macOS, use Cmd-Q in that exact application; closing only a tab or window may leave it running. Stage5 Browser will not control or force-close it.`,
      },
    });
  }

  private clearControlledBrowserState(): void {
    this.context = undefined;
    this.activePage = undefined;
    this.framesById.clear();
    this.discardAllObservedSnapshots();
    this.frameIds = new WeakMap<Frame, string>();
    this.frameDocumentVersions = new WeakMap<Frame, number>();
    this.boundPages = new WeakSet<Page>();
    this.runtimeProfileObservation = null;
    this.controlledStartBoundary = null;
    this.nativeAttachedBrowser = undefined;
    this.nativeControlRecord = null;
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
