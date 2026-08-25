import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import type {
  Browser,
  BrowserContext,
  ElementHandle,
  Frame,
  JSHandle,
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
  type BrowserLaunchTarget,
  type BrowserProduct,
  type BrowserSelection,
} from './browser-provider.js';
import {
  controlledProfileOwnerEvidence,
  emptyProfileOwnerEvidence,
  inspectChromiumProfileOwner,
  type ChromiumProfileOwnerInspection,
  type ProfileOwnerEvidence,
} from './chromium-profile-owner.js';
import { profileDirForBrowser, type Stage5BrowserConfig } from './config.js';
import {
  browserLaunchPolicyDiagnostics,
  inspectProfile,
  launchFailureDiagnostic,
  suggestedActionForReason,
  type BrowserDiagnostics,
  type LaunchFailureDiagnostic,
  type ProfileDiagnostics,
} from './diagnostics.js';
import { Stage5BrowserError } from './errors.js';
import {
  actionDiagnosticForFailure,
  inspectTargetState,
  PageDiagnosticBuffer,
  privacyFingerprint,
  type SafeTargetState,
  type SanitizedActionDiagnostic,
  type SanitizedClickDispatchEvidence,
  type SanitizedNativeWindowActivationEvidence,
  type SanitizedPageActivationEvidence,
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
  chromiumProfileOwnerProcessId,
  NativeOwnedBrowserWindowActivator,
  type OwnedBrowserWindowActivator,
} from './native-window-activation.js';
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
import {
  inspectProfileOwnershipLease,
  observeLaunchedBrowserProcess,
  ownershipProfileUnlocked,
  ProfileOwnershipLeaseController,
  processStartedAtToken,
  removeProfileOwnershipLease,
  snapshotOwnedDescendants,
  terminateProvenOrphan,
  type ProfileOwnershipLeaseInspection,
  type OwnedProcessObservation,
} from './profile-ownership-lease.js';
import type {
  AuthenticationBoundaryOutcome,
  BrowserCommandInput,
  BrowserCommandOutput,
  BrowserLifecycleState,
  BrowserStatus,
  BrowserOperationalAvailability,
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
  ScrollContainerObservation,
  ScrollContentObservation,
  ScrollPosition,
  ScrollEndState,
  ScrollWaitResult,
  UrlExpectation,
  VisibleElementExpectation,
} from './protocol.js';
import {
  authenticationRouteMatches,
  sanitizeUrlForJournal,
  validateNavigationUrl,
} from './url-policy.js';

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
  scrollContainers: Map<string, ObservedScrollContainer>;
}

interface ObservedFileInput {
  handle: ElementHandle<HTMLInputElement>;
  observation: FileInputObservation;
}

interface ObservedScrollContainer {
  handle: ElementHandle<HTMLElement>;
  observation: ScrollContainerObservation;
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

interface ScrollContentObservationSurface {
  handle: ElementHandle<HTMLElement> | null;
  ownsHandle: boolean;
}

interface ScrollContentSample extends ScrollContentObservation {
  semanticLoadingIndicatorCount: number;
  animationLoadingIndicatorCount: number;
  animationObservationComplete: boolean;
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

interface PendingHandoffRelease {
  mode: 'human_bootstrap';
  state: 'releasing_control';
  requestedAt: string;
  launchTarget: BrowserLaunchTarget;
  profileDir: string;
  launchIdentity: BrowserLaunchIdentity;
  handoffLabel: string;
  targetUrl: string;
  targetOrigin: string | null;
  beforeUrl: string | null;
  beforeSemanticFingerprint: string | null;
  controlledBrowserProcess: OwnedProcessObservation;
  closeRequestCompleted: boolean;
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

interface SearchableTextLine {
  line: number;
  text: string;
}

interface ClickTargetSemanticIdentity {
  tagName: string;
  role: string | null;
  name: string;
  article: {
    fingerprint: string;
    tagName: string;
    role: string | null;
    nestingDepth: number;
  } | null;
}

interface PreparedObservedClickTarget {
  locator: Locator;
  handle: ElementHandle<HTMLElement | SVGElement>;
  targetState: SafeTargetState;
  activation: 'keyboard_enter' | 'pointer';
}

interface ClickDispatchConclusion {
  actionDispatched: boolean | 'unknown';
  clickDispatched: boolean | 'unknown';
}

type RawClickDispatchEvidence = Omit<
  SanitizedClickDispatchEvidence,
  'forcedFallbackUsed' | 'pageActivation' | 'pageMouseFallbackUsed'
>;

interface PageActivationObservation {
  documentFocused: boolean | null;
  visibility: SanitizedPageActivationEvidence['visibilityAfter'];
}

interface ChromiumTargetWindowPreparation {
  targetWindowResolved: boolean;
  windowStateBefore: SanitizedNativeWindowActivationEvidence['windowStateBefore'];
  normalizationAttempted: boolean;
  normalizationSucceeded: boolean | null;
}

interface ClickDispatchProbeController {
  snapshot: () => RawClickDispatchEvidence;
  finish: () => RawClickDispatchEvidence;
}

interface InstalledClickDispatchProbe {
  controller: JSHandle<ClickDispatchProbeController>;
  token: string;
}

interface ExternalClickDispatchObservation {
  page: Page;
  evidence: RawClickDispatchEvidence | null;
}

type VirtualizedClickResolution =
  | { kind: 'ambiguous' | 'missing' }
  | {
      kind: 'resolved';
      locator: Locator;
      handle: ElementHandle<HTMLElement | SVGElement>;
    };

const MAX_SEARCHABLE_TEXT_CHARACTERS = 2_000_000;
const TEXT_SNIPPET_CONTEXT = 100;
const TEXT_SNIPPET_SURROUNDING_LINES = 2;
const TEXT_SNIPPET_CONTEXT_SCAN_LINES = 12;
const TEXT_SNIPPET_CONTEXT_LINE_CHARACTERS = 160;
const CLICK_REF_VIEWPORT_PREPARATION_TIMEOUT_MS = 5_000;
const CLICK_REF_INCREMENTAL_SCROLL_STEPS = 32;
const CLICK_REF_INCREMENTAL_SETTLE_MS = 75;
const CLICK_REF_REBIND_SETTLE_MS = 500;
const CLICK_REF_ARTICLE_TEXT_CHARACTERS = 20_000;
const CLICK_REF_ARTICLE_CANDIDATES = 100;
const CLICK_REF_ELEMENT_CANDIDATES = 5_000;
const CLICK_REF_NORMAL_DISPATCH_TIMEOUT_MS = 750;
const CLICK_REF_FORCED_DISPATCH_TIMEOUT_MS = 750;
const CLICK_REF_DISPATCH_PROBE_GRACE_MS = 1_000;
const CLICK_ROLE_RESOLUTION_TIMEOUT_MS = 1_000;
const CLICK_RESULT_FINALIZATION_RESERVE_MS = 500;
const SCROLL_RESULT_FINALIZATION_RESERVE_MS = 750;
const HANDOFF_RESULT_FINALIZATION_RESERVE_MS = 500;
const SCREENSHOT_RENDER_SETTLE_MS = 100;
const NATIVE_WINDOW_ACTIVATION_TIMEOUT_MS = 1_000;
const NATIVE_WINDOW_NORMALIZATION_WAIT_MS = 750;
const NATIVE_WINDOW_VISIBILITY_WAIT_MS = 750;
const NATIVE_WINDOW_VISIBILITY_POLL_MS = 50;
const SCREENSHOT_MIN_COMPRESSED_BYTES_PER_PIXEL = 0.01;
const MAX_FILE_INPUTS_PER_SNAPSHOT = 20;
const MAX_SCROLL_CONTAINERS_PER_SNAPSHOT = 20;
const SCROLL_BOUNDARY_EPSILON_PX = 1;

function clickFinalizationReserve(timeoutMs: number): number {
  return Math.min(
    CLICK_RESULT_FINALIZATION_RESERVE_MS,
    Math.max(50, Math.floor(timeoutMs * 0.15)),
  );
}

function scrollFinalizationReserve(timeoutMs: number): number {
  return Math.min(
    SCROLL_RESULT_FINALIZATION_RESERVE_MS,
    Math.max(100, Math.floor(timeoutMs * 0.2)),
  );
}

function remainingUntil(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

function remainingHandoffWorkBudget(deadlineAt: number): number {
  const remaining = remainingUntil(deadlineAt);
  const reserve = Math.min(
    HANDOFF_RESULT_FINALIZATION_RESERVE_MS,
    Math.max(25, Math.floor(remaining * 0.15)),
  );
  return Math.max(0, remaining - reserve);
}

function observeScrollContentForRoot(rootElement: HTMLElement | null): ScrollContentSample {
  if (rootElement !== null && !rootElement.isConnected) {
    throw new Error('The pinned scroll observation root is detached.');
  }
  const MAX_ARTICLES = 500;
  const MAX_LOADERS = 1_000;
  const MAX_STATUSES = 1_000;
  const MAX_ANIMATION_CANDIDATES = 5_000;
  const MAX_TEXT_NODES_PER_ARTICLE = 2_000;
  const MAX_SEMANTIC_ELEMENTS_PER_ARTICLE = 500;
  let semanticObservationIncomplete = false;
  let animationObservationComplete = true;
  const observationRoot: Document | HTMLElement = rootElement ?? document;
  const surfaceRect = rootElement === null
    ? { top: 0, right: window.innerWidth, bottom: window.innerHeight, left: 0 }
    : rootElement.getBoundingClientRect();
  const clip = {
    top: Math.max(0, surfaceRect.top),
    right: Math.min(window.innerWidth, surfaceRect.right),
    bottom: Math.min(window.innerHeight, surfaceRect.bottom),
    left: Math.max(0, surfaceRect.left),
  };
  const visible = (candidate: Element): boolean => {
    const rect = candidate.getBoundingClientRect();
    const style = getComputedStyle(candidate);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none'
      && style.visibility !== 'hidden' && style.opacity !== '0'
      && rect.bottom > clip.top && rect.right > clip.left
      && rect.top < clip.bottom && rect.left < clip.right;
  };
  const withRootMatch = (
    selector: string,
    limit: number,
    evidence: 'semantic' | 'animation' = 'semantic',
  ): Element[] => {
    const candidates = observationRoot.querySelectorAll(selector);
    const rootMatches = rootElement?.matches(selector) === true;
    if (candidates.length + (rootMatches ? 1 : 0) > limit) {
      if (evidence === 'semantic') {
        semanticObservationIncomplete = true;
      } else {
        animationObservationComplete = false;
      }
    }
    const matches: Element[] = [];
    for (let index = 0; index < candidates.length && matches.length < limit; index += 1) {
      const candidate = candidates.item(index);
      if (candidate !== null) {
        matches.push(candidate);
      }
    }
    if (rootMatches) {
      if (matches.length >= limit) {
        matches.pop();
      }
      matches.unshift(rootElement);
    }
    return matches;
  };
  const articleCandidates = withRootMatch('article, [role="article"]', MAX_ARTICLES);
  const articleSet = new Set(articleCandidates);
  const loaderCandidates = new Set<Element>(withRootMatch(
    '[aria-busy="true"], [role="progressbar"], progress, [class*="skeleton" i], [class*="placeholder" i], [class*="shimmer" i], [class*="loading" i]',
    MAX_LOADERS,
  ));
  const statusCandidates = withRootMatch('[role="status"]', MAX_STATUSES);
  const isExcludedBy = (node: Node, excluded: Set<Element>): boolean => {
    for (const candidate of excluded) {
      if (candidate === node || candidate.contains(node)) {
        return true;
      }
    }
    return false;
  };
  const renderedWithin = (candidate: Element, container: Element): boolean => {
    let current: Element | null = candidate;
    while (current !== null) {
      const style = getComputedStyle(current);
      if (
        current.hasAttribute('hidden') ||
        current.getAttribute('aria-hidden') === 'true' ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.opacity === '0'
      ) {
        return false;
      }
      if (current === container) {
        break;
      }
      current = current.parentElement;
    }
    if (current !== container) {
      return false;
    }
    const rect = candidate.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const hasSubstantiveContentOutside = (
    container: Element,
    excluded: Set<Element>,
  ): boolean => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    let textNodesObserved = 0;
    while (current !== null && textNodesObserved < MAX_TEXT_NODES_PER_ARTICLE) {
      textNodesObserved += 1;
      const parent = current.parentElement;
      let renderedText = false;
      if (parent !== null && renderedWithin(parent, container)) {
        const range = document.createRange();
        range.selectNodeContents(current);
        const rect = range.getBoundingClientRect();
        renderedText = rect.width > 0 && rect.height > 0;
      }
      if (
        (current.textContent ?? '').replaceAll(/\s+/g, ' ').trim().length > 0 &&
        !isExcludedBy(parent ?? current, excluded) &&
        renderedText
      ) {
        return true;
      }
      current = walker.nextNode();
    }
    if (current !== null) {
      semanticObservationIncomplete = true;
    }
    const semanticCandidates = container.querySelectorAll(
      'a[href], button, input, select, textarea, img, picture, video, audio, canvas, iframe, [role="button"], [role="link"], [role="heading"], [role="textbox"], [role="img"]',
    );
    for (
      let index = 0;
      index < semanticCandidates.length && index < MAX_SEMANTIC_ELEMENTS_PER_ARTICLE;
      index += 1
    ) {
      const candidate = semanticCandidates.item(index);
      if (
        candidate !== null &&
        !isExcludedBy(candidate, excluded) &&
        renderedWithin(candidate, container)
      ) {
        return true;
      }
    }
    if (semanticCandidates.length > MAX_SEMANTIC_ELEMENTS_PER_ARTICLE) {
      semanticObservationIncomplete = true;
    }
    return false;
  };

  const closestObservedArticle = (candidate: Element): Element | null => {
    const article = candidate.matches('article, [role="article"]')
      ? candidate
      : candidate.closest('article, [role="article"]');
    return article !== null && articleSet.has(article) ? article : null;
  };
  const baseLoadersByArticle = new Map<Element, Set<Element>>();
  for (const loader of loaderCandidates) {
    const article = closestObservedArticle(loader);
    if (article === null) continue;
    const contained = baseLoadersByArticle.get(article) ?? new Set<Element>();
    contained.add(loader);
    baseLoadersByArticle.set(article, contained);
  }
  const statusesByArticle = new Map<Element, Set<Element>>();

  for (const status of statusCandidates) {
    const descriptor = [
      status.getAttribute('aria-label'),
      status.getAttribute('title'),
      status.textContent,
    ].filter((value): value is string => value !== null)
      .join(' ')
      .replaceAll(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase();
    const namedAsLoading = /\b(?:loading|fetching|please\s+wait|waiting)\b/u.test(descriptor);
    const article = closestObservedArticle(status);
    if (article === null) {
      if (namedAsLoading) {
        loaderCandidates.add(status);
      }
      continue;
    }
    const statuses = statusesByArticle.get(article) ?? new Set<Element>();
    statuses.add(status);
    statusesByArticle.set(article, statuses);
  }
  for (const [article, statuses] of statusesByArticle) {
    const excluded = new Set<Element>([
      ...(baseLoadersByArticle.get(article) ?? []),
      ...statuses,
    ]);
    if (!hasSubstantiveContentOutside(article, excluded)) {
      for (const status of statuses) {
        loaderCandidates.add(status);
      }
    }
  }

  const semanticLoadingIndicatorCount = [...loaderCandidates].filter(visible).length;
  const animationLoaderCandidates = new Set<Element>();
  if (semanticLoadingIndicatorCount === 0) {
    for (const candidate of withRootMatch('*', MAX_ANIMATION_CANDIDATES, 'animation')) {
      if (!visible(candidate) || (candidate.textContent ?? '').trim().length > 0) {
        continue;
      }
      const style = getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      if (
        style.animationName !== 'none' &&
        style.animationDuration !== '0s' &&
        rect.width >= 8 &&
        rect.height >= 8
      ) {
        loaderCandidates.add(candidate);
        animationLoaderCandidates.add(candidate);
      }
    }
  }
  const animationLoadingIndicatorCount = [...animationLoaderCandidates].filter(visible).length;
  const loadingIndicatorCount = semanticLoadingIndicatorCount + animationLoadingIndicatorCount;

  const loadersByArticle = new Map<Element, Set<Element>>();
  for (const loader of loaderCandidates) {
    const article = closestObservedArticle(loader);
    if (article === null) continue;
    const contained = loadersByArticle.get(article) ?? new Set<Element>();
    contained.add(loader);
    loadersByArticle.set(article, contained);
  }
  const articleCount = articleCandidates.filter((article) => {
    const containedLoaders = loadersByArticle.get(article) ?? new Set<Element>();
    return hasSubstantiveContentOutside(article, containedLoaders);
  }).length;

  if (semanticObservationIncomplete) {
    throw new Error('scroll_content_observation_incomplete');
  }

  return {
    articleCount,
    loadingIndicatorCount,
    semanticLoadingIndicatorCount,
    animationLoadingIndicatorCount,
    animationObservationComplete,
  };
}

function publicScrollContentObservation(sample: ScrollContentSample): ScrollContentObservation {
  return {
    articleCount: sample.articleCount,
    loadingIndicatorCount: sample.loadingIndicatorCount,
  };
}

function safeRawClickDispatchEvidence(value: unknown): RawClickDispatchEvidence | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<RawClickDispatchEvidence>;
  const booleanFields: Array<keyof RawClickDispatchEvidence> = [
    'guardExpired',
    'targetConnectedBefore',
    'targetConnectedAfter',
    'trustedEventObserved',
    'pointerDownOnTarget',
    'mouseDownOnTarget',
    'pointerUpOnTarget',
    'mouseUpOnTarget',
    'clickOnTarget',
    'misdirectedEventBlocked',
    'targetStateChangeBlocked',
  ];
  if (
    candidate.strategy !== 'guarded_exact_handle'
    || booleanFields.some((field) => typeof candidate[field] !== 'boolean')
    || (candidate.targetConnectedAtFirstEvent !== null
      && typeof candidate.targetConnectedAtFirstEvent !== 'boolean')
    || (candidate.geometryChangedBeforeFirstEvent !== null
      && typeof candidate.geometryChangedBeforeFirstEvent !== 'boolean')
  ) {
    return null;
  }
  return {
    strategy: 'guarded_exact_handle',
    guardExpired: candidate.guardExpired as boolean,
    targetConnectedBefore: candidate.targetConnectedBefore as boolean,
    targetConnectedAtFirstEvent: candidate.targetConnectedAtFirstEvent as boolean | null,
    targetConnectedAfter: candidate.targetConnectedAfter as boolean,
    geometryChangedBeforeFirstEvent: candidate.geometryChangedBeforeFirstEvent as boolean | null,
    trustedEventObserved: candidate.trustedEventObserved as boolean,
    pointerDownOnTarget: candidate.pointerDownOnTarget as boolean,
    mouseDownOnTarget: candidate.mouseDownOnTarget as boolean,
    pointerUpOnTarget: candidate.pointerUpOnTarget as boolean,
    mouseUpOnTarget: candidate.mouseUpOnTarget as boolean,
    clickOnTarget: candidate.clickOnTarget as boolean,
    misdirectedEventBlocked: candidate.misdirectedEventBlocked as boolean,
    targetStateChangeBlocked: candidate.targetStateChangeBlocked as boolean,
  };
}

function mergeRawClickDispatchEvidence(
  inPage: RawClickDispatchEvidence | null,
  external: RawClickDispatchEvidence | null,
): RawClickDispatchEvidence | null {
  if (inPage === null) return external;
  if (external === null) return inPage;
  return {
    strategy: 'guarded_exact_handle',
    guardExpired: inPage.guardExpired || external.guardExpired,
    targetConnectedBefore: inPage.targetConnectedBefore && external.targetConnectedBefore,
    targetConnectedAtFirstEvent:
      external.targetConnectedAtFirstEvent ?? inPage.targetConnectedAtFirstEvent,
    targetConnectedAfter: inPage.targetConnectedAfter,
    geometryChangedBeforeFirstEvent:
      external.geometryChangedBeforeFirstEvent ?? inPage.geometryChangedBeforeFirstEvent,
    trustedEventObserved: inPage.trustedEventObserved || external.trustedEventObserved,
    pointerDownOnTarget: inPage.pointerDownOnTarget || external.pointerDownOnTarget,
    mouseDownOnTarget: inPage.mouseDownOnTarget || external.mouseDownOnTarget,
    pointerUpOnTarget: inPage.pointerUpOnTarget || external.pointerUpOnTarget,
    mouseUpOnTarget: inPage.mouseUpOnTarget || external.mouseUpOnTarget,
    clickOnTarget: inPage.clickOnTarget || external.clickOnTarget,
    misdirectedEventBlocked: inPage.misdirectedEventBlocked || external.misdirectedEventBlocked,
    targetStateChangeBlocked: inPage.targetStateChangeBlocked || external.targetStateChangeBlocked,
  };
}

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
  private pendingHandoffRelease: PendingHandoffRelease | null = null;
  private lastHandoffOutcome: AuthenticationBoundaryOutcome | null = null;
  private controlledLaunchIdentity: BrowserLaunchIdentity | null = null;
  private runtimeProfileObservation: RuntimeProfileObservation | null = null;
  private controlledStartBoundary: ControlledStartBoundaryObservation | null = null;
  private nativeAttachedBrowser: Browser | undefined;
  private nativeControlRecord: NativeControlRecord | null = null;
  private controlledBrowserProcessId: number | null = null;
  private controlledBrowserProcess: OwnedProcessObservation | null = null;
  private readonly ownershipLease = new ProfileOwnershipLeaseController();
  private readonly clickDispatchBindingName = `__stage5BrowserClickProbe_${randomUUID().replaceAll('-', '')}`;
  private readonly clickDispatchBindings = new WeakSet<Page>();
  private readonly externalClickDispatchObservations = new Map<string, ExternalClickDispatchObservation>();

  constructor(
    private readonly config: Stage5BrowserConfig,
    initialBrowser: BrowserProduct = config.browser,
    private readonly humanBrowserLauncher: HumanBrowserLauncher = new NativeHumanBrowserLauncher(),
    private readonly profileStorageInspector: typeof inspectProfileStorage = inspectProfileStorage,
    private readonly controlledProfileStorageInspector: typeof inspectControlledProfileStorage = inspectControlledProfileStorage,
    private readonly runtimeProfileInspector: typeof inspectRuntimeProfile = inspectRuntimeProfile,
    private readonly nativeWindowActivator: OwnedBrowserWindowActivator = new NativeOwnedBrowserWindowActivator(),
    private readonly profileOwnerInspector: typeof inspectChromiumProfileOwner = inspectChromiumProfileOwner,
  ) {
    this.selectedBrowser = initialBrowser;
  }

  async start(
    input: BrowserCommandInput<'start'> = {},
    authenticationProbeTargetOrigin: string | null = null,
    resumeOwnedHumanHandoff = false,
  ): Promise<BrowserStatus> {
    if (this.pendingHandoffRelease !== null || this.authenticationHandoff?.state === 'awaiting_user') {
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
    let ownershipClaimedForLaunch = false;
    let attemptedProfileRoot: string | null = null;
    try {
      const launchTarget = await resolveBrowserLaunchTarget(this.selectionFor(this.selectedBrowser));
      const enableChromiumSandbox = launchTarget.engine === 'chromium' && process.platform === 'darwin';
      const profileDir = profileDirForBrowser(this.config, this.selectedBrowser);
      attemptedProfileRoot = profileDir;
      const launchIdentity = launchIdentityForTarget(launchTarget, profileDir);
      await Promise.all([
        mkdir(profileDir, { recursive: true, mode: 0o700 }),
        mkdir(this.config.artifactsDir, { recursive: true, mode: 0o700 }),
        mkdir(path.join(this.config.artifactsDir, 'downloads'), { recursive: true, mode: 0o700 }),
      ]);

      await this.prepareOwnershipLeaseForStart(
        profileDir,
        launchIdentity,
        resumeOwnedHumanHandoff,
      );

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
            await this.claimNativeControlLeaseIfNeeded(
              profileDir,
              launchIdentity,
              resumeOwnedHumanHandoff,
            );
            return await this.attachToNativeChromium(
              nativeRecord,
              launchIdentity,
              authenticationProbeTargetOrigin,
            );
          }
          await removeNativeControlRecord(profileDir);
        }

        // A compatible worker replacement can release its Chromium process a fraction
        // after the new worker starts. Wait briefly for that owned lock to clear, but
        // never remove a lock or assume that an unknown owner is stale.
        if (!(await waitForProfileUnlock(profileDir, Math.min(this.config.readinessTimeoutMs, 2_000)))) {
          const lateNativeRecord = await readNativeControlRecord(profileDir, this.selectedBrowser);
          if (lateNativeRecord !== null && processIsRunning(lateNativeRecord.processId)) {
            await this.claimNativeControlLeaseIfNeeded(
              profileDir,
              launchIdentity,
              resumeOwnedHumanHandoff,
            );
            return await this.attachToNativeChromium(
              lateNativeRecord,
              launchIdentity,
              authenticationProbeTargetOrigin,
            );
          }
          const ownerInspection = await this.profileOwnerInspector(profileDir, launchIdentity);
          if (ownerInspection.reconnectRecord !== null) {
            await this.claimNativeControlLeaseIfNeeded(
              profileDir,
              launchIdentity,
              resumeOwnedHumanHandoff,
            );
            return await this.attachToNativeChromium(
              ownerInspection.reconnectRecord,
              launchIdentity,
              authenticationProbeTargetOrigin,
            );
          }
          throw this.lockedProfileOwnerError(ownerInspection);
        }
      }

      const leaseClaimed = await this.ownershipLease.claim({
        profileRoot: profileDir,
        identity: launchIdentity,
        controlMode: 'playwright',
      });
      if (!leaseClaimed) {
        const competingLease = await inspectProfileOwnershipLease(
          profileDir,
          launchIdentity,
          this.ownershipLease.leaseId,
        );
        throw this.ownershipLeaseError(competingLease, launchIdentity);
      }
      ownershipClaimedForLaunch = true;
      const baselineDescendants = await snapshotOwnedDescendants(process.pid);
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
      await this.activateControlledContext(
        context,
        launchIdentity,
        launchTarget.engine,
        authenticationProbeTargetOrigin,
      );
      const browserProcess = await observeLaunchedBrowserProcess(
        launchIdentity,
        baselineDescendants,
        Math.min(this.config.readinessTimeoutMs, 2_000),
      );
      if (browserProcess === null) {
        await context.close({ reason: 'Stage5 Browser could not establish exact durable process ownership.' })
          .catch(() => undefined);
        throw new Stage5BrowserError(
          'BROWSER_NOT_READY',
          'Stage5 Browser launched the profile but could not prove the exact browser process for its durable ownership lease.',
          {
            recoverable: true,
            details: {
              reason: 'ownership_unverified',
              suggestedAction: 'Call browser_diagnostics. Do not use, kill, or delete locks for the unverified browser process; close only the visibly identified dedicated Stage5 browser normally.',
            },
          },
        );
      }
      await this.ownershipLease.establish({
        profileRoot: profileDir,
        identity: launchIdentity,
        browserProcess,
        controlMode: 'playwright',
        phase: 'owned_active',
      });
      this.controlledBrowserProcess = browserProcess;
      return this.status();
    } catch (error) {
      if (
        ownershipClaimedForLaunch
        && attemptedProfileRoot !== null
        && await waitForProfileUnlock(attemptedProfileRoot, Math.min(this.config.readinessTimeoutMs, 500))
      ) {
        await this.ownershipLease.updatePhase('profile_unlocked').catch(() => undefined);
        await this.ownershipLease.release().catch(() => undefined);
      }
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
        this.operationalBrowserAvailability(browser),
      ),
    );
    return {
      defaultBrowser: this.config.browser,
      currentBrowser: this.selectedBrowser,
      browsers,
    };
  }

  private async operationalBrowserAvailability(
    browser: BrowserProduct,
  ): Promise<BrowserOperationalAvailability> {
    const executableAvailability = await browserAvailability(this.selectionFor(browser));
    if (!executableAvailability.available) {
      return {
        ...executableAvailability,
        installed: false,
        profileState: 'unavailable',
        startable: false,
        recoverable: false,
        suggestedAction: suggestedActionForReason(executableAvailability.reason),
      };
    }

    const target = await resolveBrowserLaunchTarget(this.selectionFor(browser));
    const profileRoot = profileDirForBrowser(this.config, browser);
    const identity = launchIdentityForTarget(target, profileRoot);
    const profile = await inspectProfile(
      profileRoot,
      browser === this.selectedBrowser && (
        this.usableContext() !== undefined
        || this.authenticationHandoff?.session.state().running === true
        || this.pendingHandoffRelease !== null
      ),
    );
    const lease = await inspectProfileOwnershipLease(
      profileRoot,
      identity,
      this.ownershipLease.leaseId,
    );

    if (lease.state === 'current_owner') {
      const privateHandoff = lease.lease?.controlMode === 'human_handoff';
      const releasePending = lease.lease?.phase === 'close_requested'
        || lease.lease?.phase === 'process_exited'
        || lease.lease?.phase === 'profile_unlocked';
      return {
        ...executableAvailability,
        installed: true,
        available: !privateHandoff && !releasePending,
        profileState: 'owned_active',
        startable: !privateHandoff && !releasePending,
        recoverable: privateHandoff || releasePending,
        suggestedAction: privateHandoff
          ? 'Complete the active private handoff, then call browser_resume_after_login. Do not start another backend or delete profile locks.'
          : releasePending
            ? 'Call browser_request_login_handoff once more to continue the retained release phase.'
            : browser === this.selectedBrowser && this.usableContext() !== undefined
              ? 'This backend is already controlled by the current Stage5 session.'
              : 'Call browser_start once to reconnect the current Stage5-owned backend.',
      };
    }
    if (lease.state === 'busy_other_stage5_session') {
      return {
        ...executableAvailability,
        installed: true,
        available: false,
        profileState: 'busy_other_stage5_session',
        startable: false,
        recoverable: false,
        suggestedAction: `Continue in the live Stage5 session that owns ${identity.applicationName}, or ask it to call browser_stop. Do not retry, kill the browser, or delete locks.`,
      };
    }
    if (lease.state === 'owned_orphaned') {
      const privateHandoff = lease.lease?.controlMode === 'human_handoff';
      return {
        ...executableAvailability,
        installed: true,
        available: !privateHandoff,
        profileState: 'owned_orphaned',
        startable: !privateHandoff,
        recoverable: true,
        suggestedAction: privateHandoff
          ? `The private handoff outlived its worker. Ask the user to close only the dedicated ${identity.applicationName} normally; do not attach, terminate, or delete locks.`
          : 'Call browser_start once. Stage5 will reattach or restart only after re-proving the exact orphaned ownership lease.',
      };
    }
    if (lease.state === 'invalid') {
      return {
        ...executableAvailability,
        installed: true,
        available: false,
        profileState: 'external_owner',
        startable: false,
        recoverable: false,
        suggestedAction: `The profile has an invalid or mismatched Stage5 ownership record. Do not overwrite it, kill a process, or delete locks; inspect ${identity.applicationName} ownership first.`,
      };
    }
    if (lease.state === 'abandoned' && profile.lockFiles.length === 0) {
      return {
        ...executableAvailability,
        installed: true,
        available: true,
        profileState: 'startable',
        startable: true,
        recoverable: true,
        suggestedAction: 'Call browser_start once; Stage5 can safely replace the abandoned record because the profile is unlocked.',
      };
    }
    if (lease.state === 'abandoned') {
      return {
        ...executableAvailability,
        installed: true,
        available: false,
        profileState: 'external_owner',
        startable: false,
        recoverable: false,
        suggestedAction: `The old record no longer proves ownership of the live lock. Close only the visibly identified dedicated ${identity.applicationName} normally; never delete locks or kill an unknown owner.`,
      };
    }
    if (profile.lockFiles.length === 0) {
      return {
        ...executableAvailability,
        installed: true,
        available: true,
        profileState: 'startable',
        startable: true,
        recoverable: false,
        suggestedAction: null,
      };
    }
    if (target.engine === 'chromium') {
      const owner = await this.profileOwnerInspector(profileRoot, identity);
      const recoverable = owner.reconnectRecord !== null;
      return {
        ...executableAvailability,
        installed: true,
        available: recoverable,
        profileState: recoverable ? 'owned_orphaned' : 'external_owner',
        startable: recoverable,
        recoverable,
        suggestedAction: owner.evidence.suggestedAction,
      };
    }
    return {
      ...executableAvailability,
      installed: true,
      available: false,
      profileState: 'external_owner',
      startable: false,
      recoverable: false,
      suggestedAction: `The ${identity.applicationName} profile is locked without a conclusive Stage5 lease. Close only that visibly identified dedicated browser normally; do not kill a process or delete lock files.`,
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
    const handoffReleasePending = this.pendingHandoffRelease !== null;
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
    const profile = await inspectProfile(
      profilePath,
      currentStatus.browserConnected || humanBootstrapRunning || handoffReleasePending,
    );
    return {
      browser: this.selectedBrowser,
      engine: availability.engine,
      availability,
      preflightSuggestedAction: availability.available
        ? null
        : suggestedActionForReason(availability.reason),
      profile,
      profileOwner: await this.profileOwnerEvidence(
        profile,
        currentStatus.launchIdentity,
        humanBootstrapRunning || handoffReleasePending,
      ),
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
  }

  async detachForWorkerShutdown(): Promise<void> {
    if (this.pendingHandoffRelease !== null || this.authenticationHandoff?.state === 'awaiting_user') {
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
      await writeNativeControlRecord(
        profileDirForBrowser(this.config, this.selectedBrowser),
        { ...nativeRecord, state: 'controlled' },
      ).catch(() => undefined);
      await this.ownershipLease.updatePhase('owned_active').catch(() => undefined);
    }

    this.context = undefined;
    this.activePage = undefined;
    this.nativeAttachedBrowser = undefined;
    this.nativeControlRecord = null;
    this.controlledBrowserProcessId = null;
    this.controlledBrowserProcess = null;
    this.state = 'stopped';
    await this.ownershipLease.detach();
    await nativeBrowser.close().catch(() => undefined);
  }

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
    if (warnings.some((warning) => warning.code === 'dom_readiness_timeout')) {
      const reconciledReadyState = await boundedValue(
        page.evaluate(() => document.readyState),
        Math.min(250, Math.max(1, input.timeoutMs - (Date.now() - startedAt))),
        'loading',
      );
      if (reconciledReadyState === 'interactive' || reconciledReadyState === 'complete') {
        readiness = 'domcontentloaded';
        const staleWarningIndex = warnings.findIndex((warning) => warning.code === 'dom_readiness_timeout');
        if (staleWarningIndex >= 0) warnings.splice(staleWarningIndex, 1);
      }
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
    let observedScrollContainers: Awaited<ReturnType<BrowserController['observeScrollContainers']>>;
    try {
      observedScrollContainers = await this.observeScrollContainers(root.locator);
    } catch (error) {
      for (const { handle } of observedFileInputs.inputs.values()) {
        await handle.dispose().catch(() => undefined);
      }
      throw error;
    }
    if (frame.isDetached() || this.documentVersion(frame) !== documentVersion) {
      for (const { handle } of observedFileInputs.inputs.values()) {
        await handle.dispose().catch(() => undefined);
      }
      for (const { handle } of observedScrollContainers.containers.values()) {
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
      scrollContainers: observedScrollContainers.containers,
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
      scrollContainerCount: observedScrollContainers.containers.size,
      scrollContainers: [...observedScrollContainers.containers.values()].map(({ observation }) => observation),
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
        ...(observedScrollContainers.truncated
          ? [{
              code: 'scroll_container_list_truncated' as const,
              message: `The snapshot scope contains more than ${MAX_SCROLL_CONTAINERS_PER_SNAPSHOT} vertical scroll surfaces; only the first bounded set was observed.`,
              suggestedAction: 'Narrow to the intended modal or frame before scrolling; Stage5 Browser will not guess among unobserved containers.',
            }]
          : []),
      ],
      snapshot,
    };
  }

  async screenshot(input: BrowserCommandInput<'screenshot'>): Promise<BrowserCommandOutput<'screenshot'>> {
    const page = await this.ensureActivePage(await this.ensureContext());
    const pageActivation = await this.activateSelectedPageForInput(page, 1);
    if (!this.pageIsActivatedForInput(pageActivation)) {
      throw new Stage5BrowserError(
        'OPERATION_FAILED',
        'The controller-selected page could not become visible before screenshot capture.',
        {
          recoverable: true,
          details: {
            reason: 'capture_page_not_active',
            pageActivation,
            suggestedAction: 'Call browser_tabs, explicitly select the intended tab, then capture once more.',
          },
        },
      );
    }
    const screenshotDir = path.join(this.config.artifactsDir, 'screenshots');
    await mkdir(screenshotDir, { recursive: true, mode: 0o700 });
    const screenshotPath = path.join(
      screenshotDir,
      `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.png`,
    );
    let data = await page.screenshot({
      path: screenshotPath,
      type: 'png',
      fullPage: input.fullPage,
      timeout: input.timeoutMs,
    });
    const semanticContentPresent = await boundedValue(
      page.locator('body').evaluate((body) => {
        const text = body instanceof HTMLElement ? body.innerText.trim() : body.textContent?.trim() ?? '';
        return text.length > 0 || body.querySelector('canvas, img, svg, video') !== null;
      }),
      500,
      false,
    );
    let artifactClassification = this.screenshotArtifactClassification(data);
    let retryUsed = false;
    if (artifactClassification === 'possibly_uniform' && semanticContentPresent) {
      retryUsed = true;
      await page.waitForTimeout(SCREENSHOT_RENDER_SETTLE_MS);
      data = await page.screenshot({
        path: screenshotPath,
        type: 'png',
        fullPage: input.fullPage,
        timeout: input.timeoutMs,
      });
      artifactClassification = this.screenshotArtifactClassification(data);
    }
    await chmod(screenshotPath, 0o600);

    return {
      page: await this.pageSummary(page),
      path: screenshotPath,
      mimeType: 'image/png',
      dataBase64: data.toString('base64'),
      captureEvidence: {
        pageActivation,
        pngBytes: data.byteLength,
        artifactClassification,
        semanticContentPresent,
        retryUsed,
      },
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
    const startedAt = Date.now();
    const deadlineAt = startedAt + input.timeoutMs;
    const actionDeadlineAt = deadlineAt - clickFinalizationReserve(input.timeoutMs);
    const actionStartedAt = new Date(startedAt).toISOString();
    this.pageDiagnostics.beginAction(page, actionStartedAt);
    let preparedTarget: PreparedObservedClickTarget | null = null;
    let dispatchEvidence: SanitizedClickDispatchEvidence | null = null;
    try {
      preparedTarget = await this.prepareRoleClickTarget(
        page,
        locator,
        actionStartedAt,
        actionDeadlineAt,
        input.role,
        input.name,
      );
      dispatchEvidence = await this.dispatchPreparedObservedClick(
        page,
        preparedTarget,
        actionStartedAt,
        actionDeadlineAt,
        deadlineAt,
        'click_by_role',
      );
      const postcondition = await this.verifyClickPostcondition(
        page,
        frame,
        locator,
        input.postcondition,
        remainingUntil(actionDeadlineAt),
      );
      this.pageDiagnostics.recordAction(
        page,
        this.successfulActionDiagnostic(
          'click_by_role',
          page,
          preparedTarget.targetState,
          actionStartedAt,
          dispatchEvidence,
        ),
      );
      this.lastKnownUrl = page.url();
      return {
        page: await this.pageSummary(page, undefined, remainingUntil(deadlineAt)),
        frame: this.frameSummary(frame, page),
        postcondition,
      };
    } catch (error) {
      if (error instanceof Stage5BrowserError && error.code === 'POSTCONDITION_FAILED') {
        this.pageDiagnostics.recordAction(
          page,
          this.postconditionFailureDiagnostic(
            'click_by_role',
            page,
            preparedTarget?.targetState ?? null,
            actionStartedAt,
            dispatchEvidence,
          ),
        );
      }
      throw error;
    } finally {
      await preparedTarget?.handle.dispose().catch(() => undefined);
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
    const startedAt = Date.now();
    const deadlineAt = startedAt + input.timeoutMs;
    const actionDeadlineAt = deadlineAt - clickFinalizationReserve(input.timeoutMs);
    const actionStartedAt = new Date(startedAt).toISOString();
    let preparedTarget: PreparedObservedClickTarget | null = null;
    let dispatchEvidence: SanitizedClickDispatchEvidence | null = null;
    this.pageDiagnostics.beginAction(page, actionStartedAt);
    try {
      let count: number;
      try {
        count = await boundedValue(
          locator.count(),
          Math.max(1, remainingUntil(actionDeadlineAt)),
          -1,
        );
      } catch {
        this.failClickBeforeDispatch(
          page,
          actionStartedAt,
          null,
          'target_missing',
          'reference_resolution_failed',
          'The observed reference could not be resolved before click preparation.',
          'Take one fresh semantic snapshot; Stage5 Browser did not dispatch the click.',
          'TARGET_NOT_FOUND',
        );
      }
      if (count === -1) {
        this.failClickBeforeDispatch(
          page,
          actionStartedAt,
          null,
          'timeout',
          'reference_resolution_deadline_expired',
          'The observed reference could not be resolved before the shared click deadline.',
          'Take one fresh semantic snapshot; Stage5 Browser confirmed that no click was dispatched.',
          'OPERATION_FAILED',
        );
      }
      if (count !== 1) {
        this.failClickBeforeDispatch(
          page,
          actionStartedAt,
          null,
          count === 0 ? 'target_missing' : 'ambiguous_target',
          'reference_resolution_changed',
          count === 0
            ? 'The observed reference no longer resolves in the current document.'
            : 'The observed reference resolved to multiple elements; Stage5 Browser will not choose one.',
          'Take one fresh semantic snapshot; Stage5 Browser did not dispatch the click.',
          count === 0 ? 'TARGET_NOT_FOUND' : 'AMBIGUOUS_TARGET',
        );
      }
      preparedTarget = await this.prepareObservedClickTarget(
        page,
        frame,
        locator,
        actionStartedAt,
        actionDeadlineAt,
      );
      dispatchEvidence = await this.dispatchPreparedObservedClick(
        page,
        preparedTarget,
        actionStartedAt,
        actionDeadlineAt,
        deadlineAt,
        'click_by_ref',
      );
      try {
        const postcondition = await this.verifyClickPostcondition(
          page,
          frame,
          preparedTarget.locator,
          input.postcondition,
          remainingUntil(actionDeadlineAt),
        );
        this.pageDiagnostics.recordAction(
          page,
          this.successfulActionDiagnostic(
            'click_by_ref',
            page,
            preparedTarget.targetState,
            actionStartedAt,
            dispatchEvidence,
          ),
        );
        this.lastKnownUrl = page.url();
        return {
          page: await this.pageSummary(page, undefined, remainingUntil(deadlineAt)),
          frame: this.frameSummary(frame, page),
          postcondition,
        };
      } catch (error) {
        if (error instanceof Stage5BrowserError && error.code === 'POSTCONDITION_FAILED') {
          this.pageDiagnostics.recordAction(
            page,
            this.postconditionFailureDiagnostic(
              'click_by_ref',
              page,
              preparedTarget.targetState,
              actionStartedAt,
              dispatchEvidence,
            ),
          );
        }
        throw error;
      }
    } finally {
      await preparedTarget?.handle.dispose().catch(() => undefined);
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
    const observedTarget = this.resolveObservedScrollContainer(frame, input.target);
    const targetHandle = observedTarget?.handle ?? null;
    if (targetHandle !== null && await this.inspectScrollContainer(targetHandle) === null) {
      throw new Stage5BrowserError(
        'TARGET_NOT_FOUND',
        'The observed nested scroll container is no longer attached or scrollable.',
        {
          recoverable: true,
          details: {
            reason: 'scroll_container_no_longer_available',
            ref: input.target?.ref ?? null,
            suggestedAction: 'Take one fresh snapshot and select a currently exposed scroll-container ref.',
          },
        },
      );
    }
    const startedAt = Date.now();
    const operationDeadlineAt = startedAt + input.timeoutMs;
    const actionDeadlineAt = operationDeadlineAt - scrollFinalizationReserve(input.timeoutMs);
    const actionStartedAt = new Date(startedAt).toISOString();
    this.pageDiagnostics.beginAction(page, actionStartedAt);
    if (targetHandle !== null) {
      this.consumeObservedSnapshot(frame, targetHandle);
    }
    let observationSurface: ScrollContentObservationSurface | null = null;
    let stepsCompleted = 0;
    let contentGrew = false;
    let finalStepMoved = false;
    let finalStepGrew = false;
    let actionDispatched: boolean | 'unknown' = false;

    const activateBeforeScroll = async (attemptCount: number): Promise<void> => {
      const activationFallback: SanitizedPageActivationEvidence = {
        attemptCount,
        controllerSelected: this.preferredPage() === page,
        bringToFrontAttempted: true,
        bringToFrontSucceeded: false,
        visibilityBefore: 'unknown',
        visibilityAfter: 'unknown',
        documentFocusedBefore: null,
        documentFocusedAfter: null,
        nativeWindow: this.nativeWindowActivationNotRequired(),
      };
      const pageActivation = await boundedValue(
        this.activateSelectedPageForInput(page, attemptCount),
        Math.max(1, remainingUntil(actionDeadlineAt)),
        activationFallback,
      );
      if (this.pageIsActivatedForInput(pageActivation)) {
        return;
      }
      const priorScrollDispatched = stepsCompleted > 0 || actionDispatched === true;
      throw new Stage5BrowserError(
        'OPERATION_FAILED',
        'The controller-selected page could not become the visible scroll target.',
        {
          recoverable: true,
          details: {
            reason: 'page_not_active',
            actionDispatched: priorScrollDispatched,
            clickDispatched: null,
            stepsCompleted,
            pageActivation,
            suggestedAction: priorScrollDispatched
              ? 'Inspect one fresh snapshot before continuing. Earlier scroll steps completed and Stage5 Browser did not replay them.'
              : 'Explicitly select the intended tab, obtain one fresh snapshot, and scroll only after the renderer can become visible.',
          },
        },
      );
    };

    try {
      await activateBeforeScroll(1);
      observationSurface = await this.resolveScrollContentObservationSurface(frame, targetHandle);
      const before = await this.scrollPosition(frame, targetHandle);
      let contentBefore = await this.scrollContentObservation(frame, observationSurface);
      if (contentBefore === null && observationSurface.ownsHandle) {
        await observationSurface.handle?.dispose().catch(() => undefined);
        observationSurface = { handle: null, ownsHandle: false };
        contentBefore = await this.scrollContentObservation(frame, observationSurface);
      }
      if (contentBefore === null) {
        throw new Stage5BrowserError(
          'OPERATION_FAILED',
          'The selected scroll observation surface was unavailable before dispatch.',
          {
            recoverable: true,
            details: {
              reason: 'scroll_observation_surface_unavailable',
              actionDispatched: false,
              stepsCompleted: 0,
              suggestedAction: 'Take one fresh snapshot and select the intended current scroll surface before another attempt.',
            },
          },
        );
      }
      let previous = before;
      for (let step = 0; step < input.count; step += 1) {
        if (remainingUntil(actionDeadlineAt) <= input.settleMs) {
          break;
        }
        await activateBeforeScroll(step + 2);
        if (remainingUntil(actionDeadlineAt) <= 0) {
          break;
        }
        actionDispatched = 'unknown';
        await this.performScrollStep(frame, input.direction, input.amount, targetHandle);
        actionDispatched = true;
        stepsCompleted += 1;
        const settleBudgetMs = Math.min(input.settleMs, remainingUntil(actionDeadlineAt));
        if (settleBudgetMs > 0) {
          await page.waitForTimeout(settleBudgetMs);
        }
        const positionBudgetMs = remainingUntil(actionDeadlineAt);
        if (positionBudgetMs <= 0) {
          break;
        }
        const current = await boundedValue<ScrollPosition | null>(
          this.scrollPosition(frame, targetHandle),
          positionBudgetMs,
          null,
        );
        if (current === null) {
          break;
        }
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

      const wait = await this.waitForScrollContent(
        page,
        frame,
        observationSurface,
        contentBefore,
        input.waitFor,
        remainingUntil(actionDeadlineAt),
      );
      const after = await boundedValue(
        this.scrollPosition(frame, targetHandle),
        Math.max(1, remainingUntil(operationDeadlineAt)),
        previous,
      );
      finalStepMoved ||= previous.x !== after.x || previous.y !== after.y;
      finalStepGrew ||=
        after.contentHeight > previous.contentHeight ||
        after.contentWidth > previous.contentWidth;
      const moved = before.x !== after.x || before.y !== after.y;
      contentGrew ||=
        finalStepGrew ||
        after.contentHeight > before.contentHeight ||
        after.contentWidth > before.contentWidth;
      const movingTowardStart =
        input.amount === 'document_start' ||
        (input.amount !== 'document_end' && input.direction === 'up');
      const targetBoundaryReached = input.amount === 'document_start'
        ? after.y <= SCROLL_BOUNDARY_EPSILON_PX
        : input.amount === 'document_end'
          ? after.maxY - after.y <= SCROLL_BOUNDARY_EPSILON_PX
          : input.direction === 'down'
            ? after.maxY - after.y <= SCROLL_BOUNDARY_EPSILON_PX
            : after.y <= SCROLL_BOUNDARY_EPSILON_PX;
      const documentBoundaryReached = targetHandle === null && targetBoundaryReached;
      const priorHistory = targetHandle === null ? this.scrollHistories.get(frame) : undefined;
      const dynamicGrowthObserved = contentGrew || priorHistory?.dynamicGrowthObserved === true;
      if (targetHandle === null) {
        this.scrollHistories.set(frame, { dynamicGrowthObserved });
      }
      const endMarkerObserved = input.endMarker === null
        ? false
        : await boundedValue(
          this.visibleExpectationObserved(page, input.endMarker),
          Math.max(1, remainingUntil(operationDeadlineAt)),
          false,
        );
      const waitUnmet = wait.requested && !wait.satisfied;
      const dynamicContentStalled =
        targetBoundaryReached &&
        !movingTowardStart &&
        !finalStepMoved &&
        !finalStepGrew &&
        (dynamicGrowthObserved || waitUnmet || wait.after.loadingIndicatorCount > 0);
      let endState: ScrollEndState;
      if (endMarkerObserved) {
        endState = 'confirmed_by_marker';
      } else if (targetBoundaryReached && movingTowardStart) {
        endState = targetHandle === null ? 'confirmed_document_start' : 'confirmed_container_start';
      } else if (dynamicContentStalled) {
        endState = 'dynamic_content_stalled';
      } else if (targetBoundaryReached) {
        endState = 'geometric_boundary_unconfirmed';
      } else {
        endState = 'not_at_boundary';
      }
      const endReached =
        endState === 'confirmed_by_marker' ||
        endState === 'confirmed_document_start' ||
        endState === 'confirmed_container_start';
      const nestedScrollContainerCandidateCount = await boundedValue(
        this.countNestedScrollContainerCandidates(frame),
        Math.max(1, remainingUntil(operationDeadlineAt)),
        0,
      );
      const warnings: BrowserCommandOutput<'scroll'>['warnings'] = [];
      if (!moved && !contentGrew) {
        warnings.push({
          code: 'scroll_position_unchanged',
          message: 'The requested scroll did not change the selected scroll surface position or size.',
          suggestedAction: 'Inspect the current snapshot for an observed nested scroll container, a stalled dynamic feed, or an explicit end marker.',
        });
      }
      if (targetHandle === null && !moved && nestedScrollContainerCandidateCount > 0) {
        warnings.push({
          code: 'nested_scroll_containers_available',
          message: `${nestedScrollContainerCandidateCount} nested vertical scroll-container candidate(s) are available in the active frame.`,
          suggestedAction: 'Take one fresh snapshot, select the intended scrollContainers ref, and pass it through browser_scroll.target. Do not guess a selector or container.',
        });
      }
      if (waitUnmet) {
        warnings.push({
          code: 'content_wait_timed_out',
          message: 'The bounded post-scroll wait did not observe the requested article growth or loading-indicator transition.',
          suggestedAction: 'Treat the feed as stalled, inspect the fresh page state and diagnostics, and do not claim that the timeline is complete.',
        });
      }
      if (dynamicContentStalled) {
        warnings.push({
          code: 'dynamic_content_stalled',
          message: 'The selected scroll surface is at its current geometric boundary while dynamic content remains unresolved; the feed end is not confirmed.',
          suggestedAction: 'Do not treat this as the end of the feed. Inspect loading state and scroll-correlated diagnostics, or target an observed nested container.',
        });
      } else if (endState === 'geometric_boundary_unconfirmed') {
        warnings.push({
          code: 'scroll_end_unconfirmed',
          message: 'The selected scroll surface reached its current geometric boundary without an explicit end marker.',
          suggestedAction: 'Treat the feed end as unconfirmed; inspect the page or provide a visible end marker instead of assuming all dynamic content loaded.',
        });
      }
      this.lastKnownUrl = page.url();
      this.pageDiagnostics.recordAction(
        page,
        this.scrollActionDiagnostic(page, actionStartedAt, actionDispatched, 'succeeded'),
      );
      return {
        page: await this.pageSummary(page, undefined, remainingUntil(operationDeadlineAt)),
        frame: this.frameSummary(frame, page),
        target: observedTarget === null
          ? { kind: 'document', ref: null }
          : { kind: 'container', ref: observedTarget.observation.ref },
        before,
        after,
        wait,
        stepsCompleted,
        moved,
        contentGrew,
        targetBoundaryReached,
        documentBoundaryReached,
        nestedScrollContainerCandidateCount,
        endReached,
        endState,
        warnings,
      };
    } catch (error) {
      const pageNotActive = error instanceof Stage5BrowserError &&
        error.details?.reason === 'page_not_active';
      const observationSurfaceUnavailable = error instanceof Stage5BrowserError &&
        error.details?.reason === 'scroll_observation_surface_unavailable';
      const observationIncomplete = error instanceof Stage5BrowserError &&
        error.details?.reason === 'scroll_observation_incomplete';
      const priorScrollDispatched = stepsCompleted > 0 || actionDispatched === true;
      const knownObservationFailure = observationSurfaceUnavailable || observationIncomplete;
      const reportedError = knownObservationFailure
        ? new Stage5BrowserError(
          'OPERATION_FAILED',
          error.message,
          {
            recoverable: true,
            details: {
              ...error.details,
              actionDispatched: priorScrollDispatched,
              clickDispatched: null,
              stepsCompleted,
              suggestedAction: priorScrollDispatched
                ? observationSurfaceUnavailable
                  ? 'Inspect one fresh snapshot before continuing. The completed scroll steps were not replayed, and Stage5 Browser will not compare the detached root with its replacement.'
                  : 'Inspect one fresh snapshot before continuing. The completed scroll steps were not replayed, and Stage5 Browser will not infer content state from a truncated observation.'
                : observationSurfaceUnavailable
                  ? 'Take one fresh snapshot and select the intended current scroll surface before another attempt.'
                  : 'Use one fresh snapshot to target a smaller observed scroll container; Stage5 Browser will not infer growth or loader disappearance from a truncated sample.',
            },
            cause: error,
          },
        )
        : error;
      this.pageDiagnostics.recordAction(
        page,
        this.scrollActionDiagnostic(
          page,
          actionStartedAt,
          actionDispatched,
          (pageNotActive || knownObservationFailure) && actionDispatched === false
            ? 'blocked'
            : 'failed',
          pageNotActive
            ? 'page_not_active'
            : observationSurfaceUnavailable
              ? 'detached'
              : 'unknown',
        ),
      );
      throw reportedError;
    } finally {
      if (observationSurface?.ownsHandle === true) {
        await observationSurface.handle?.dispose().catch(() => undefined);
      }
      if (targetHandle !== null) {
        await targetHandle.dispose().catch(() => undefined);
      } else {
        this.discardObservedSnapshot(frame);
      }
    }
  }

  async findText(input: BrowserCommandInput<'findText'>): Promise<BrowserCommandOutput<'findText'>> {
    const page = await this.ensureActivePage(await this.ensureContext());
    const frame = this.resolveFrame(page, input.frameId);
    const body = frame.locator('body');
    const rawText = await body.innerText({ timeout: input.timeoutMs });
    const textTruncated = rawText.length > MAX_SEARCHABLE_TEXT_CHARACTERS;
    const text = rawText.slice(0, MAX_SEARCHABLE_TEXT_CHARACTERS);
    const lines: SearchableTextLine[] = text
      .split(/\r?\n/)
      .map((line, index) => ({ line: index + 1, text: line.replace(/\s+/g, ' ').trim() }))
      .filter(({ text: line }) => line.length > 0);
    const needle = input.caseSensitive ? input.query : input.query.toLocaleLowerCase();
    const matches: Array<{ line: number; snippet: string }> = [];
    let matchCount = 0;

    for (const [index, renderedLine] of lines.entries()) {
      const candidate = input.caseSensitive
        ? renderedLine.text
        : renderedLine.text.toLocaleLowerCase();
      const matched = input.mode === 'exact_line' ? candidate === needle : candidate.includes(needle);
      if (!matched) {
        continue;
      }
      matchCount += 1;
      if (matches.length < input.maxResults) {
        matches.push({
          line: renderedLine.line,
          snippet: this.contextualTextSnippet(
            lines,
            index,
            needle,
            input.query.length,
            input.caseSensitive,
            input.mode,
          ),
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

  private contextualTextSnippet(
    lines: SearchableTextLine[],
    matchIndex: number,
    needle: string,
    queryLength: number,
    caseSensitive: boolean,
    mode: 'contains' | 'exact_line',
  ): string {
    const matchedLine = lines[matchIndex];
    if (matchedLine === undefined) {
      return '';
    }
    const seen = new Set([matchedLine.text.toLocaleLowerCase()]);
    const collect = (direction: -1 | 1): SearchableTextLine[] => {
      const selected: SearchableTextLine[] = [];
      let scanned = 0;
      let index = matchIndex + direction;
      while (
        index >= 0 &&
        index < lines.length &&
        selected.length < TEXT_SNIPPET_SURROUNDING_LINES &&
        scanned < TEXT_SNIPPET_CONTEXT_SCAN_LINES
      ) {
        const candidate = lines[index];
        index += direction;
        scanned += 1;
        if (candidate === undefined) {
          continue;
        }
        const duplicateKey = candidate.text.toLocaleLowerCase();
        if (seen.has(duplicateKey)) {
          continue;
        }
        seen.add(duplicateKey);
        selected.push(candidate);
      }
      return direction === -1 ? selected.reverse() : selected;
    };
    const contextualLines = [...collect(-1), matchedLine, ...collect(1)];
    return contextualLines.map((line) => {
      const isMatch = line === matchedLine;
      const boundedText = isMatch
        ? this.boundedMatchingText(line.text, needle, queryLength, caseSensitive, mode)
        : line.text.length <= TEXT_SNIPPET_CONTEXT_LINE_CHARACTERS
          ? line.text
          : `${line.text.slice(0, TEXT_SNIPPET_CONTEXT_LINE_CHARACTERS - 1)}…`;
      return `${isMatch ? '>' : ' '} ${line.line}: ${boundedText}`;
    }).join('\n');
  }

  private boundedMatchingText(
    line: string,
    needle: string,
    queryLength: number,
    caseSensitive: boolean,
    mode: 'contains' | 'exact_line',
  ): string {
    const candidate = caseSensitive ? line : line.toLocaleLowerCase();
    const position = mode === 'exact_line' ? 0 : Math.max(0, candidate.indexOf(needle));
    const start = Math.max(0, position - TEXT_SNIPPET_CONTEXT);
    const end = Math.min(line.length, position + queryLength + TEXT_SNIPPET_CONTEXT);
    return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
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
    const deadlineAt = Date.now() + input.timeoutMs;
    if (this.pendingHandoffRelease !== null) {
      return this.continuePendingHandoffRelease(deadlineAt);
    }
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
      const navigationBudgetMs = remainingHandoffWorkBudget(deadlineAt);
      if (navigationBudgetMs === 0) {
        throw this.handoffReleasePendingError('close_requested', []);
      }
      await this.open({ url: input.url, newTab: false, stabilizationMs: 750, timeoutMs: navigationBudgetMs });
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

    const handoffLabel = this.authenticationHandoffLabel(launchIdentity, targetOrigin);
    const controlledBrowserProcess = this.controlledBrowserProcess;
    if (controlledBrowserProcess === null) {
      throw new Stage5BrowserError(
        'BROWSER_NOT_READY',
        'Stage5 Browser cannot release this profile for private input without an exact durable browser-process identity.',
        {
          recoverable: true,
          details: {
            reason: 'ownership_unverified',
            suggestedAction: 'Stop before entering private information. Run browser_diagnostics and correct the ownership evidence before requesting a private handoff.',
          },
        },
      );
    }
    this.pendingHandoffRelease = {
      mode: 'human_bootstrap',
      state: 'releasing_control',
      requestedAt: new Date().toISOString(),
      launchTarget,
      profileDir,
      launchIdentity,
      handoffLabel,
      targetUrl,
      targetOrigin,
      beforeUrl,
      beforeSemanticFingerprint,
      controlledBrowserProcess,
      closeRequestCompleted: false,
    };
    await this.ownershipLease.updatePhase('close_requested');
    const closeBudgetMs = remainingHandoffWorkBudget(deadlineAt);
    const closeCompleted = closeBudgetMs > 0 && await boundedValue(
      context.close({ reason: 'Stage5 Browser released the profile for private human interaction.' })
        .then(() => true),
      closeBudgetMs,
      false,
    );
    if (this.pendingHandoffRelease !== null) {
      this.pendingHandoffRelease.closeRequestCompleted = closeCompleted;
    }
    this.clearControlledBrowserState();
    return this.continuePendingHandoffRelease(deadlineAt);
  }

  private async continuePendingHandoffRelease(
    deadlineAt: number,
  ): Promise<BrowserCommandOutput<'requestLoginHandoff'>> {
    const pending = this.pendingHandoffRelease;
    if (pending === null) {
      throw new Stage5BrowserError('AUTH_HANDOFF_REQUIRED', 'No private handoff release is pending.', {
        recoverable: true,
        details: {
          reason: 'no_pending_handoff',
          suggestedAction: 'Request the private interaction handoff from the exact page that needs user input.',
        },
      });
    }

    const processBudgetMs = remainingHandoffWorkBudget(deadlineAt);
    const processExited = processBudgetMs > 0 && await this.waitForExactOwnedProcessExit(
      pending.controlledBrowserProcess,
      processBudgetMs,
    );
    if (!processExited) {
      const profile = await inspectProfile(pending.profileDir, false);
      throw this.handoffReleasePendingError('close_requested', profile.lockFiles, pending);
    }
    await this.ownershipLease.updatePhase('process_exited');

    const unlockBudgetMs = remainingHandoffWorkBudget(deadlineAt);
    let profileUnlocked = unlockBudgetMs > 0
      && await waitForProfileUnlock(pending.profileDir, unlockBudgetMs);
    if (!profileUnlocked) {
      const profile = await inspectProfile(pending.profileDir, false);
      profileUnlocked = profile.lockFiles.length === 0;
      if (!profileUnlocked) {
        throw this.handoffReleasePendingError('process_exited', profile.lockFiles, pending);
      }
    }
    await this.ownershipLease.updatePhase('profile_unlocked');

    if (remainingHandoffWorkBudget(deadlineAt) === 0) {
      throw this.handoffReleasePendingError('profile_unlocked', [], pending);
    }
    const [beforeStorage, beforeProfileShutdown] = await Promise.all([
      this.profileStorageInspector(
        pending.launchIdentity.profile,
        pending.launchIdentity.engine,
        pending.targetOrigin,
      ),
      inspectProfileShutdown(
        pending.profileDir,
        this.selectedBrowser,
        pending.launchIdentity.profile.profileDirectory,
      ),
    ]);
    await this.ownershipLease.release();

    const humanLeaseClaimed = await this.ownershipLease.claim({
      profileRoot: pending.profileDir,
      identity: pending.launchIdentity,
      controlMode: 'human_handoff',
    });
    if (!humanLeaseClaimed) {
      const competingLease = await inspectProfileOwnershipLease(
        pending.profileDir,
        pending.launchIdentity,
        this.ownershipLease.leaseId,
      );
      throw this.ownershipLeaseError(competingLease, pending.launchIdentity);
    }

    let session: HumanBrowserSession;
    try {
      session = await this.humanBrowserLauncher.launch({
        target: pending.launchTarget,
        profileDir: pending.profileDir,
        handoffLabel: pending.handoffLabel,
        url: pending.targetUrl,
      });
    } catch (error) {
      if (await ownershipProfileUnlocked(pending.profileDir)) {
        await this.ownershipLease.updatePhase('profile_unlocked').catch(() => undefined);
        await this.ownershipLease.release().catch(() => undefined);
      }
      this.state = 'failed';
      const diagnostic = launchFailureDiagnostic(this.selectedBrowser, error);
      this.lastLaunchFailure = diagnostic;
      throw new Stage5BrowserError(
        'BROWSER_NOT_READY',
        'The private human-interaction browser could not be launched.',
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
    const humanProcessState = session.state();
    const humanProcessStartedAt = humanProcessState.processId === null
      ? null
      : await processStartedAtToken(humanProcessState.processId);
    if (humanProcessState.processId === null || humanProcessStartedAt === null) {
      throw new Stage5BrowserError(
        'BROWSER_NOT_READY',
        'The private browser launched, but Stage5 could not establish its exact durable ownership identity.',
        {
          recoverable: true,
          details: {
            reason: 'ownership_unverified',
            suggestedAction: `Do not enter private information. Close only the newly opened ${humanLaunchIdentity.applicationName} normally, wait for it to exit, then request the handoff once.`,
          },
        },
      );
    }
    await this.ownershipLease.establish({
      profileRoot: pending.profileDir,
      identity: humanLaunchIdentity,
      browserProcess: {
        processId: humanProcessState.processId,
        startedAt: humanProcessStartedAt,
        executablePath: humanLaunchIdentity.executablePath,
      },
      controlMode: 'human_handoff',
      phase: 'human_input',
    });

    this.authenticationHandoff = {
      mode: 'human_bootstrap',
      state: 'awaiting_user',
      targetOrigin: pending.targetOrigin,
      requestedAt: pending.requestedAt,
      resumedAt: null,
      page: null,
      profileDir: pending.profileDir,
      launchIdentity: humanLaunchIdentity,
      handoffLabel: pending.handoffLabel,
      targetUrl: pending.targetUrl,
      beforeUrl: pending.beforeUrl,
      beforeSemanticFingerprint: pending.beforeSemanticFingerprint,
      beforeStorage,
      beforeProfileShutdown,
      session,
      profileShutdown: null,
      shutdownOverrideOffered: false,
    };
    this.pendingHandoffRelease = null;
    this.state = 'stopped';

    if (!sameLaunchIdentity(pending.launchIdentity, humanLaunchIdentity)) {
      throw new Stage5BrowserError(
        'AUTH_NOT_PERSISTED',
        'The native private-interaction browser did not launch with the controlled browser identity.',
        {
          recoverable: true,
          details: {
            reason: 'auth_launch_identity_mismatch',
            controlledIdentity: pending.launchIdentity,
            humanIdentity: humanLaunchIdentity,
            suggestedAction: 'Do not enter private information. Quit only the newly opened browser normally and correct the configured backend before requesting another handoff.',
          },
        },
      );
    }

    const continuousAttachment = session.controlChannel?.()?.kind === 'chromium_cdp';
    return {
      ...(await this.authenticationStatus(undefined)),
      userActionRequired: true,
      instructions: continuousAttachment
        ? `Use only the newly opened ${humanLaunchIdentity.applicationName} window identified as “${pending.handoffLabel}”. It uses the Stage5 ${humanLaunchIdentity.browser} profile partition “${humanLaunchIdentity.profile.profileDirectory ?? 'profile root'}” for ${pending.targetOrigin ?? 'the requested page'}. Complete only the private step yourself—such as a password, passkey, OTP, EIN, identity document, or selfie—then leave that exact browser application open and tell the agent to call browser_resume_after_login. Never send private values or documents to the agent.`
        : `Use only the newly opened ${humanLaunchIdentity.applicationName} window identified as “${pending.handoffLabel}”. It uses the Stage5 ${humanLaunchIdentity.browser} profile partition “${humanLaunchIdentity.profile.profileDirectory ?? 'profile root'}” for ${pending.targetOrigin ?? 'the requested page'}. Complete only the private step yourself—such as a password, passkey, OTP, EIN, identity document, or selfie—then quit ${humanLaunchIdentity.applicationName} normally so its process exits. On macOS, use Cmd-Q in that exact application; closing only a tab or window may leave it running. Never send private values or documents to the agent. After it exits, tell the agent to call browser_resume_after_login.`,
    };
  }

  private async waitForExactOwnedProcessExit(
    processObservation: OwnedProcessObservation,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadlineAt = Date.now() + Math.max(1, timeoutMs);
    do {
      if (!(await this.exactOwnedProcessStillRunning(processObservation))) return true;
      if (Date.now() >= deadlineAt) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadlineAt - Date.now())));
    } while (Date.now() < deadlineAt);
    return !(await this.exactOwnedProcessStillRunning(processObservation));
  }

  private async exactOwnedProcessStillRunning(
    processObservation: OwnedProcessObservation,
  ): Promise<boolean> {
    if (!processIsRunning(processObservation.processId)) return false;
    const observedStart = await boundedValue(
      processStartedAtToken(processObservation.processId),
      500,
      null,
    );
    return observedStart === null || observedStart === processObservation.startedAt;
  }

  private handoffReleasePendingError(
    phase: 'close_requested' | 'process_exited' | 'profile_unlocked',
    profileLockFiles: string[],
    pending = this.pendingHandoffRelease,
  ): Stage5BrowserError {
    const applicationName = pending?.launchIdentity.applicationName ?? 'the dedicated browser';
    return new Stage5BrowserError(
      'AUTH_HANDOFF_REQUIRED',
      phase === 'close_requested'
        ? `Stage5 requested ${applicationName} to close, but its exact owned process has not exited within this operation budget.`
        : phase === 'process_exited'
          ? `The exact owned ${applicationName} process exited, but its profile has not unlocked within this operation budget.`
          : `The exact owned ${applicationName} process exited and its profile unlocked; Stage5 retained the handoff so it can continue safely.`,
      {
        recoverable: true,
        details: {
          reason: 'handoff_release_pending',
          phase,
          closeRequestCompleted: pending?.closeRequestCompleted ?? null,
          profileLockFiles,
          ownershipRetained: true,
          suggestedAction: 'Do not reopen the browser, repeat authentication, delete profile locks, or switch backends. Call browser_request_login_handoff once more; Stage5 will resume this exact release phase instead of relaunching the controlled browser.',
        },
      },
    );
  }

  async resumeAfterLogin(
    input: BrowserCommandInput<'resumeAfterLogin'>,
  ): Promise<BrowserCommandOutput<'resumeAfterLogin'>> {
    const deadlineAt = Date.now() + input.timeoutMs;
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
    let processState = handoff.session.state();
    const continuousChromiumHandoff = handoff.launchIdentity.engine === 'chromium'
      && handoff.session.controlChannel?.()?.kind === 'chromium_cdp';
    if (continuousChromiumHandoff && !processState.running) {
      await removeNativeControlRecord(handoff.profileDir);
      await this.ownershipLease.updatePhase('process_exited').catch(() => undefined);
      if (await ownershipProfileUnlocked(handoff.profileDir)) {
        await this.ownershipLease.updatePhase('profile_unlocked').catch(() => undefined);
        await this.ownershipLease.release().catch(() => undefined);
      }
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
      const exitBudgetMs = remainingHandoffWorkBudget(deadlineAt);
      if (exitBudgetMs > 0) {
        await handoff.session.waitForExit(exitBudgetMs);
        processState = handoff.session.state();
      }
      if (processState.running) {
        throw new Stage5BrowserError(
          'AUTH_HANDOFF_REQUIRED',
          'The private human-interaction browser is still running.',
          {
            recoverable: true,
            details: {
              reason: 'human_browser_still_running',
              phase: 'human_input',
              ownershipRetained: true,
              suggestedAction: `Complete the private step and quit ${handoff.launchIdentity.applicationName} normally so its process exits, then call browser_resume_after_login once. On macOS, use Cmd-Q in that exact application; closing only a tab or window may leave it running.`,
            },
          },
        );
      }
    }

    let afterHumanStorage: ProfileStorageInspection | null = null;
    if (!continuousChromiumHandoff) {
      await this.ownershipLease.updatePhase('process_exited');
      const unlockBudgetMs = remainingHandoffWorkBudget(deadlineAt);
      let profileUnlocked = unlockBudgetMs > 0
        && await waitForProfileUnlock(handoff.profileDir, unlockBudgetMs);
      if (!profileUnlocked) {
        profileUnlocked = (await inspectProfile(handoff.profileDir, false)).lockFiles.length === 0;
      }
      if (!profileUnlocked) {
        const profile = await inspectProfile(handoff.profileDir, false);
        throw new Stage5BrowserError(
          'AUTH_HANDOFF_REQUIRED',
          'The private browser process exited, but its profile is still locked.',
          {
            recoverable: true,
            details: {
              reason: 'profile_locked_after_handoff',
              phase: 'process_exited',
              profileLockFiles: profile.lockFiles,
              ownershipRetained: true,
              suggestedAction: 'Do not reopen the browser, repeat the private step, or delete profile locks. Call browser_resume_after_login once more; Stage5 will continue waiting on this same handoff instead of relaunching it.',
            },
          },
        );
      }

      await this.ownershipLease.updatePhase('profile_unlocked');
      await this.ownershipLease.release();

      if (remainingHandoffWorkBudget(deadlineAt) === 0) {
        throw new Stage5BrowserError(
          'AUTH_HANDOFF_REQUIRED',
          'The private browser exited and its profile unlocked, but this operation budget ended before controlled reattachment.',
          {
            recoverable: true,
            details: {
              reason: 'handoff_resume_pending',
              phase: 'profile_unlocked',
              profileLockFiles: [],
              suggestedAction: 'Do not reopen the browser or repeat the private step. Call browser_resume_after_login once more to continue with the same unlocked profile.',
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
      await this.start({}, handoff.targetOrigin, continuousChromiumHandoff);
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
        await this.waitForUrlExpectation(
          page,
          input.expected,
          input.timeoutMs,
          'Login handoff',
          true,
        );
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

  private lockedProfileOwnerError(
    inspection: ChromiumProfileOwnerInspection,
  ): Stage5BrowserError {
    const authenticationHandoffPending =
      inspection.evidence.classification === 'authentication_handoff_pending';
    return new Stage5BrowserError(
      authenticationHandoffPending ? 'AUTH_HANDOFF_REQUIRED' : 'BROWSER_NOT_READY',
      authenticationHandoffPending
        ? 'The dedicated Chromium profile appears to be in a private authentication handoff.'
        : 'The dedicated Chromium profile is locked and Stage5 Browser cannot safely reattach to its owner.',
      {
        recoverable: true,
        details: {
          reason: 'profile_locked',
          ownershipReason: inspection.evidence.classification,
          profileOwner: inspection.evidence,
          suggestedAction: inspection.evidence.suggestedAction,
        },
      },
    );
  }

  private safeLeaseEvidence(
    inspection: ProfileOwnershipLeaseInspection,
    applicationName: string,
  ): Record<string, unknown> {
    return {
      classification: inspection.state,
      ownershipProven: inspection.ownershipProven,
      expectedApplication: applicationName,
      ownerWorkerRunning: inspection.ownerWorkerRunning,
      heartbeat: inspection.heartbeat,
      browserProcess: inspection.browserProcess,
      controlMode: inspection.lease?.controlMode ?? null,
      phase: inspection.lease?.phase ?? null,
    };
  }

  private leaseSuggestedAction(
    inspection: ProfileOwnershipLeaseInspection,
    applicationName: string,
  ): string {
    if (inspection.state === 'busy_other_stage5_session') {
      return `Another live Stage5 worker owns the dedicated ${applicationName} profile. Continue in that agent session or ask it to call browser_stop; do not retry, terminate the browser, or delete locks.`;
    }
    if (inspection.state === 'owned_orphaned' && inspection.lease?.controlMode === 'human_handoff') {
      return `A private interaction handoff owns the dedicated ${applicationName}. Return to the requesting agent and resume it; if that session is unavailable, ask the user to close only that dedicated application normally. Do not attach, terminate, or delete locks.`;
    }
    if (inspection.state === 'invalid') {
      return `Stage5 found an invalid ownership record for the dedicated ${applicationName} profile. Do not overwrite it, delete browser locks, or kill a process; stop and inspect the profile ownership record before retrying.`;
    }
    return `Do not delete profile locks or kill an unverified process. Close only the visibly identified dedicated ${applicationName} normally, wait for it to exit, then call browser_start once.`;
  }

  private ownershipLeaseError(
    inspection: ProfileOwnershipLeaseInspection,
    identity: BrowserLaunchIdentity,
  ): Stage5BrowserError {
    const handoffPending = inspection.state === 'owned_orphaned'
      && inspection.lease?.controlMode === 'human_handoff';
    const suggestedAction = this.leaseSuggestedAction(inspection, identity.applicationName);
    return new Stage5BrowserError(
      handoffPending ? 'AUTH_HANDOFF_REQUIRED' : 'BROWSER_NOT_READY',
      inspection.state === 'busy_other_stage5_session'
        ? 'The dedicated browser profile is busy in another live Stage5 session.'
        : handoffPending
          ? 'A private interaction handoff survived its Stage5 worker and must not be taken over automatically.'
          : 'The dedicated browser profile ownership state cannot be recovered automatically.',
      {
        recoverable: true,
        details: {
          reason: 'profile_locked',
          ownershipReason: inspection.state,
          profileOwner: this.safeLeaseEvidence(inspection, identity.applicationName),
          suggestedAction,
        },
      },
    );
  }

  private async prepareOwnershipLeaseForStart(
    profileRoot: string,
    identity: BrowserLaunchIdentity,
    resumeOwnedHumanHandoff = false,
  ): Promise<void> {
    const inspection = await inspectProfileOwnershipLease(
      profileRoot,
      identity,
      this.ownershipLease.leaseId,
    );
    if (inspection.state === 'none') return;
    if (inspection.state === 'busy_other_stage5_session' || inspection.state === 'invalid') {
      throw this.ownershipLeaseError(inspection, identity);
    }
    if (inspection.state === 'current_owner') {
      if (
        inspection.lease?.controlMode === 'native_cdp'
        && (inspection.ownershipProven || inspection.lease.phase === 'launching')
      ) return;
      if (
        inspection.ownershipProven
        && resumeOwnedHumanHandoff
        && inspection.lease?.controlMode === 'human_handoff'
      ) return;
      throw this.ownershipLeaseError(inspection, identity);
    }
    if (inspection.state === 'owned_orphaned') {
      if (inspection.lease?.controlMode === 'native_cdp') {
        const claimed = await this.ownershipLease.takeOverProvenOrphan({
          profileRoot,
          identity,
          controlMode: 'native_cdp',
          inspection,
        });
        if (!claimed) {
          const competingLease = await inspectProfileOwnershipLease(
            profileRoot,
            identity,
            this.ownershipLease.leaseId,
          );
          throw this.ownershipLeaseError(competingLease, identity);
        }
        return;
      }
      if (inspection.lease?.controlMode === 'human_handoff') {
        throw this.ownershipLeaseError(inspection, identity);
      }
      const terminated = await terminateProvenOrphan(
        inspection,
        Math.min(this.config.readinessTimeoutMs, 2_000),
      );
      const unlocked = terminated === 'process_exited'
        && await waitForProfileUnlock(profileRoot, Math.min(this.config.readinessTimeoutMs, 2_000));
      if (!unlocked) {
        throw this.ownershipLeaseError(inspection, identity);
      }
      if (inspection.lease !== null) {
        await removeProfileOwnershipLease(profileRoot, inspection.lease.leaseId);
      }
      return;
    }
    if (inspection.state === 'abandoned' && await ownershipProfileUnlocked(profileRoot)) {
      if (inspection.lease !== null) {
        await removeProfileOwnershipLease(profileRoot, inspection.lease.leaseId);
      }
      return;
    }
    throw this.ownershipLeaseError(inspection, identity);
  }

  private async claimNativeControlLeaseIfNeeded(
    profileRoot: string,
    identity: BrowserLaunchIdentity,
    resumeOwnedHumanHandoff = false,
  ): Promise<void> {
    const inspection = await inspectProfileOwnershipLease(
      profileRoot,
      identity,
      this.ownershipLease.leaseId,
    );
    if (
      inspection.state === 'current_owner'
      && inspection.lease?.controlMode === 'native_cdp'
      && (inspection.ownershipProven || inspection.lease.phase === 'launching')
    ) {
      return;
    }
    if (
      resumeOwnedHumanHandoff
      && inspection.state === 'current_owner'
      && inspection.ownershipProven
      && inspection.lease?.controlMode === 'human_handoff'
    ) {
      return;
    }
    if (inspection.state !== 'none') {
      throw this.ownershipLeaseError(inspection, identity);
    }
    const claimed = await this.ownershipLease.claim({
      profileRoot,
      identity,
      controlMode: 'native_cdp',
    });
    if (claimed) return;
    const competingLease = await inspectProfileOwnershipLease(
      profileRoot,
      identity,
      this.ownershipLease.leaseId,
    );
    throw this.ownershipLeaseError(competingLease, identity);
  }

  private async profileOwnerEvidence(
    profile: ProfileDiagnostics,
    launchIdentity: BrowserLaunchIdentity | null,
    humanBootstrapRunning: boolean,
  ): Promise<ProfileOwnerEvidence> {
    let identity = launchIdentity;
    if (identity === null) {
      try {
        const target = await resolveBrowserLaunchTarget(this.selectionFor(this.selectedBrowser));
        identity = launchIdentityForTarget(target, profile.path);
      } catch {
        if (profile.lockFiles.length === 0) return emptyProfileOwnerEvidence();
        return {
          classification: 'unknown_lock_owner',
          ownership: 'not_proven',
          lockOwnerProcess: 'not_running_or_unreadable',
          expectedApplication: null,
          applicationIdentity: 'unverified',
          loopbackControl: 'unverified',
          authenticationHandoff: 'unverified',
          recovery: 'do_not_modify_locks',
          suggestedAction: 'Do not retry, delete profile locks, or kill an unknown owner. Resolve the selected browser executable first, then run browser_diagnostics again.',
        };
      }
    }
    const leaseInspection = await inspectProfileOwnershipLease(
      profile.path,
      identity,
      this.ownershipLease.leaseId,
    );
    if (leaseInspection.state !== 'none') {
      const controlMode = leaseInspection.lease?.controlMode ?? null;
      const humanHandoff = controlMode === 'human_handoff';
      const classification = leaseInspection.state === 'current_owner'
        ? humanHandoff ? 'authentication_handoff_pending' : 'owned_active'
        : leaseInspection.state === 'busy_other_stage5_session'
          ? 'busy_other_stage5_session'
          : leaseInspection.state === 'owned_orphaned'
            ? 'owned_orphaned'
            : 'external_owner';
      const recovery = leaseInspection.state === 'owned_orphaned'
        ? humanHandoff
          ? 'return_to_authentication_handoff'
          : controlMode === 'native_cdp'
            ? 'automatic_reattach'
            : 'automatic_owned_restart'
        : leaseInspection.state === 'current_owner' && !humanHandoff
          ? 'none'
          : 'do_not_modify_locks';
      return {
        classification,
        ownership: leaseInspection.ownershipProven ? 'proven' : 'not_proven',
        lockOwnerProcess: leaseInspection.browserProcess === 'matched'
          ? 'running'
          : leaseInspection.browserProcess === 'not_running'
            ? 'not_running_or_unreadable'
            : 'not_running_or_unreadable',
        expectedApplication: identity.applicationName,
        applicationIdentity: leaseInspection.browserProcess === 'matched'
          ? 'matched'
          : leaseInspection.browserProcess === 'mismatched'
            ? 'mismatched'
            : 'unverified',
        loopbackControl: controlMode === 'native_cdp' ? 'available' : 'unverified',
        authenticationHandoff: humanHandoff ? 'present' : 'absent',
        recovery,
        suggestedAction: leaseInspection.state === 'owned_orphaned' && !humanHandoff
          ? controlMode === 'native_cdp'
            ? 'Call browser_start once; Stage5 will verify and reattach to the exact orphaned native process automatically. Do not close the browser or delete locks.'
            : 'Call browser_start once; Stage5 will terminate only the exact fingerprint-matched orphan, wait for profile unlock, and relaunch it. Do not close the browser or delete locks manually.'
          : this.leaseSuggestedAction(leaseInspection, identity.applicationName),
        lease: {
          state: leaseInspection.state,
          ownerWorkerRunning: leaseInspection.ownerWorkerRunning,
          heartbeat: leaseInspection.heartbeat,
          browserProcess: leaseInspection.browserProcess,
          controlMode,
          phase: leaseInspection.lease?.phase ?? null,
        },
      };
    }
    if (profile.lockFiles.length === 0) {
      return emptyProfileOwnerEvidence();
    }
    if (humanBootstrapRunning) {
      return controlledProfileOwnerEvidence(identity.applicationName, true);
    }
    if (this.usableContext() !== undefined) {
      return controlledProfileOwnerEvidence(identity.applicationName);
    }
    if (BROWSER_ENGINES[this.selectedBrowser] !== 'chromium') {
      return {
        classification: 'external_owner',
        ownership: 'not_proven',
        lockOwnerProcess: 'not_running_or_unreadable',
        expectedApplication: identity.applicationName,
        applicationIdentity: 'unverified',
        loopbackControl: 'unverified',
        authenticationHandoff: 'unverified',
        recovery: 'do_not_modify_locks',
        suggestedAction: 'Do not delete profile locks or force-close an unknown process. Ask the user to close only the visibly identified dedicated Stage5 browser normally, wait for it to exit, then call browser_start once.',
      };
    }
    return (await this.profileOwnerInspector(profile.path, identity)).evidence;
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
      const durableRecord = { ...record, state: 'controlled' as const };
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
    this.controlledBrowserProcessId = engine === 'chromium'
      ? this.nativeControlRecord?.processId
        ?? (launchIdentity.profile.userDataDir === null
          ? null
          : await chromiumProfileOwnerProcessId(launchIdentity.profile.userDataDir))
      : null;
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
        void this.ownershipLease.updatePhase('process_exited');
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
        this.controlledBrowserProcessId = null;
        this.controlledBrowserProcess = null;
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

  private async observeScrollContainers(
    root: Locator,
  ): Promise<{ containers: Map<string, ObservedScrollContainer>; truncated: boolean }> {
    const descendants = root.locator('*');
    const candidateIndexes = await descendants.evaluateAll(
      (elements, limit) => elements
        .map((element, index) => {
          if (!(element instanceof HTMLElement)) {
            return null;
          }
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const visible =
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0';
          const overflowAllowsScrolling =
            style.overflowY === 'auto' ||
            style.overflowY === 'scroll' ||
            style.overflowY === 'overlay' ||
            element.scrollTop > 0;
          if (!visible || !overflowAllowsScrolling || element.scrollHeight - element.clientHeight <= 1) {
            return null;
          }
          const inViewport =
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth;
          return {
            index,
            inViewport,
            visibleArea: Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0))
              * Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0)),
          };
        })
        .filter((candidate): candidate is { index: number; inViewport: boolean; visibleArea: number } => candidate !== null)
        .sort((left, right) =>
          Number(right.inViewport) - Number(left.inViewport) || right.visibleArea - left.visibleArea)
        .slice(0, limit + 1)
        .map(({ index }) => index),
      MAX_SCROLL_CONTAINERS_PER_SNAPSHOT,
    );
    const containers = new Map<string, ObservedScrollContainer>();
    let rootCandidateCount = 0;
    try {
      const rootHandle = await root.elementHandle() as ElementHandle<HTMLElement> | null;
      if (rootHandle !== null) {
        const rootObservation = await this.inspectScrollContainer(rootHandle);
        if (rootObservation === null) {
          await rootHandle.dispose().catch(() => undefined);
        } else {
          const ref = `scroll-${randomUUID()}`;
          containers.set(ref, { handle: rootHandle, observation: { ref, ...rootObservation } });
          rootCandidateCount = 1;
        }
      }

      const remainingCapacity = MAX_SCROLL_CONTAINERS_PER_SNAPSHOT - containers.size;
      for (const index of candidateIndexes.slice(0, remainingCapacity)) {
        const handle = await descendants.nth(index).elementHandle() as ElementHandle<HTMLElement> | null;
        if (handle === null) {
          continue;
        }
        const observation = await this.inspectScrollContainer(handle);
        if (observation === null) {
          await handle.dispose().catch(() => undefined);
          continue;
        }
        const ref = `scroll-${randomUUID()}`;
        containers.set(ref, { handle, observation: { ref, ...observation } });
      }
    } catch (error) {
      for (const { handle } of containers.values()) {
        await handle.dispose().catch(() => undefined);
      }
      throw error;
    }
    return {
      containers,
      truncated: candidateIndexes.length > MAX_SCROLL_CONTAINERS_PER_SNAPSHOT - rootCandidateCount,
    };
  }

  private async inspectScrollContainer(
    handle: ElementHandle<HTMLElement>,
  ): Promise<Omit<ScrollContainerObservation, 'ref'> | null> {
    try {
      return await handle.evaluate((element) => {
        if (
          !(element instanceof HTMLElement) ||
          element === document.scrollingElement ||
          element === document.documentElement ||
          element === document.body
        ) {
          return null;
        }
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0';
        const overflowAllowsScrolling =
          style.overflowY === 'auto' ||
          style.overflowY === 'scroll' ||
          style.overflowY === 'overlay' ||
          element.scrollTop > 0;
        const maxY = Math.max(0, element.scrollHeight - element.clientHeight);
        if (!visible || !overflowAllowsScrolling || maxY <= 1) {
          return null;
        }
        const labelledBy = (element.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ');
        const rawLabel = [
          element.getAttribute('aria-label') ?? '',
          labelledBy,
          element.getAttribute('title') ?? '',
        ].find((candidate) => candidate.trim().length > 0) ?? '';
        const label = rawLabel.replace(/\s+/g, ' ').trim().slice(0, 200);
        return {
          label: label.length === 0 ? null : label,
          role: element.getAttribute('role'),
          inViewport:
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth,
          position: {
            x: element.scrollLeft,
            y: element.scrollTop,
            maxX: Math.max(0, element.scrollWidth - element.clientWidth),
            maxY,
            viewportWidth: element.clientWidth,
            viewportHeight: element.clientHeight,
            contentWidth: element.scrollWidth,
            contentHeight: element.scrollHeight,
          },
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
    retainedHandle: ElementHandle<HTMLElement> | null = null,
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
    for (const { handle } of observed.scrollContainers.values()) {
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
    authenticationRoute = false,
  ): Promise<void> {
    const startedAt = Date.now();
    do {
      const matched = authenticationRoute && expected.match === 'exact'
        ? authenticationRouteMatches(page.url(), expected.url)
        : this.urlMatches(page.url(), expected);
      if (matched) {
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

  private resolveObservedScrollContainer(
    frame: Frame,
    target: BrowserCommandInput<'scroll'>['target'],
  ): ObservedScrollContainer | null {
    if (target === null || target === undefined) {
      return null;
    }
    const observed = this.observedSnapshots.get(frame);
    if (
      observed === undefined ||
      observed.id !== target.snapshotId ||
      observed.documentVersion !== this.documentVersion(frame)
    ) {
      throw new Stage5BrowserError(
        'TARGET_NOT_FOUND',
        'The scroll-container reference does not belong to the latest snapshot of the current document.',
        {
          details: {
            reason: 'stale_or_unknown_snapshot',
            snapshotId: target.snapshotId,
            frameId: this.frameIds.get(frame) ?? null,
          },
        },
      );
    }
    const container = observed.scrollContainers.get(target.ref);
    if (container === undefined) {
      throw new Stage5BrowserError(
        'TARGET_NOT_FOUND',
        'The requested scroll-container reference was not present in that snapshot.',
        {
          details: {
            reason: 'scroll_container_reference_not_observed',
            ref: target.ref,
            snapshotId: target.snapshotId,
          },
        },
      );
    }
    return container;
  }

  private async scrollPosition(
    frame: Frame,
    target: ElementHandle<HTMLElement> | null,
  ): Promise<ScrollPosition> {
    if (target !== null) {
      return target.evaluate((element) => ({
        x: element.scrollLeft,
        y: element.scrollTop,
        maxX: Math.max(0, element.scrollWidth - element.clientWidth),
        maxY: Math.max(0, element.scrollHeight - element.clientHeight),
        viewportWidth: element.clientWidth,
        viewportHeight: element.clientHeight,
        contentWidth: element.scrollWidth,
        contentHeight: element.scrollHeight,
      }));
    }
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
    target: ElementHandle<HTMLElement> | null,
  ): Promise<void> {
    if (target !== null) {
      await target.evaluate((element, { direction: fixedDirection, amount: fixedAmount }) => {
        if (fixedAmount === 'document_start') {
          element.scrollTo({ top: 0, behavior: 'instant' });
          return;
        }
        if (fixedAmount === 'document_end') {
          element.scrollTo({ top: element.scrollHeight, behavior: 'instant' });
          return;
        }
        const multiplier = fixedAmount === 'half_viewport' ? 0.5 : 1;
        const sign = fixedDirection === 'down' ? 1 : -1;
        element.scrollBy({ top: element.clientHeight * multiplier * sign, behavior: 'instant' });
      }, { direction, amount });
      return;
    }
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

  private async scrollContentObservation(
    frame: Frame,
    surface: ScrollContentObservationSurface,
  ): Promise<ScrollContentSample | null> {
    try {
      if (surface.handle !== null) {
        return await surface.handle.evaluate(observeScrollContentForRoot);
      }
      return await frame.evaluate(observeScrollContentForRoot, null);
    } catch (error) {
      if (surface.handle !== null) {
        const stillConnected = await surface.handle.evaluate((element) => element.isConnected)
          .catch(() => false);
        if (!stillConnected) {
          return null;
        }
      }
      if (error instanceof Error && error.message.includes('scroll_content_observation_incomplete')) {
        throw new Stage5BrowserError(
          'OPERATION_FAILED',
          'The selected scroll surface exceeded the bounded semantic observation limits.',
          {
            recoverable: true,
            details: {
              reason: 'scroll_observation_incomplete',
              suggestedAction: 'Use one fresh snapshot to target a smaller observed scroll container; Stage5 Browser will not infer growth or loader disappearance from a truncated sample.',
            },
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  private async resolveScrollContentObservationSurface(
    frame: Frame,
    target: ElementHandle<HTMLElement> | null,
  ): Promise<ScrollContentObservationSurface> {
    if (target !== null) {
      return { handle: target, ownsHandle: false };
    }
    const candidate = await frame.evaluateHandle(() => {
      const viewportIntersects = (candidate: Element): boolean => {
        const rect = candidate.getBoundingClientRect();
        const style = getComputedStyle(candidate);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none'
          && style.visibility !== 'hidden' && style.opacity !== '0'
          && rect.bottom > 0 && rect.right > 0
          && rect.top < window.innerHeight && rect.left < window.innerWidth;
      };
      const visible = Array.from(document.querySelectorAll('[role="feed"]'))
        .filter(viewportIntersects);
      return visible.length === 1 ? visible[0] ?? null : null;
    });
    const handle = candidate.asElement();
    if (handle === null) {
      await candidate.dispose().catch(() => undefined);
      return { handle: null, ownsHandle: false };
    }
    return { handle: handle as ElementHandle<HTMLElement>, ownsHandle: true };
  }

  private async waitForScrollContent(
    page: Page,
    frame: Frame,
    surface: ScrollContentObservationSurface,
    before: ScrollContentSample,
    expectation: BrowserCommandInput<'scroll'>['waitFor'],
    remainingTimeoutMs: number,
  ): Promise<ScrollWaitResult> {
    const observationSurfaceUnavailable = (): Stage5BrowserError => new Stage5BrowserError(
      'OPERATION_FAILED',
      'The pinned scroll observation surface was replaced before comparable content evidence could be collected.',
      {
        recoverable: true,
        details: {
          reason: 'scroll_observation_surface_unavailable',
          suggestedAction: 'Inspect one fresh snapshot before continuing; Stage5 Browser will not compare or replay against a replacement surface.',
        },
      },
    );
    if (expectation === null || expectation === undefined) {
      const after = await this.scrollContentObservation(frame, surface);
      if (after === null) {
        throw observationSurfaceUnavailable();
      }
      return {
        requested: false,
        condition: null,
        satisfied: false,
        evidence: 'not_requested',
        waitedMs: 0,
        before: publicScrollContentObservation(before),
        after: publicScrollContentObservation(after),
      };
    }
    const startedAt = Date.now();
    const budgetMs = Math.max(0, Math.min(expectation.timeoutMs, remainingTimeoutMs));
    const initialObservation = await this.scrollContentObservation(frame, surface);
    if (initialObservation === null) {
      throw observationSurfaceUnavailable();
    }
    let after = initialObservation;
    let loadingObserved = before.loadingIndicatorCount > 0 || after.loadingIndicatorCount > 0;
    let semanticLoadingObserved = before.semanticLoadingIndicatorCount > 0 ||
      after.semanticLoadingIndicatorCount > 0;
    let animationObservationComplete = before.animationObservationComplete &&
      after.animationObservationComplete;
    while (true) {
      const elapsed = Date.now() - startedAt;
      const articleGrew = after.articleCount > before.articleCount;
      const loadingDisappeared = loadingObserved &&
        after.loadingIndicatorCount === 0 &&
        (semanticLoadingObserved || animationObservationComplete);
      const satisfied = expectation.condition === 'article_count_growth'
        ? articleGrew
        : expectation.condition === 'loading_indicators_disappear'
          ? loadingDisappeared
          : articleGrew || loadingDisappeared;
      if (satisfied && elapsed <= budgetMs) {
        return {
          requested: true,
          condition: expectation.condition,
          satisfied: true,
          evidence: expectation.condition === 'article_count_growth'
            ? 'article_count_growth'
            : expectation.condition === 'loading_indicators_disappear'
              ? 'loading_indicators_disappeared'
              : articleGrew
                ? 'article_count_growth'
                : 'loading_indicators_disappeared',
          waitedMs: elapsed,
          before: publicScrollContentObservation(before),
          after: publicScrollContentObservation(after),
        };
      }
      if (elapsed >= budgetMs) {
        const loadingEvidenceRequested = expectation.condition === 'loading_indicators_disappear' ||
          expectation.condition === 'either';
        if (
          loadingEvidenceRequested &&
          !semanticLoadingObserved &&
          loadingObserved &&
          after.loadingIndicatorCount === 0 &&
          !animationObservationComplete
        ) {
          throw new Stage5BrowserError(
            'OPERATION_FAILED',
            'The selected scroll surface exceeded the bounded animated-loader observation limit.',
            {
              recoverable: true,
              details: {
                reason: 'scroll_observation_incomplete',
                suggestedAction: 'Use one fresh snapshot to target a smaller observed scroll container; Stage5 Browser will not infer disappearance from a truncated animated-loader sample.',
              },
            },
          );
        }
        return {
          requested: true,
          condition: expectation.condition,
          satisfied: false,
          evidence: 'timeout',
          waitedMs: elapsed,
          before: publicScrollContentObservation(before),
          after: publicScrollContentObservation(after),
        };
      }
      await page.waitForTimeout(Math.min(100, Math.max(1, budgetMs - elapsed)));
      const observed = await this.scrollContentObservation(frame, surface);
      if (observed === null) {
        throw observationSurfaceUnavailable();
      }
      after = observed;
      loadingObserved ||= after.loadingIndicatorCount > 0;
      semanticLoadingObserved ||= after.semanticLoadingIndicatorCount > 0;
      animationObservationComplete &&= after.animationObservationComplete;
    }
  }

  private async countNestedScrollContainerCandidates(frame: Frame): Promise<number> {
    return frame.locator('body *').evaluateAll((elements) => elements.reduce((count, element) => {
      if (!(element instanceof HTMLElement)) {
        return count;
      }
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none'
        && style.visibility !== 'hidden' && style.opacity !== '0';
      const overflowAllowsScrolling = style.overflowY === 'auto' || style.overflowY === 'scroll'
        || style.overflowY === 'overlay' || element.scrollTop > 0;
      return visible && overflowAllowsScrolling && element.scrollHeight - element.clientHeight > 1
        ? count + 1
        : count;
    }, 0));
  }

  private async authenticationStatus(page: Page | undefined): Promise<AuthenticationStatus> {
    const context = this.usableContext();
    const connected = context !== undefined;
    const handoff = this.authenticationHandoff;
    const pendingRelease = this.pendingHandoffRelease;
    const targetPageIndex = page === undefined || context === undefined
      ? -1
      : context.pages().filter((candidate) => !candidate.isClosed()).indexOf(page);
    const state = handoff?.state ?? pendingRelease?.state ?? (connected ? 'profile_ready' : 'browser_stopped');
    const processState = handoff?.session.state() ?? null;
    const profileBinding = handoff?.launchIdentity.profile
      ?? pendingRelease?.launchIdentity.profile
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
      targetOrigin: handoff?.targetOrigin
        ?? pendingRelease?.targetOrigin
        ?? (page === undefined ? null : this.urlOrigin(page.url())),
      requestedAt: handoff?.requestedAt ?? pendingRelease?.requestedAt ?? null,
      resumedAt: handoff?.resumedAt ?? null,
      targetPageIndex: targetPageIndex < 0 ? null : targetPageIndex,
      targetPageAvailable: targetPageIndex >= 0,
      page: page === undefined ? null : await this.pageSummary(page),
      verificationRequired: state === 'ready_for_agent_verification',
      controlMode: handoff?.state === 'awaiting_user' || pendingRelease !== null
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
    message = 'A private human interaction is in progress for the dedicated Stage5 browser profile.',
  ): Stage5BrowserError {
    const applicationName = this.authenticationHandoff?.launchIdentity.applicationName
      ?? this.pendingHandoffRelease?.launchIdentity.applicationName
      ?? 'the dedicated browser';
    const continuousAttachment = this.authenticationHandoff?.session.controlChannel?.()?.kind === 'chromium_cdp';
    const releasePending = this.pendingHandoffRelease !== null;
    return new Stage5BrowserError('AUTH_HANDOFF_REQUIRED', message, {
      recoverable: true,
      details: {
        reason: releasePending ? 'handoff_release_pending' : 'human_authentication_in_progress',
        phase: this.pendingHandoffRelease?.state ?? this.authenticationHandoff?.state ?? null,
        suggestedAction: releasePending
          ? 'Call browser_request_login_handoff once more to resume the retained close → process exit → profile unlock phase. Do not relaunch the browser, switch backends, or delete profile locks.'
          : continuousAttachment
          ? `Finish authentication in ${applicationName}, leave that exact application open, then call browser_resume_after_login. Stage5 Browser will attach only after that explicit call.`
          : `Finish the private interaction and quit ${applicationName} normally so its process exits, then call browser_resume_after_login. On macOS, use Cmd-Q in that exact application; closing only a tab or window may leave it running. Stage5 Browser will not control or force-close it.`,
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
    this.controlledBrowserProcessId = null;
    this.controlledBrowserProcess = null;
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

  private async pageSummary(
    page: Page,
    suppliedIndex?: number,
    timeoutMs = 1_000,
  ): Promise<PageSummary> {
    const context = this.usableContext();
    const pages = context?.pages().filter((candidate) => !candidate.isClosed()) ?? [];
    const index = suppliedIndex ?? Math.max(0, pages.indexOf(page));
    const deadlineAt = Date.now() + Math.max(1, timeoutMs);
    const title = await boundedValue(
      page.title(),
      Math.max(1, remainingUntil(deadlineAt)),
      '<unavailable>',
    );
    const readyState = await boundedValue(
      page.evaluate(() => document.readyState),
      Math.max(1, remainingUntil(deadlineAt)),
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
    timeoutMs: number,
  ): Promise<SafeTargetState | null> {
    const startedAt = Date.now();
    const deadline = startedAt + Math.min(timeoutMs, CLICK_ROLE_RESOLUTION_TIMEOUT_MS);
    const countWithinDeadline = (): Promise<number> => boundedValue(
      locator.count(),
      Math.max(1, deadline - Date.now()),
      -1,
    );
    let count = await countWithinDeadline();
    while (count === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
      count = await countWithinDeadline();
    }
    if (count === -1) {
      this.pageDiagnostics.recordAction(
        page,
        this.targetingFailureDiagnostic(action, page, 'target_missing'),
      );
      throw new Stage5BrowserError('OPERATION_FAILED', 'Role resolution exceeded the shared click deadline before any input was dispatched.', {
        recoverable: true,
        details: {
          role,
          name,
          reason: 'role_resolution_deadline_expired',
          actionDispatched: false,
          clickDispatched: false,
          resolutionWaitMs: Date.now() - startedAt,
          suggestedAction: 'Take one fresh semantic snapshot; Stage5 Browser confirmed that no click was dispatched.',
        },
      });
    }
    if (count === 0) {
      this.pageDiagnostics.recordAction(
        page,
        this.targetingFailureDiagnostic(action, page, 'target_missing'),
      );
      throw new Stage5BrowserError('TARGET_NOT_FOUND', 'No element matched the requested role and accessible name.', {
        recoverable: true,
        details: {
          role,
          name,
          actionDispatched: false,
          clickDispatched: false,
          resolutionWaitMs: Date.now() - startedAt,
          suggestedAction: 'The role action emitted no input. Take a fresh semantic snapshot because any visible state change came from earlier or autonomous page activity.',
        },
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
    return boundedValue(
      inspectTargetState(locator),
      Math.max(1, timeoutMs - (Date.now() - startedAt)),
      null,
    );
  }

  private screenshotArtifactClassification(data: Buffer): 'contentful' | 'possibly_uniform' {
    const pngSignature = '89504e470d0a1a0a';
    if (data.byteLength < 24 || data.subarray(0, 8).toString('hex') !== pngSignature) {
      return 'possibly_uniform';
    }
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    const pixelCount = width * height;
    if (!Number.isSafeInteger(pixelCount) || pixelCount <= 0) {
      return 'possibly_uniform';
    }
    return data.byteLength / pixelCount >= SCREENSHOT_MIN_COMPRESSED_BYTES_PER_PIXEL
      ? 'contentful'
      : 'possibly_uniform';
  }

  private async prepareRoleClickTarget(
    page: Page,
    locator: Locator,
    startedAt: string,
    actionDeadlineAt: number,
    role: string,
    name: string,
  ): Promise<PreparedObservedClickTarget> {
    let lastTargetState: SafeTargetState | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      lastTargetState = await this.requireUniqueClickTarget(
        page,
        locator,
        'click_by_role',
        role,
        name,
        remainingUntil(actionDeadlineAt),
      );
      const handle = await boundedValue(
        locator.elementHandle(),
        Math.max(1, remainingUntil(actionDeadlineAt)),
        null,
      );
      if (handle === null) {
        if (attempt === 0 && remainingUntil(actionDeadlineAt) > 0) {
          continue;
        }
        this.failClickBeforeDispatch(
          page,
          startedAt,
          lastTargetState,
          'detached',
          'role_target_detached_before_dispatch',
          'The uniquely matched role target detached before exact-target dispatch began.',
          'Take one fresh semantic snapshot; Stage5 Browser confirmed that no input was dispatched.',
          'TARGET_NOT_FOUND',
          'click_by_role',
        );
      }

      try {
        await locator.scrollIntoViewIfNeeded({
          timeout: Math.max(1, remainingUntil(actionDeadlineAt)),
        });
      } catch {
        // The exact handle is inspected below; failure remains pre-dispatch.
      }
      const postScrollSettleMs = Math.min(
        CLICK_REF_INCREMENTAL_SETTLE_MS,
        remainingUntil(actionDeadlineAt),
      );
      if (postScrollSettleMs > 0) {
        await page.waitForTimeout(postScrollSettleMs);
      }
      const targetState = await boundedValue(
        inspectTargetState(handle),
        Math.max(1, remainingUntil(actionDeadlineAt)),
        null,
      );
      if (targetState === null) {
        await handle.dispose().catch(() => undefined);
        if (attempt === 0 && remainingUntil(actionDeadlineAt) > 0) {
          const settleMs = Math.min(CLICK_REF_INCREMENTAL_SETTLE_MS, remainingUntil(actionDeadlineAt));
          if (settleMs > 0) await page.waitForTimeout(settleMs);
          continue;
        }
        this.failClickBeforeDispatch(
          page,
          startedAt,
          lastTargetState,
          'detached',
          'role_target_detached_before_dispatch',
          'The uniquely matched role target detached during pre-input viewport preparation.',
          'Take one fresh semantic snapshot; Stage5 Browser confirmed that no input was dispatched.',
          'TARGET_NOT_FOUND',
          'click_by_role',
        );
      }

      const failure = !targetState.visible || !targetState.inViewport
        ? { diagnostic: 'not_visible' as const }
        : !targetState.enabled
          ? { diagnostic: 'not_enabled' as const }
          : targetState.receivesPointerEvents === false
            ? { diagnostic: 'pointer_intercepted' as const }
            : null;
      if (failure !== null) {
        await handle.dispose().catch(() => undefined);
        this.failClickBeforeDispatch(
          page,
          startedAt,
          targetState,
          failure.diagnostic,
          failure.diagnostic,
          'The uniquely matched role target was not safely actionable before exact-target dispatch.',
          'Take a fresh semantic snapshot and resolve the reported target state before another click.',
          'OPERATION_FAILED',
          'click_by_role',
        );
      }

      return {
        locator,
        handle,
        targetState,
        activation: await this.preferredObservedClickActivation(handle, actionDeadlineAt),
      };
    }

    this.failClickBeforeDispatch(
      page,
      startedAt,
      lastTargetState,
      'detached',
      'role_target_detached_before_dispatch',
      'The uniquely matched role target could not be retained through pre-input preparation.',
      'Take one fresh semantic snapshot; Stage5 Browser confirmed that no input was dispatched.',
      'TARGET_NOT_FOUND',
      'click_by_role',
    );
  }

  private async preferredObservedClickActivation(
    handle: ElementHandle<HTMLElement | SVGElement>,
    actionDeadlineAt: number,
  ): Promise<PreparedObservedClickTarget['activation']> {
    const useKeyboard = await boundedValue(
      handle.evaluate((element) => {
        if (!(element instanceof HTMLButtonElement)) return false;
        const hasPopup = element.getAttribute('aria-haspopup');
        return (hasPopup !== null && hasPopup.toLocaleLowerCase() !== 'false')
          || element.hasAttribute('aria-expanded');
      }),
      Math.max(1, remainingUntil(actionDeadlineAt)),
      false,
    );
    return useKeyboard ? 'keyboard_enter' : 'pointer';
  }

  private async prepareObservedClickTarget(
    page: Page,
    frame: Frame,
    locator: Locator,
    startedAt: string,
    actionDeadlineAt: number,
  ): Promise<PreparedObservedClickTarget> {
    let preparedLocator = locator;
    let handle = await boundedValue(
      locator.elementHandle(),
      Math.max(1, remainingUntil(actionDeadlineAt)),
      null,
    );
    if (handle === null) {
      this.failClickBeforeDispatch(
        page,
        startedAt,
        null,
        'detached',
        'reference_handle_missing',
        'The observed reference detached before viewport preparation began.',
        'Take one fresh semantic snapshot; Stage5 Browser did not dispatch the click.',
        'TARGET_NOT_FOUND',
      );
    }

    let targetState = await boundedValue(
      inspectTargetState(handle),
      Math.max(1, remainingUntil(actionDeadlineAt)),
      null,
    );
    if (targetState === null) {
      await handle.dispose().catch(() => undefined);
      this.failClickBeforeDispatch(
        page,
        startedAt,
        null,
        'detached',
        'target_detached_before_scroll',
        'The observed element detached before Stage5 Browser could prepare it for a click.',
        'Take one fresh semantic snapshot; Stage5 Browser did not dispatch the click.',
        'TARGET_NOT_FOUND',
      );
    }

    const identity = targetState.inViewport
      ? null
      : await boundedValue(
        this.observeClickTargetIdentity(handle),
        Math.max(1, remainingUntil(actionDeadlineAt)),
        null,
      );
    const preparationDeadline = Math.min(
      actionDeadlineAt,
      Date.now() + CLICK_REF_VIEWPORT_PREPARATION_TIMEOUT_MS,
    );

    for (
      let step = 0;
      !targetState.inViewport &&
        step < CLICK_REF_INCREMENTAL_SCROLL_STEPS &&
        Date.now() < preparationDeadline;
      step += 1
    ) {
      const movement = await boundedValue(
        this.incrementalScrollTowardClickTarget(handle),
        Math.max(1, remainingUntil(preparationDeadline)),
        null,
      );
      if (movement === null) {
        const rebound = await this.waitForVirtualizedClickTarget(
          frame,
          locator,
          identity,
          preparationDeadline,
        );
        if (rebound.kind !== 'resolved') {
          await handle.dispose().catch(() => undefined);
          this.failVirtualizedClickRebind(page, startedAt, rebound.kind, targetState);
        }
        await handle.dispose().catch(() => undefined);
        handle = rebound.handle;
        preparedLocator = rebound.locator;
      } else if (!movement.moved && !movement.targetInViewport) {
        break;
      }

      const remaining = preparationDeadline - Date.now();
      if (remaining > 0) {
        await page.waitForTimeout(Math.min(CLICK_REF_INCREMENTAL_SETTLE_MS, remaining));
      }
      const priorTargetState = targetState;
      targetState = await boundedValue(
        inspectTargetState(handle),
        Math.max(1, remainingUntil(preparationDeadline)),
        null,
      );
      if (targetState === null) {
        const rebound = await this.waitForVirtualizedClickTarget(
          frame,
          locator,
          identity,
          preparationDeadline,
        );
        if (rebound.kind !== 'resolved') {
          await handle.dispose().catch(() => undefined);
          this.failVirtualizedClickRebind(page, startedAt, rebound.kind, priorTargetState);
        }
        await handle.dispose().catch(() => undefined);
        handle = rebound.handle;
        preparedLocator = rebound.locator;
        targetState = await boundedValue(
          inspectTargetState(handle),
          Math.max(1, remainingUntil(preparationDeadline)),
          null,
        );
        if (targetState === null) {
          await handle.dispose().catch(() => undefined);
          this.failClickBeforeDispatch(
            page,
            startedAt,
            null,
            'detached',
            'virtualized_target_detached_after_rebind',
            'The uniquely rebound element detached again before Stage5 Browser could click it.',
            'Take one fresh semantic snapshot; Stage5 Browser did not dispatch the click.',
            'TARGET_NOT_FOUND',
          );
        }
      }
    }

    targetState = await boundedValue(
      inspectTargetState(handle),
      Math.max(1, remainingUntil(actionDeadlineAt)),
      null,
    );
    if (targetState === null) {
      await handle.dispose().catch(() => undefined);
      this.failClickBeforeDispatch(
        page,
        startedAt,
        null,
        'detached',
        'target_detached_after_scroll',
        'The observed element detached before Stage5 Browser could safely click it.',
        'Take one fresh semantic snapshot; Stage5 Browser did not dispatch the click.',
        'TARGET_NOT_FOUND',
      );
    }
    const failure = !targetState.visible || !targetState.inViewport
      ? { diagnostic: 'not_visible' as const, reason: 'target_not_actionable_in_viewport' }
      : !targetState.enabled
        ? { diagnostic: 'not_enabled' as const, reason: 'target_not_enabled_after_scroll' }
        : targetState.receivesPointerEvents === false
          ? { diagnostic: 'pointer_intercepted' as const, reason: 'target_covered_after_scroll' }
          : null;
    if (failure !== null) {
      await handle.dispose().catch(() => undefined);
      this.failClickBeforeDispatch(
        page,
        startedAt,
        targetState,
        failure.diagnostic,
        failure.reason,
        'The observed element was not safely actionable after viewport preparation.',
        'Take a fresh snapshot and resolve the reported visibility, enabled-state, or covering element before another click.',
      );
    }
    return {
      locator: preparedLocator,
      handle,
      targetState,
      activation: await this.preferredObservedClickActivation(handle, actionDeadlineAt),
    };
  }

  private async dispatchPreparedObservedClick(
    page: Page,
    preparedTarget: PreparedObservedClickTarget,
    startedAt: string,
    actionDeadlineAt: number,
    finalizationDeadlineAt: number,
    action: SanitizedActionDiagnostic['action'],
  ): Promise<SanitizedClickDispatchEvidence> {
    const targetStateWithinDeadline = (fallback: SafeTargetState | null): Promise<SafeTargetState | null> =>
      boundedValue(
        inspectTargetState(preparedTarget.handle),
        Math.max(1, remainingUntil(finalizationDeadlineAt)),
        fallback,
      );
    const probe = await boundedValue(
      this.installExactClickDispatchProbe(
        page,
        preparedTarget.handle,
        remainingUntil(finalizationDeadlineAt) + CLICK_REF_DISPATCH_PROBE_GRACE_MS,
      ),
      Math.max(1, remainingUntil(actionDeadlineAt)),
      null,
    );
    if (probe === null) {
      this.failClickBeforeDispatch(
        page,
        startedAt,
        await targetStateWithinDeadline(preparedTarget.targetState),
        'unknown',
        'dispatch_probe_install_failed',
        'Stage5 Browser could not install the exact-target dispatch guard before clicking.',
        'Take one fresh semantic snapshot; Stage5 Browser did not dispatch the click.',
        'OPERATION_FAILED',
        action,
      );
    }

    let probeFinished = false;
    let finalEvidence: SanitizedClickDispatchEvidence | null = null;
    let forcedFallbackUsed = false;
    let pageMouseFallbackUsed = false;
    let pageActivation: SanitizedPageActivationEvidence = {
      attemptCount: 0,
      controllerSelected: this.preferredPage() === page,
      bringToFrontAttempted: false,
      bringToFrontSucceeded: false,
      visibilityBefore: 'unknown',
      visibilityAfter: 'unknown',
      documentFocusedBefore: null,
      documentFocusedAfter: null,
      nativeWindow: this.nativeWindowActivationNotRequired(),
    };
    const readProbe = async (finish: boolean): Promise<SanitizedClickDispatchEvidence | null> => {
      if (finish && probeFinished) {
        return finalEvidence;
      }
      try {
        const raw = await boundedValue(
          probe.controller.evaluate((controller, shouldFinish) =>
            shouldFinish ? controller.finish() : controller.snapshot(), finish),
          Math.max(1, remainingUntil(finish ? finalizationDeadlineAt : actionDeadlineAt)),
          null,
        );
        if (raw === null) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const external = this.externalClickDispatchObservations.get(probe.token)?.evidence ?? null;
        const retained = mergeRawClickDispatchEvidence(raw, external);
        if (retained === null) {
          if (finish) {
            probeFinished = true;
            finalEvidence = null;
          }
          return null;
        }
        const evidence: SanitizedClickDispatchEvidence = {
          ...retained,
          forcedFallbackUsed,
          pageMouseFallbackUsed,
          pageActivation,
        };
        if (finish) {
          probeFinished = true;
          finalEvidence = evidence;
        }
        return evidence;
      } catch {
        if (finish) {
          probeFinished = true;
          finalEvidence = null;
        }
        return null;
      } finally {
        if (finish) {
          this.externalClickDispatchObservations.delete(probe.token);
          await probe.controller.dispose().catch(() => undefined);
        }
      }
    };

    try {
      pageActivation = await boundedValue(
        this.activateSelectedPageForInput(
          page,
          pageActivation.attemptCount + 1,
          pageActivation.nativeWindow,
        ),
        Math.max(1, remainingUntil(actionDeadlineAt)),
        {
          ...pageActivation,
          attemptCount: pageActivation.attemptCount + 1,
          bringToFrontAttempted: true,
        },
      );
      if (!this.pageIsActivatedForInput(pageActivation)) {
        const evidence = await readProbe(true);
        return this.throwObservedClickDispatchFailure(
          page,
          new Error('The controller-selected page did not become the visible input target.'),
          await targetStateWithinDeadline(preparedTarget.targetState),
          startedAt,
          evidence,
          action,
        );
      }
      if (remainingUntil(actionDeadlineAt) <= 0) {
        const evidence = await readProbe(true);
        return this.throwObservedClickDispatchFailure(
          page,
          new Error('The click preparation deadline expired before input dispatch.'),
          await targetStateWithinDeadline(preparedTarget.targetState),
          startedAt,
          evidence,
          action,
        );
      }
      const normalAttemptTimeoutMs = Math.max(
        1,
        Math.min(
          CLICK_REF_NORMAL_DISPATCH_TIMEOUT_MS,
          Math.max(1, Math.floor(remainingUntil(actionDeadlineAt) * 0.35)),
        ),
      );
      if (preparedTarget.activation === 'keyboard_enter') {
        let keyboardError: unknown = null;
        let keyboardCompleted = false;
        try {
          await preparedTarget.handle.press('Enter', {
            noWaitAfter: true,
            timeout: normalAttemptTimeoutMs,
          });
          keyboardCompleted = true;
        } catch (error) {
          keyboardError = error;
        }

        const evidence = await readProbe(true);
        if (evidence?.clickOnTarget === true) {
          return evidence;
        }
        const conclusion: ClickDispatchConclusion = {
          actionDispatched: keyboardCompleted ? true : 'unknown',
          clickDispatched: evidence === null ? 'unknown' : false,
        };
        return this.throwObservedClickDispatchFailure(
          page,
          keyboardError ?? new Error('The exact popup activation returned without a confirmed trusted target click event.'),
          await targetStateWithinDeadline(preparedTarget.targetState),
          startedAt,
          evidence,
          action,
          conclusion,
        );
      }

      let normalError: unknown = null;
      try {
        await this.dispatchExactHandleClick(preparedTarget.handle, {
          noWaitAfter: true,
          timeout: normalAttemptTimeoutMs,
        });
      } catch (error) {
        normalError = error;
      }

      let evidence = await readProbe(false);
      if (normalError === null) {
        evidence = await readProbe(true);
        if (evidence?.clickOnTarget === true) return evidence;
        return this.throwObservedClickDispatchFailure(
          page,
          new Error('The exact-target click returned without a confirmed trusted target click event.'),
          await targetStateWithinDeadline(preparedTarget.targetState),
          startedAt,
          evidence,
          action,
        );
      }
      if (evidence?.clickOnTarget === true) {
        const completedEvidence = await readProbe(true);
        if (completedEvidence !== null) return completedEvidence;
        return this.throwObservedClickDispatchFailure(
          page,
          new Error('The target click was observed, but final dispatch evidence could not be retained.'),
          await targetStateWithinDeadline(preparedTarget.targetState),
          startedAt,
          null,
          action,
        );
      }

      const targetState = await targetStateWithinDeadline(null);
      if (!this.canUseForcedClickFallback(evidence, targetState, normalError)) {
        evidence = await readProbe(true);
        return this.throwObservedClickDispatchFailure(
          page,
          normalError,
          targetState ?? preparedTarget.targetState,
          startedAt,
          evidence,
          action,
        );
      }
      if (remainingUntil(actionDeadlineAt) <= 0) {
        evidence = await readProbe(true);
        return this.throwObservedClickDispatchFailure(
          page,
          normalError,
          targetState ?? preparedTarget.targetState,
          startedAt,
          evidence,
          action,
        );
      }

      pageActivation = await boundedValue(
        this.activateSelectedPageForInput(
          page,
          pageActivation.attemptCount + 1,
          pageActivation.nativeWindow,
        ),
        Math.max(1, remainingUntil(actionDeadlineAt)),
        {
          ...pageActivation,
          attemptCount: pageActivation.attemptCount + 1,
          bringToFrontAttempted: true,
        },
      );
      if (!this.pageIsActivatedForInput(pageActivation)) {
        evidence = await readProbe(true);
        return this.throwObservedClickDispatchFailure(
          page,
          new Error('The controller-selected page lost visible activation before guarded fallback input.'),
          await targetStateWithinDeadline(targetState ?? preparedTarget.targetState),
          startedAt,
          evidence,
          action,
        );
      }
      forcedFallbackUsed = true;
      const remainingTimeoutMs = Math.max(
        1,
        Math.min(
          CLICK_REF_FORCED_DISPATCH_TIMEOUT_MS,
          remainingUntil(actionDeadlineAt),
        ),
      );
      let forcedError: unknown = null;
      try {
        await this.dispatchExactHandleClick(preparedTarget.handle, {
          force: true,
          noWaitAfter: true,
          timeout: remainingTimeoutMs,
        });
      } catch (error) {
        forcedError = error;
      }

      evidence = await readProbe(false);
      if (evidence?.clickOnTarget === true) {
        const completedEvidence = await readProbe(true);
        if (completedEvidence !== null) return completedEvidence;
        return this.throwObservedClickDispatchFailure(
          page,
          new Error('The guarded fallback click was observed, but final dispatch evidence could not be retained.'),
          await targetStateWithinDeadline(preparedTarget.targetState),
          startedAt,
          null,
          action,
        );
      }
      if (forcedError === null && evidence === null) {
        const completedEvidence = await readProbe(true);
        return this.throwObservedClickDispatchFailure(
          page,
          new Error('The guarded fallback returned without definite dispatch evidence.'),
          await targetStateWithinDeadline(preparedTarget.targetState),
          startedAt,
          completedEvidence,
          action,
        );
      }

      const directTargetState = await targetStateWithinDeadline(null);
      if (!this.canUsePageMouseFallback(evidence, directTargetState)) {
        evidence = await readProbe(true);
        return this.throwObservedClickDispatchFailure(
          page,
          forcedError ?? new Error('The guarded exact-handle fallback did not emit a target click event.'),
          directTargetState ?? targetState ?? preparedTarget.targetState,
          startedAt,
          evidence,
          action,
        );
      }
      if (remainingUntil(actionDeadlineAt) <= 0) {
        evidence = await readProbe(true);
        return this.throwObservedClickDispatchFailure(
          page,
          forcedError ?? new Error('The guarded fallback deadline expired before page-level input.'),
          directTargetState ?? targetState ?? preparedTarget.targetState,
          startedAt,
          evidence,
          action,
        );
      }

      pageActivation = await boundedValue(
        this.activateSelectedPageForInput(
          page,
          pageActivation.attemptCount + 1,
          pageActivation.nativeWindow,
        ),
        Math.max(1, remainingUntil(actionDeadlineAt)),
        {
          ...pageActivation,
          attemptCount: pageActivation.attemptCount + 1,
          bringToFrontAttempted: true,
        },
      );
      const point = this.pageIsActivatedForInput(pageActivation)
        ? await boundedValue(
          this.freshMainFrameTargetPoint(page, preparedTarget.handle),
          Math.max(1, remainingUntil(actionDeadlineAt)),
          null,
        )
        : null;
      if (point === null) {
        evidence = await readProbe(true);
        return this.throwObservedClickDispatchFailure(
          page,
          new Error('The controller-selected page or exact main-frame target was not ready for guarded page input.'),
          await targetStateWithinDeadline(directTargetState ?? preparedTarget.targetState),
          startedAt,
          evidence,
          action,
        );
      }

      pageMouseFallbackUsed = true;
      let pageMouseError: unknown = null;
      try {
        const completed = await boundedValue(
          page.mouse.click(point.x, point.y, {
            button: 'left',
            clickCount: 1,
            delay: 0,
          }).then(() => true),
          Math.max(1, remainingUntil(actionDeadlineAt)),
          false,
        );
        if (!completed) {
          pageMouseError = new Error('Page-level input exceeded the action deadline.');
        }
      } catch (error) {
        pageMouseError = error;
      }

      evidence = await readProbe(true);
      if (evidence?.clickOnTarget === true) {
        return evidence;
      }
      if (pageMouseError === null && evidence === null) {
        return this.throwObservedClickDispatchFailure(
          page,
          new Error('Page-level input returned without definite dispatch evidence.'),
          await targetStateWithinDeadline(preparedTarget.targetState),
          startedAt,
          null,
          action,
        );
      }
      return this.throwObservedClickDispatchFailure(
        page,
        pageMouseError ?? new Error('The guarded page-level fallback did not emit a target click event.'),
        await targetStateWithinDeadline(directTargetState ?? targetState ?? preparedTarget.targetState),
        startedAt,
        evidence,
        action,
      );
    } finally {
      if (!probeFinished) {
        await readProbe(true);
      }
    }
  }

  private async dispatchExactHandleClick(
    handle: ElementHandle<HTMLElement | SVGElement>,
    options: { force?: boolean; noWaitAfter: boolean; timeout: number },
  ): Promise<void> {
    await handle.click(options);
  }

  private async activateSelectedPageForInput(
    page: Page,
    attemptCount: number,
    priorNativeWindow?: SanitizedNativeWindowActivationEvidence,
  ): Promise<SanitizedPageActivationEvidence> {
    const before = await this.observePageActivation(page);
    const controllerSelected = this.preferredPage() === page;
    let bringToFrontSucceeded = false;
    try {
      await page.bringToFront();
      bringToFrontSucceeded = true;
    } catch {
      bringToFrontSucceeded = false;
    }
    let after = await this.observePageActivation(page);
    let nativeWindow = priorNativeWindow?.attempted === true
      ? priorNativeWindow
      : this.nativeWindowActivationNotRequired();
    if (
      controllerSelected &&
      bringToFrontSucceeded &&
      after.visibility !== 'visible'
    ) {
      nativeWindow = await this.activateOwnedNativeWindow(page);
      const applicationReadyForRendererSelection =
        nativeWindow.applicationHiddenAfter === false &&
        (nativeWindow.activationRequestAccepted === true ||
          nativeWindow.applicationFrontmostAfter === true);
      if (applicationReadyForRendererSelection) {
        try {
          await page.bringToFront();
        } catch {
          bringToFrontSucceeded = false;
        }
      }
      after = await this.waitForVisiblePageActivation(page, after);
      if (after.visibility === 'visible') {
        nativeWindow = { ...nativeWindow, result: 'activated' };
      } else if (nativeWindow.result === 'activated' || applicationReadyForRendererSelection) {
        nativeWindow = { ...nativeWindow, result: 'visibility_unchanged' };
      }
    }
    return {
      attemptCount,
      controllerSelected,
      bringToFrontAttempted: true,
      bringToFrontSucceeded,
      visibilityBefore: before.visibility,
      visibilityAfter: after.visibility,
      documentFocusedBefore: before.documentFocused,
      documentFocusedAfter: after.documentFocused,
      nativeWindow,
    };
  }

  private nativeWindowActivationNotRequired(): SanitizedNativeWindowActivationEvidence {
    const supported = !this.config.headless &&
      this.controlledLaunchIdentity?.engine === 'chromium' &&
      this.nativeWindowActivator.supported;
    return {
      required: false,
      attempted: false,
      supported,
      ownedProcessAvailable: this.controlledBrowserProcessId !== null,
      ownedProcessRunning: null,
      targetWindowResolved: null,
      windowStateBefore: 'unknown',
      normalizationAttempted: false,
      normalizationSucceeded: null,
      applicationActivationAttempted: false,
      applicationActivationSucceeded: null,
      applicationHiddenBefore: null,
      unhideAttempted: false,
      unhideSucceeded: null,
      activationRequestAccepted: null,
      frontProcessFallbackAttempted: false,
      frontProcessFallbackProcessResolved: null,
      frontProcessFallbackRequestSucceeded: null,
      applicationFrontmostAfter: null,
      applicationHiddenAfter: null,
      result: 'not_required',
    };
  }

  private async activateOwnedNativeWindow(
    page: Page,
  ): Promise<SanitizedNativeWindowActivationEvidence> {
    const supported = !this.config.headless &&
      this.controlledLaunchIdentity?.engine === 'chromium' &&
      this.nativeWindowActivator.supported;
    const base: SanitizedNativeWindowActivationEvidence = {
      required: true,
      attempted: true,
      supported,
      ownedProcessAvailable: this.controlledBrowserProcessId !== null,
      ownedProcessRunning: null,
      targetWindowResolved: null,
      windowStateBefore: 'unknown',
      normalizationAttempted: false,
      normalizationSucceeded: null,
      applicationActivationAttempted: false,
      applicationActivationSucceeded: null,
      applicationHiddenBefore: null,
      unhideAttempted: false,
      unhideSucceeded: null,
      activationRequestAccepted: null,
      frontProcessFallbackAttempted: false,
      frontProcessFallbackProcessResolved: null,
      frontProcessFallbackRequestSucceeded: null,
      applicationFrontmostAfter: null,
      applicationHiddenAfter: null,
      result: 'native_activation_unsupported',
    };
    if (this.config.headless) {
      return { ...base, result: 'headless_not_applicable' };
    }
    if (this.controlledLaunchIdentity?.engine !== 'chromium') {
      return base;
    }
    const processId = this.controlledBrowserProcessId;
    if (processId === null) {
      return { ...base, result: 'owned_process_unavailable' };
    }

    const prepared = await this.prepareChromiumTargetWindow(page);
    const withWindow: SanitizedNativeWindowActivationEvidence = {
      ...base,
      targetWindowResolved: prepared.targetWindowResolved,
      windowStateBefore: prepared.windowStateBefore,
      normalizationAttempted: prepared.normalizationAttempted,
      normalizationSucceeded: prepared.normalizationSucceeded,
    };
    if (!prepared.targetWindowResolved) {
      return { ...withWindow, result: 'target_window_unavailable' };
    }
    if (prepared.normalizationAttempted && prepared.normalizationSucceeded !== true) {
      return { ...withWindow, result: 'window_normalization_failed' };
    }

    const activated = await this.nativeWindowActivator.activateOwnedProcess(
      processId,
      NATIVE_WINDOW_ACTIVATION_TIMEOUT_MS,
    );
    return {
      ...withWindow,
      supported: activated.supported,
      ownedProcessRunning: activated.ownedProcessRunning,
      applicationActivationAttempted: activated.attempted,
      applicationActivationSucceeded: activated.applicationActivated,
      applicationHiddenBefore: activated.applicationHiddenBefore,
      unhideAttempted: activated.unhideAttempted,
      unhideSucceeded: activated.unhideSucceeded,
      activationRequestAccepted: activated.activationRequestAccepted,
      frontProcessFallbackAttempted: activated.frontProcessFallbackAttempted,
      frontProcessFallbackProcessResolved: activated.frontProcessFallbackProcessResolved,
      frontProcessFallbackRequestSucceeded: activated.frontProcessFallbackRequestSucceeded,
      applicationFrontmostAfter: activated.applicationFrontmostAfter,
      applicationHiddenAfter: activated.applicationHiddenAfter,
      result: activated.applicationActivated
        ? 'activated'
        : activated.reason === 'owned_process_not_running'
          ? 'owned_process_not_running'
          : activated.reason === 'platform_unsupported'
            ? 'native_activation_unsupported'
            : activated.reason === 'activation_state_unverified'
              ? 'application_activation_unverified'
              : 'application_activation_failed',
    };
  }

  private async prepareChromiumTargetWindow(
    page: Page,
  ): Promise<ChromiumTargetWindowPreparation> {
    const unavailable: ChromiumTargetWindowPreparation = {
      targetWindowResolved: false,
      windowStateBefore: 'unknown',
      normalizationAttempted: false,
      normalizationSucceeded: null,
    };
    let session: Awaited<ReturnType<BrowserContext['newCDPSession']>> | null = null;
    try {
      session = await page.context().newCDPSession(page);
      const observed = await session.send('Browser.getWindowForTarget') as {
        windowId?: unknown;
        bounds?: { windowState?: unknown };
      };
      if (
        typeof observed.windowId !== 'number' ||
        !Number.isSafeInteger(observed.windowId) ||
        observed.windowId < 0
      ) {
        return unavailable;
      }
      const observedState = observed.bounds?.windowState;
      const windowStateBefore = observedState === 'fullscreen' ||
        observedState === 'maximized' ||
        observedState === 'minimized' ||
        observedState === 'normal'
        ? observedState
        : 'unknown';
      if (windowStateBefore !== 'minimized') {
        return {
          targetWindowResolved: true,
          windowStateBefore,
          normalizationAttempted: false,
          normalizationSucceeded: null,
        };
      }
      try {
        await session.send('Browser.setWindowBounds', {
          windowId: observed.windowId,
          bounds: { windowState: 'normal' },
        });
        let normalizationSucceeded = false;
        const deadline = Date.now() + NATIVE_WINDOW_NORMALIZATION_WAIT_MS;
        while (!normalizationSucceeded && Date.now() < deadline) {
          const normalized = await session.send('Browser.getWindowForTarget') as {
            bounds?: { windowState?: unknown };
          };
          normalizationSucceeded = normalized.bounds?.windowState !== 'minimized';
          if (!normalizationSucceeded) {
            await new Promise((resolve) => setTimeout(
              resolve,
              Math.min(NATIVE_WINDOW_VISIBILITY_POLL_MS, Math.max(1, deadline - Date.now())),
            ));
          }
        }
        return {
          targetWindowResolved: true,
          windowStateBefore,
          normalizationAttempted: true,
          normalizationSucceeded,
        };
      } catch {
        return {
          targetWindowResolved: true,
          windowStateBefore,
          normalizationAttempted: true,
          normalizationSucceeded: false,
        };
      }
    } catch {
      return unavailable;
    } finally {
      await session?.detach().catch(() => undefined);
    }
  }

  private async waitForVisiblePageActivation(
    page: Page,
    initial: PageActivationObservation,
  ): Promise<PageActivationObservation> {
    let observed = initial;
    const deadline = Date.now() + NATIVE_WINDOW_VISIBILITY_WAIT_MS;
    while (observed.visibility !== 'visible' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(NATIVE_WINDOW_VISIBILITY_POLL_MS, Math.max(1, deadline - Date.now())),
      ));
      observed = await this.observePageActivation(page);
    }
    return observed;
  }

  private async observePageActivation(page: Page): Promise<PageActivationObservation> {
    const observed = await boundedValue<PageActivationObservation>(
      page.evaluate(() => ({
        documentFocused: document.hasFocus(),
        visibility: document.visibilityState,
      }) as PageActivationObservation),
      300,
      { documentFocused: null, visibility: 'unknown' },
    );
    const visibility = observed.visibility === 'hidden' ||
      observed.visibility === 'visible' ||
      observed.visibility === 'prerender'
      ? observed.visibility
      : 'unknown';
    return {
      documentFocused: typeof observed.documentFocused === 'boolean' ? observed.documentFocused : null,
      visibility,
    };
  }

  private pageIsActivatedForInput(evidence: SanitizedPageActivationEvidence): boolean {
    return evidence.controllerSelected &&
      evidence.bringToFrontSucceeded &&
      evidence.visibilityAfter === 'visible';
  }

  private async freshMainFrameTargetPoint(
    page: Page,
    handle: ElementHandle<HTMLElement | SVGElement>,
  ): Promise<{ x: number; y: number } | null> {
    try {
      if (await handle.ownerFrame() !== page.mainFrame()) {
        return null;
      }
      return await handle.evaluate((element) => {
        if (!element.isConnected) return null;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none'
          && style.visibility !== 'hidden' && style.opacity !== '0';
        const enabled = !('disabled' in element && Boolean((element as HTMLButtonElement).disabled))
          && element.getAttribute('aria-disabled') !== 'true';
        if (!visible || !enabled || rect.bottom <= 0 || rect.right <= 0 ||
          rect.top >= window.innerHeight || rect.left >= window.innerWidth) {
          return null;
        }
        const left = Math.max(0, rect.left);
        const right = Math.min(window.innerWidth - 1, rect.right);
        const top = Math.max(0, rect.top);
        const bottom = Math.min(window.innerHeight - 1, rect.bottom);
        if (right <= left || bottom <= top) return null;
        const x = left + (right - left) / 2;
        const y = top + (bottom - top) / 2;
        const hit = document.elementFromPoint(x, y);
        if (hit === null || (hit !== element && !element.contains(hit))) return null;
        return { x, y };
      });
    } catch {
      return null;
    }
  }

  private async installExactClickDispatchProbe(
    page: Page,
    handle: ElementHandle<HTMLElement | SVGElement>,
    lifetimeMs: number,
  ): Promise<InstalledClickDispatchProbe | null> {
    const token = randomUUID();
    try {
      if (!this.clickDispatchBindings.has(page)) {
        await page.exposeBinding(
          this.clickDispatchBindingName,
          (source, observedToken: unknown, observedEvidence: unknown) => {
            if (typeof observedToken !== 'string') return;
            const retained = this.externalClickDispatchObservations.get(observedToken);
            if (retained === undefined || source.page !== retained.page) return;
            const evidence = safeRawClickDispatchEvidence(observedEvidence);
            if (evidence !== null) retained.evidence = evidence;
          },
        );
        this.clickDispatchBindings.add(page);
      }
      this.externalClickDispatchObservations.set(token, { page, evidence: null });
      const controller = await handle.evaluateHandle((element, input) => {
        const { bindingName, boundedLifetimeMs, observationToken } = input;
        const initialRect = element.getBoundingClientRect();
        const state: RawClickDispatchEvidence = {
          strategy: 'guarded_exact_handle',
          guardExpired: false,
          targetConnectedBefore: element.isConnected,
          targetConnectedAtFirstEvent: null,
          targetConnectedAfter: element.isConnected,
          geometryChangedBeforeFirstEvent: null,
          trustedEventObserved: false,
          pointerDownOnTarget: false,
          mouseDownOnTarget: false,
          pointerUpOnTarget: false,
          mouseUpOnTarget: false,
          clickOnTarget: false,
          misdirectedEventBlocked: false,
          targetStateChangeBlocked: false,
        };
        const eventTypes = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'] as const;
        let cleaned = false;
        let expirationTimer: number | null = null;

        const targetIsActionable = (): boolean => {
          if (!element.isConnected) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none'
            && style.visibility !== 'hidden' && style.opacity !== '0';
          const enabled = !('disabled' in element && Boolean((element as HTMLButtonElement).disabled))
            && element.getAttribute('aria-disabled') !== 'true';
          return visible && enabled && rect.bottom > 0 && rect.right > 0
            && rect.top < window.innerHeight && rect.left < window.innerWidth;
        };
        const block = (event: Event): void => {
          event.preventDefault();
          event.stopImmediatePropagation();
          event.stopPropagation();
        };
        const recordExactEvent = (eventType: typeof eventTypes[number]): void => {
          if (eventType === 'pointerdown') state.pointerDownOnTarget = true;
          if (eventType === 'mousedown') state.mouseDownOnTarget = true;
          if (eventType === 'pointerup') state.pointerUpOnTarget = true;
          if (eventType === 'mouseup') state.mouseUpOnTarget = true;
          if (eventType === 'click') state.clickOnTarget = true;
        };
        const snapshot = (): RawClickDispatchEvidence => ({
          ...state,
          targetConnectedAfter: element.isConnected,
        });
        const report = (): void => {
          const binding = (globalThis as unknown as Record<string, unknown>)[bindingName];
          if (typeof binding !== 'function') return;
          void (binding as (token: string, evidence: RawClickDispatchEvidence) => Promise<unknown>)(
            observationToken,
            snapshot(),
          ).catch(() => undefined);
        };
        const listener = (event: Event): void => {
          if (!event.isTrusted) return;
          const eventType = event.type as typeof eventTypes[number];
          state.trustedEventObserved = true;
          if (state.targetConnectedAtFirstEvent === null) {
            state.targetConnectedAtFirstEvent = element.isConnected;
            const currentRect = element.getBoundingClientRect();
            state.geometryChangedBeforeFirstEvent =
              Math.abs(currentRect.top - initialRect.top) > 1 ||
              Math.abs(currentRect.left - initialRect.left) > 1 ||
              Math.abs(currentRect.width - initialRect.width) > 1 ||
              Math.abs(currentRect.height - initialRect.height) > 1;
          }
          const exactTarget = event.composedPath().includes(element);
          if (!exactTarget) {
            state.misdirectedEventBlocked = true;
            block(event);
            report();
            return;
          }
          if (!targetIsActionable()) {
            state.targetStateChangeBlocked = true;
            block(event);
            report();
            return;
          }
          recordExactEvent(eventType);
          if (eventType === 'click') {
            cleanup();
          }
          report();
        };
        const cleanup = (): void => {
          if (cleaned) return;
          cleaned = true;
          if (expirationTimer !== null) window.clearTimeout(expirationTimer);
          eventTypes.forEach((eventType) => window.removeEventListener(eventType, listener, true));
        };
        eventTypes.forEach((eventType) => window.addEventListener(eventType, listener, true));
        expirationTimer = window.setTimeout(() => {
          state.guardExpired = true;
          cleanup();
          report();
        }, Math.max(1, boundedLifetimeMs));
        return {
          snapshot,
          finish: (): RawClickDispatchEvidence => {
            cleanup();
            return snapshot();
          },
        };
      }, {
        bindingName: this.clickDispatchBindingName,
        boundedLifetimeMs: lifetimeMs,
        observationToken: token,
      });
      return { controller, token };
    } catch {
      this.externalClickDispatchObservations.delete(token);
      return null;
    }
  }

  private canUseForcedClickFallback(
    evidence: SanitizedClickDispatchEvidence | null,
    targetState: SafeTargetState | null,
    normalError: unknown,
  ): boolean {
    const errorDescriptor = normalError instanceof Error
      ? `${normalError.name} ${normalError.message}`.toLocaleLowerCase()
      : '';
    const stabilityAttemptTimedOut = errorDescriptor.includes('timeout') || errorDescriptor.includes('timed out');
    return stabilityAttemptTimedOut &&
      evidence !== null &&
      !evidence.guardExpired &&
      !evidence.trustedEventObserved &&
      !evidence.pointerDownOnTarget &&
      !evidence.mouseDownOnTarget &&
      !evidence.pointerUpOnTarget &&
      !evidence.mouseUpOnTarget &&
      !evidence.clickOnTarget &&
      !evidence.misdirectedEventBlocked &&
      !evidence.targetStateChangeBlocked &&
      targetState !== null &&
      targetState.visible &&
      targetState.enabled &&
      targetState.inViewport &&
      targetState.receivesPointerEvents === true;
  }

  private canUsePageMouseFallback(
    evidence: SanitizedClickDispatchEvidence | null,
    targetState: SafeTargetState | null,
  ): boolean {
    return evidence !== null &&
      !evidence.guardExpired &&
      !evidence.trustedEventObserved &&
      !evidence.pointerDownOnTarget &&
      !evidence.mouseDownOnTarget &&
      !evidence.pointerUpOnTarget &&
      !evidence.mouseUpOnTarget &&
      !evidence.clickOnTarget &&
      !evidence.misdirectedEventBlocked &&
      !evidence.targetStateChangeBlocked &&
      targetState !== null &&
      targetState.visible &&
      targetState.enabled &&
      targetState.inViewport &&
      targetState.receivesPointerEvents === true;
  }

  private throwObservedClickDispatchFailure(
    page: Page,
    error: unknown,
    targetState: SafeTargetState | null,
    startedAt: string,
    evidence: SanitizedClickDispatchEvidence | null,
    action: SanitizedActionDiagnostic['action'],
    conclusion: ClickDispatchConclusion | null = null,
  ): never {
    const diagnostic = this.observedClickDispatchFailureDiagnostic(
      page,
      error,
      targetState,
      startedAt,
      evidence,
      action,
      conclusion,
    );
    this.pageDiagnostics.recordAction(page, diagnostic);
    throw this.clickFailureError(diagnostic, error);
  }

  private observedClickDispatchFailureDiagnostic(
    page: Page,
    error: unknown,
    targetState: SafeTargetState | null,
    startedAt: string,
    evidence: SanitizedClickDispatchEvidence | null,
    action: SanitizedActionDiagnostic['action'],
    conclusion: ClickDispatchConclusion | null = null,
  ): SanitizedActionDiagnostic {
    const fallback = actionDiagnosticForFailure(
      action,
      page,
      error,
      targetState,
      startedAt,
    );
    if (evidence === null) {
      if (conclusion === null) return fallback;
      return {
        ...fallback,
        outcome: conclusion.actionDispatched === false ? 'blocked' : 'failed',
        actionDispatched: conclusion.actionDispatched,
        clickDispatched: conclusion.clickDispatched,
      };
    }
    const exactTargetActivity = evidence.pointerDownOnTarget ||
      evidence.mouseDownOnTarget ||
      evidence.pointerUpOnTarget ||
      evidence.mouseUpOnTarget ||
      evidence.clickOnTarget;
    const dispatchUnknown = evidence.guardExpired && !evidence.trustedEventObserved;
    const actionDispatched = conclusion?.actionDispatched
      ?? (dispatchUnknown ? 'unknown' : exactTargetActivity);
    const clickDispatched = conclusion?.clickDispatched
      ?? (dispatchUnknown ? 'unknown' : evidence.clickOnTarget);
    const reason = !this.pageIsActivatedForInput(evidence.pageActivation)
      ? 'page_not_active'
      : !evidence.targetConnectedAfter || (evidence.targetStateChangeBlocked && targetState === null)
        ? 'detached'
        : evidence.misdirectedEventBlocked
          ? 'pointer_intercepted'
          : fallback.reason;
    return {
      ...fallback,
      outcome: actionDispatched === false ? 'blocked' : 'failed',
      reason,
      actionDispatched,
      clickDispatched,
      dispatchEvidence: evidence,
    };
  }

  private async observeClickTargetIdentity(
    handle: ElementHandle<HTMLElement | SVGElement>,
  ): Promise<ClickTargetSemanticIdentity | null> {
    try {
      const observed = await handle.evaluate((element, articleTextCharacters) => {
        if (!element.isConnected) {
          throw new Error('Target element is detached.');
        }
        const normalize = (value: string | null | undefined): string =>
          (value ?? '').replaceAll(/\s+/g, ' ').trim();
        const semanticRole = (candidate: Element): string | null => {
          const explicit = normalize(candidate.getAttribute('role')).split(' ')[0] ?? '';
          if (explicit !== '') {
            return explicit.toLocaleLowerCase();
          }
          const tagName = candidate.tagName.toLocaleLowerCase();
          if (tagName === 'button') return 'button';
          if (tagName === 'a' && candidate.hasAttribute('href')) return 'link';
          if (tagName === 'article') return 'article';
          if (tagName === 'img') return 'img';
          if (tagName === 'textarea') return 'textbox';
          if (tagName === 'select') return 'combobox';
          if (tagName === 'input') {
            const type = (candidate.getAttribute('type') ?? 'text').toLocaleLowerCase();
            if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
            if (type === 'checkbox') return 'checkbox';
            if (type === 'radio') return 'radio';
            if (type !== 'hidden') return 'textbox';
          }
          return null;
        };
        const renderedText = (candidate: Element): string =>
          candidate instanceof HTMLElement
            ? normalize(candidate.innerText || candidate.textContent)
            : normalize(candidate.textContent);
        const semanticName = (candidate: Element): string => {
          const ariaLabel = normalize(candidate.getAttribute('aria-label'));
          if (ariaLabel !== '') return ariaLabel.slice(0, 500);
          const labelledBy = normalize(candidate.getAttribute('aria-labelledby'));
          if (labelledBy !== '') {
            const labels = labelledBy.split(' ')
              .map((id) => document.getElementById(id))
              .filter((label): label is HTMLElement => label !== null)
              .map((label) => normalize(label.innerText || label.textContent))
              .filter((label) => label !== '')
              .join(' ');
            if (labels !== '') return labels.slice(0, 500);
          }
          const alt = normalize(candidate.getAttribute('alt'));
          if (alt !== '') return alt.slice(0, 500);
          const rendered = renderedText(candidate);
          if (rendered !== '') return rendered.slice(0, 500);
          const value = normalize(candidate.getAttribute('value'));
          if (value !== '') return value.slice(0, 500);
          const placeholder = normalize(candidate.getAttribute('placeholder'));
          if (placeholder !== '') return placeholder.slice(0, 500);
          return normalize(candidate.getAttribute('title')).slice(0, 500);
        };
        const article = element.closest('article, [role="article"]');
        let nestingDepth = 0;
        for (let ancestor: Element | null = article; ancestor !== null; ancestor = ancestor.parentElement) {
          if (ancestor.matches('article, [role="article"]')) {
            nestingDepth += 1;
          }
        }
        return {
          tagName: element.tagName.toLocaleLowerCase(),
          role: semanticRole(element),
          name: semanticName(element),
          article: article === null
            ? null
            : {
                text: renderedText(article).slice(0, articleTextCharacters),
                tagName: article.tagName.toLocaleLowerCase(),
                role: semanticRole(article),
                nestingDepth,
              },
        };
      }, CLICK_REF_ARTICLE_TEXT_CHARACTERS);
      return {
        tagName: observed.tagName,
        role: observed.role,
        name: observed.name,
        article: observed.article === null
          ? null
          : {
              fingerprint: privacyFingerprint(observed.article.text),
              tagName: observed.article.tagName,
              role: observed.article.role,
              nestingDepth: observed.article.nestingDepth,
            },
      };
    } catch {
      return null;
    }
  }

  private async incrementalScrollTowardClickTarget(
    handle: ElementHandle<HTMLElement | SVGElement>,
  ): Promise<{ moved: boolean; targetInViewport: boolean } | null> {
    try {
      return await handle.evaluate((element) => {
        const viewportIntersects = (rect: DOMRect): boolean =>
          rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
        const targetRect = element.getBoundingClientRect();
        if (viewportIntersects(targetRect)) {
          return { moved: false, targetInViewport: true };
        }
        const targetDirection = targetRect.bottom <= 0 ? -1 : targetRect.top >= window.innerHeight ? 1 : 0;
        if (targetDirection === 0) {
          return { moved: false, targetInViewport: false };
        }
        const moveSurface = (
          surface: HTMLElement,
          direction: number,
          distance: number,
          visibleHeight: number,
        ): boolean => {
          const before = surface.scrollTop;
          const maximum = Math.max(0, surface.scrollHeight - surface.clientHeight);
          const available = direction > 0 ? maximum - before : before;
          if (available <= 1) return false;
          const step = Math.min(
            available,
            Math.max(64, Math.min(distance, Math.max(64, Math.floor(visibleHeight * 0.72)))),
          );
          const priorBehavior = surface.style.scrollBehavior;
          surface.style.scrollBehavior = 'auto';
          surface.scrollTop = before + direction * step;
          surface.style.scrollBehavior = priorBehavior;
          return Math.abs(surface.scrollTop - before) > 1;
        };

        for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
          if (ancestor === document.body || ancestor === document.documentElement) continue;
          const style = getComputedStyle(ancestor);
          if (!/(auto|scroll|overlay)/u.test(style.overflowY)) continue;
          if (ancestor.scrollHeight <= ancestor.clientHeight + 1) continue;
          const surfaceRect = ancestor.getBoundingClientRect();
          if (!viewportIntersects(surfaceRect)) continue;
          const clipTop = Math.max(0, surfaceRect.top);
          const clipBottom = Math.min(window.innerHeight, surfaceRect.bottom);
          const direction = targetRect.bottom <= clipTop ? -1 : targetRect.top >= clipBottom ? 1 : 0;
          if (direction === 0) continue;
          const distance = direction > 0
            ? Math.max(64, targetRect.top - clipBottom)
            : Math.max(64, clipTop - targetRect.bottom);
          if (moveSurface(ancestor, direction, distance, Math.max(1, clipBottom - clipTop))) {
            const after = element.getBoundingClientRect();
            return { moved: true, targetInViewport: viewportIntersects(after) };
          }
        }

        const scrollingElement = document.scrollingElement;
        if (!(scrollingElement instanceof HTMLElement)) {
          return { moved: false, targetInViewport: false };
        }
        const distance = targetDirection > 0
          ? Math.max(64, targetRect.top - window.innerHeight)
          : Math.max(64, -targetRect.bottom);
        const moved = moveSurface(
          scrollingElement,
          targetDirection,
          distance,
          Math.max(1, window.innerHeight),
        );
        const after = element.getBoundingClientRect();
        return { moved, targetInViewport: viewportIntersects(after) };
      });
    } catch {
      return null;
    }
  }

  private async waitForVirtualizedClickTarget(
    frame: Frame,
    originalLocator: Locator,
    identity: ClickTargetSemanticIdentity | null,
    preparationDeadline: number,
  ): Promise<VirtualizedClickResolution> {
    const deadline = Math.min(
      preparationDeadline,
      Date.now() + CLICK_REF_REBIND_SETTLE_MS,
    );
    let result: VirtualizedClickResolution = { kind: 'missing' };
    do {
      result = await this.resolveVirtualizedClickTarget(frame, originalLocator, identity);
      if (result.kind !== 'missing' || Date.now() >= deadline) {
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
    } while (Date.now() < deadline);
    return result;
  }

  private async resolveVirtualizedClickTarget(
    frame: Frame,
    originalLocator: Locator,
    identity: ClickTargetSemanticIdentity | null,
  ): Promise<VirtualizedClickResolution> {
    try {
      const originalCount = await originalLocator.count();
      if (originalCount > 1) {
        return { kind: 'ambiguous' };
      }
      if (originalCount === 1) {
        const originalHandle = await originalLocator.elementHandle();
        if (originalHandle !== null) {
          const observed = await this.observeClickTargetIdentity(originalHandle);
          if (identity !== null && observed !== null && this.sameClickTargetIdentity(identity, observed)) {
            return { kind: 'resolved', locator: originalLocator, handle: originalHandle };
          }
          await originalHandle.dispose().catch(() => undefined);
        }
      }
      if (identity?.article === null || identity?.article === undefined || identity.name === '') {
        return { kind: 'missing' };
      }
      const articleIdentity = identity.article;

      const articles = frame.locator('article, [role="article"]');
      const articleCount = await articles.count();
      if (articleCount > CLICK_REF_ARTICLE_CANDIDATES) {
        return { kind: 'ambiguous' };
      }
      const articleCandidates = await articles.evaluateAll((candidates, articleTextCharacters) =>
        candidates.map((article) => {
          const normalize = (value: string | null | undefined): string =>
            (value ?? '').replaceAll(/\s+/g, ' ').trim();
          const explicitRole = normalize(article.getAttribute('role')).split(' ')[0] ?? '';
          let nestingDepth = 0;
          for (let ancestor: Element | null = article; ancestor !== null; ancestor = ancestor.parentElement) {
            if (ancestor.matches('article, [role="article"]')) nestingDepth += 1;
          }
          return {
            text: (article instanceof HTMLElement
              ? normalize(article.innerText || article.textContent)
              : normalize(article.textContent)).slice(0, articleTextCharacters),
            tagName: article.tagName.toLocaleLowerCase(),
            role: explicitRole === ''
              ? article.tagName.toLocaleLowerCase() === 'article' ? 'article' : null
              : explicitRole.toLocaleLowerCase(),
            nestingDepth,
          };
        }), CLICK_REF_ARTICLE_TEXT_CHARACTERS);
      const matchingArticleIndexes: number[] = [];
      articleCandidates.forEach((candidate, index) => {
        if (
          privacyFingerprint(candidate.text) === articleIdentity.fingerprint &&
          candidate.tagName === articleIdentity.tagName &&
          candidate.role === articleIdentity.role &&
          candidate.nestingDepth === articleIdentity.nestingDepth
        ) {
          matchingArticleIndexes.push(index);
        }
      });
      if (matchingArticleIndexes.length > 1) {
        return { kind: 'ambiguous' };
      }
      const articleIndex = matchingArticleIndexes[0];
      if (articleIndex === undefined) {
        return { kind: 'missing' };
      }
      const article = articles.nth(articleIndex);
      const match = await article.evaluate((articleElement, expected) => {
        const normalize = (value: string | null | undefined): string =>
          (value ?? '').replaceAll(/\s+/g, ' ').trim();
        const semanticRole = (candidate: Element): string | null => {
          const explicit = normalize(candidate.getAttribute('role')).split(' ')[0] ?? '';
          if (explicit !== '') return explicit.toLocaleLowerCase();
          const tagName = candidate.tagName.toLocaleLowerCase();
          if (tagName === 'button') return 'button';
          if (tagName === 'a' && candidate.hasAttribute('href')) return 'link';
          if (tagName === 'article') return 'article';
          if (tagName === 'img') return 'img';
          if (tagName === 'textarea') return 'textbox';
          if (tagName === 'select') return 'combobox';
          if (tagName === 'input') {
            const type = (candidate.getAttribute('type') ?? 'text').toLocaleLowerCase();
            if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
            if (type === 'checkbox') return 'checkbox';
            if (type === 'radio') return 'radio';
            if (type !== 'hidden') return 'textbox';
          }
          return null;
        };
        const renderedText = (candidate: Element): string =>
          candidate instanceof HTMLElement
            ? normalize(candidate.innerText || candidate.textContent)
            : normalize(candidate.textContent);
        const semanticName = (candidate: Element): string => {
          const ariaLabel = normalize(candidate.getAttribute('aria-label'));
          if (ariaLabel !== '') return ariaLabel.slice(0, 500);
          const labelledBy = normalize(candidate.getAttribute('aria-labelledby'));
          if (labelledBy !== '') {
            const labels = labelledBy.split(' ')
              .map((id) => document.getElementById(id))
              .filter((label): label is HTMLElement => label !== null)
              .map((label) => normalize(label.innerText || label.textContent))
              .filter((label) => label !== '')
              .join(' ');
            if (labels !== '') return labels.slice(0, 500);
          }
          const alt = normalize(candidate.getAttribute('alt'));
          if (alt !== '') return alt.slice(0, 500);
          const rendered = renderedText(candidate);
          if (rendered !== '') return rendered.slice(0, 500);
          const value = normalize(candidate.getAttribute('value'));
          if (value !== '') return value.slice(0, 500);
          const placeholder = normalize(candidate.getAttribute('placeholder'));
          if (placeholder !== '') return placeholder.slice(0, 500);
          return normalize(candidate.getAttribute('title')).slice(0, 500);
        };
        const descendants = Array.from(articleElement.querySelectorAll('*'));
        if (descendants.length + 1 > expected.maximumCandidates) {
          return { tooMany: true, indexes: [] as number[] };
        }
        const candidates = [articleElement, ...descendants];
        const indexes: number[] = [];
        candidates.forEach((candidate, index) => {
          if (
            candidate.tagName.toLocaleLowerCase() === expected.tagName &&
            semanticRole(candidate) === expected.role &&
            semanticName(candidate) === expected.name
          ) {
            indexes.push(index);
          }
        });
        return { tooMany: false, indexes };
      }, {
        tagName: identity.tagName,
        role: identity.role,
        name: identity.name,
        maximumCandidates: CLICK_REF_ELEMENT_CANDIDATES,
      });
      if (match.tooMany || match.indexes.length > 1) {
        return { kind: 'ambiguous' };
      }
      const targetIndex = match.indexes[0];
      if (targetIndex === undefined) {
        return { kind: 'missing' };
      }
      const reboundLocator = targetIndex === 0
        ? article
        : article.locator('*').nth(targetIndex - 1);
      const reboundHandle = await reboundLocator.elementHandle();
      if (reboundHandle === null) {
        return { kind: 'missing' };
      }
      const reboundIdentity = await this.observeClickTargetIdentity(reboundHandle);
      if (reboundIdentity === null || !this.sameClickTargetIdentity(identity, reboundIdentity)) {
        await reboundHandle.dispose().catch(() => undefined);
        return { kind: 'missing' };
      }
      return { kind: 'resolved', locator: reboundLocator, handle: reboundHandle };
    } catch {
      return { kind: 'missing' };
    }
  }

  private sameClickTargetIdentity(
    expected: ClickTargetSemanticIdentity,
    observed: ClickTargetSemanticIdentity,
  ): boolean {
    if (
      expected.tagName !== observed.tagName ||
      expected.role !== observed.role ||
      expected.name !== observed.name
    ) {
      return false;
    }
    if (expected.article === null || observed.article === null) {
      return expected.article === null && observed.article === null;
    }
    return expected.article.fingerprint === observed.article.fingerprint &&
      expected.article.tagName === observed.article.tagName &&
      expected.article.role === observed.article.role &&
      expected.article.nestingDepth === observed.article.nestingDepth;
  }

  private failVirtualizedClickRebind(
    page: Page,
    startedAt: string,
    result: 'ambiguous' | 'missing',
    priorTargetState: SafeTargetState,
  ): never {
    this.failClickBeforeDispatch(
      page,
      startedAt,
      priorTargetState,
      result === 'ambiguous' ? 'ambiguous_target' : 'detached',
      result === 'ambiguous'
        ? 'virtualized_target_rebind_ambiguous'
        : 'virtualized_target_rebind_failed',
      result === 'ambiguous'
        ? 'The page virtualized the observed element and more than one replacement matched its article-scoped identity.'
        : 'The page virtualized the observed element and Stage5 Browser could not uniquely prove its replacement.',
      'Take one fresh semantic snapshot after the feed settles; Stage5 Browser did not dispatch the click.',
      result === 'ambiguous' ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND',
    );
  }

  private failClickBeforeDispatch(
    page: Page,
    startedAt: string,
    targetState: SafeTargetState | null,
    diagnosticReason: SanitizedActionDiagnostic['reason'],
    reason: string,
    message: string,
    suggestedAction: string,
    code: 'AMBIGUOUS_TARGET' | 'OPERATION_FAILED' | 'TARGET_NOT_FOUND' = 'OPERATION_FAILED',
    action: SanitizedActionDiagnostic['action'] = 'click_by_ref',
  ): never {
    const diagnostic: SanitizedActionDiagnostic = {
      action,
      outcome: 'blocked',
      reason: diagnosticReason,
      actionDispatched: false,
      clickDispatched: false,
      targetState,
      pageUrl: sanitizeUrlForJournal(page.url()) ?? null,
      startedAt,
      occurredAt: new Date().toISOString(),
    };
    this.pageDiagnostics.recordAction(page, diagnostic);
    throw new Stage5BrowserError(code, message, {
      recoverable: true,
      details: {
        reason,
        actionOutcome: 'blocked',
        actionDispatched: false,
        clickDispatched: false,
        targetState,
        suggestedAction,
      },
    });
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
      actionDispatched: false,
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
    dispatchEvidence: SanitizedClickDispatchEvidence | null = null,
  ): SanitizedActionDiagnostic {
    return {
      action,
      outcome: 'succeeded',
      reason: null,
      actionDispatched: true,
      clickDispatched: true,
      targetState,
      ...(dispatchEvidence === null ? {} : { dispatchEvidence }),
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
    dispatchEvidence: SanitizedClickDispatchEvidence | null = null,
  ): SanitizedActionDiagnostic {
    return {
      action,
      outcome: 'postcondition_failed',
      reason: 'postcondition_not_met',
      actionDispatched: true,
      clickDispatched: true,
      targetState,
      ...(dispatchEvidence === null ? {} : { dispatchEvidence }),
      pageUrl: sanitizeUrlForJournal(page.url()) ?? null,
      startedAt,
      occurredAt: new Date().toISOString(),
    };
  }

  private scrollActionDiagnostic(
    page: Page,
    startedAt: string,
    actionDispatched: boolean | 'unknown',
    outcome: 'blocked' | 'failed' | 'succeeded',
    reason: SanitizedActionDiagnostic['reason'] = outcome === 'succeeded' ? null : 'unknown',
  ): SanitizedActionDiagnostic {
    return {
      action: 'scroll',
      outcome,
      reason,
      actionDispatched,
      clickDispatched: null,
      targetState: null,
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
          actionDispatched: diagnostic.actionDispatched,
          clickDispatched: diagnostic.clickDispatched,
          actionOutcome: diagnostic.outcome,
          targetState: diagnostic.targetState,
          dispatchEvidence: diagnostic.dispatchEvidence ?? null,
          suggestedAction:
            diagnostic.actionDispatched === false && diagnostic.clickDispatched === false
              ? 'Take a fresh snapshot before another attempt; Stage5 Browser confirmed that no input was dispatched.'
              : 'Inspect authoritative state with a fresh snapshot. Do not retry or replay the opener because partial or ambiguous input may already have changed the page.',
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
