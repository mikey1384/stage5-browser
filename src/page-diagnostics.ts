import { createHmac, randomBytes } from 'node:crypto';

import type { ConsoleMessage, ElementHandle, Locator, Page, Request, Response } from 'playwright';

import type { FillRefEvidence } from './protocol.js';
import { sanitizeUrlForJournal } from './url-policy.js';

export type ConsoleDiagnosticCategory =
  | 'automation_rejection'
  | 'content_security_policy'
  | 'network'
  | 'other'
  | 'uncaught_exception';

export type NetworkFailureCategory =
  | 'aborted'
  | 'blocked'
  | 'connection'
  | 'dns'
  | 'other'
  | 'timeout'
  | 'tls';

export type ActionFailureReason =
  | 'ambiguous_target'
  | 'detached'
  | 'not_enabled'
  | 'not_visible'
  | 'page_not_active'
  | 'pointer_intercepted'
  | 'target_missing'
  | 'timeout'
  | 'unknown';

export interface SanitizedConsoleDiagnostic {
  severity: 'error' | 'warning';
  category: ConsoleDiagnosticCategory;
  sourceUrl: string | null;
  fingerprint: string;
  occurredAt: string;
}

export interface SanitizedNetworkDiagnostic {
  kind: 'http_error' | 'http_response' | 'request_failed';
  method: string;
  resourceType: string;
  url: string | null;
  status: number | null;
  failureCategory: NetworkFailureCategory | null;
  occurredAt: string;
}

export interface SafeTargetState {
  visible: boolean;
  enabled: boolean;
  inViewport: boolean;
  receivesPointerEvents: boolean | null;
  tagName: string;
  role: string | null;
  coveredBy: { tagName: string; role: string | null; pointerEvents: string } | null;
}

export type SanitizedNativeWindowActivationResult =
  | 'activated'
  | 'application_activation_failed'
  | 'application_activation_unverified'
  | 'headless_not_applicable'
  | 'native_activation_unsupported'
  | 'not_required'
  | 'owned_process_not_running'
  | 'owned_process_unavailable'
  | 'target_window_unavailable'
  | 'visibility_unchanged'
  | 'window_normalization_failed';

export interface SanitizedNativeWindowActivationEvidence {
  required: boolean;
  attempted: boolean;
  supported: boolean;
  ownedProcessAvailable: boolean;
  ownedProcessRunning: boolean | null;
  targetWindowResolved: boolean | null;
  windowStateBefore: 'fullscreen' | 'maximized' | 'minimized' | 'normal' | 'unknown';
  normalizationAttempted: boolean;
  normalizationSucceeded: boolean | null;
  applicationActivationAttempted: boolean;
  applicationActivationSucceeded: boolean | null;
  applicationHiddenBefore: boolean | null;
  unhideAttempted: boolean;
  unhideSucceeded: boolean | null;
  activationRequestAccepted: boolean | null;
  frontProcessFallbackAttempted: boolean;
  frontProcessFallbackProcessResolved: boolean | null;
  frontProcessFallbackRequestSucceeded: boolean | null;
  applicationFrontmostAfter: boolean | null;
  applicationHiddenAfter: boolean | null;
  result: SanitizedNativeWindowActivationResult;
}

export interface SanitizedPageActivationEvidence {
  attemptCount: number;
  controllerSelected: boolean;
  bringToFrontAttempted: boolean;
  bringToFrontSucceeded: boolean;
  visibilityBefore: 'hidden' | 'prerender' | 'unknown' | 'visible';
  visibilityAfter: 'hidden' | 'prerender' | 'unknown' | 'visible';
  documentFocusedBefore: boolean | null;
  documentFocusedAfter: boolean | null;
  nativeWindow: SanitizedNativeWindowActivationEvidence;
}

export interface SanitizedClickDispatchEvidence {
  strategy: 'guarded_exact_handle';
  forcedFallbackUsed: boolean;
  pageMouseFallbackUsed: boolean;
  pageActivation: SanitizedPageActivationEvidence;
  guardExpired: boolean;
  targetConnectedBefore: boolean;
  targetConnectedAtFirstEvent: boolean | null;
  targetConnectedAfter: boolean;
  geometryChangedBeforeFirstEvent: boolean | null;
  trustedEventObserved: boolean;
  pointerDownOnTarget: boolean;
  mouseDownOnTarget: boolean;
  pointerUpOnTarget: boolean;
  mouseUpOnTarget: boolean;
  clickOnTarget: boolean;
  misdirectedEventBlocked: boolean;
  targetStateChangeBlocked: boolean;
}

export interface SanitizedActionDiagnostic {
  action: 'click_by_ref' | 'click_by_role' | 'fill_ref' | 'scroll';
  outcome: 'blocked' | 'failed' | 'postcondition_failed' | 'succeeded';
  reason: ActionFailureReason | 'postcondition_not_met' | null;
  actionDispatched: boolean | 'unknown';
  clickDispatched: boolean | 'unknown' | null;
  targetState: SafeTargetState | null;
  dispatchEvidence?: SanitizedClickDispatchEvidence;
  fillPhase?: 'completed' | 'event_verification' | 'fill_dispatch' | 'page_activation' | 'target_preparation' | 'value_matching';
  inputEvidence?: FillRefEvidence;
  pageUrl: string | null;
  startedAt: string;
  occurredAt: string;
}

export interface PageRuntimeDiagnostics {
  pageUrl: string | null;
  totals: {
    consoleErrors: number;
    consoleWarnings: number;
    pageErrors: number;
    failedRequests: number;
    httpErrors: number;
    httpRedirects: number;
    httpSuccesses: number;
  };
  consoleEvents: SanitizedConsoleDiagnostic[];
  networkEvents: SanitizedNetworkDiagnostic[];
  lastAction: SanitizedActionDiagnostic | null;
  lastActionNetworkEvents: SanitizedNetworkDiagnostic[];
  privacy:
    'Raw console messages, exception text, request bodies, headers, query strings, fragments, click coordinates, and event payloads are excluded.';
}

interface PageDiagnosticRecord {
  totals: PageRuntimeDiagnostics['totals'];
  consoleEvents: SanitizedConsoleDiagnostic[];
  networkEvents: SanitizedNetworkDiagnostic[];
  lastAction: SanitizedActionDiagnostic | null;
  lastActionNetworkEvents: SanitizedNetworkDiagnostic[];
  activeActionStartedAt: string | null;
  activeActionNetworkEndAtMs: number | null;
}

const MAX_EVENTS_PER_CATEGORY = 40;
const ACTION_NETWORK_TAIL_MS = 2_000;
const ALLOWED_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
const DIAGNOSTIC_FINGERPRINT_KEY = randomBytes(32);

function boundedPush<T>(values: T[], value: T): void {
  values.push(value);
  if (values.length > MAX_EVENTS_PER_CATEGORY) {
    values.splice(0, values.length - MAX_EVENTS_PER_CATEGORY);
  }
}

export function privacyFingerprint(value: string): string {
  return createHmac('sha256', DIAGNOSTIC_FINGERPRINT_KEY).update(value).digest('hex').slice(0, 12);
}

function safeUrl(value: string | undefined): string | null {
  return sanitizeUrlForJournal(value) ?? null;
}

function consoleCategory(value: string): ConsoleDiagnosticCategory {
  const descriptor = value.toLocaleLowerCase();
  if (
    descriptor.includes('webdriver') ||
    descriptor.includes('automation') ||
    descriptor.includes('bot detection') ||
    descriptor.includes('suspicious activity')
  ) {
    return 'automation_rejection';
  }
  if (
    descriptor.includes('content security policy') ||
    descriptor.includes('content-security-policy') ||
    descriptor.includes('violates the following content security')
  ) {
    return 'content_security_policy';
  }
  if (
    descriptor.includes('failed to load resource') ||
    descriptor.includes('networkerror') ||
    descriptor.includes('network error')
  ) {
    return 'network';
  }
  return 'other';
}

function networkFailureCategory(value: string | undefined): NetworkFailureCategory {
  const descriptor = value?.toLocaleLowerCase() ?? '';
  if (descriptor.includes('aborted')) {
    return 'aborted';
  }
  if (descriptor.includes('blocked')) {
    return 'blocked';
  }
  if (descriptor.includes('timed') || descriptor.includes('timeout')) {
    return 'timeout';
  }
  if (descriptor.includes('name_not_resolved') || descriptor.includes('dns')) {
    return 'dns';
  }
  if (descriptor.includes('ssl') || descriptor.includes('tls') || descriptor.includes('certificate')) {
    return 'tls';
  }
  if (
    descriptor.includes('connection') ||
    descriptor.includes('internet_disconnected') ||
    descriptor.includes('network_changed')
  ) {
    return 'connection';
  }
  return 'other';
}

function safeMethod(request: Request): string {
  const method = request.method().toUpperCase();
  return ALLOWED_METHODS.has(method) ? method : 'OTHER';
}

function safeResourceType(request: Request): string {
  const resourceType = request.resourceType().toLocaleLowerCase();
  return /^[a-z_-]{1,30}$/.test(resourceType) ? resourceType : 'other';
}

function clickFailureReason(error: unknown, state: SafeTargetState | null): ActionFailureReason {
  if (state?.visible === false) {
    return 'not_visible';
  }
  if (state?.enabled === false) {
    return 'not_enabled';
  }
  if (state?.receivesPointerEvents === false) {
    return 'pointer_intercepted';
  }
  const descriptor = error instanceof Error ? `${error.name} ${error.message}`.toLocaleLowerCase() : '';
  if (descriptor.includes('intercepts pointer events')) {
    return 'pointer_intercepted';
  }
  if (descriptor.includes('not enabled') || descriptor.includes('disabled')) {
    return 'not_enabled';
  }
  if (descriptor.includes('not visible') || descriptor.includes('outside of the viewport')) {
    return 'not_visible';
  }
  if (descriptor.includes('detached') || descriptor.includes('not attached')) {
    return 'detached';
  }
  if (descriptor.includes('timeout') || descriptor.includes('timed out')) {
    return 'timeout';
  }
  return 'unknown';
}

export function actionDiagnosticForFailure(
  action: SanitizedActionDiagnostic['action'],
  page: Page,
  error: unknown,
  targetState: SafeTargetState | null,
  startedAt = new Date().toISOString(),
): SanitizedActionDiagnostic {
  const reason = clickFailureReason(error, targetState);
  const definitelyBlocked = new Set<ActionFailureReason>([
    'detached',
    'not_enabled',
    'not_visible',
    'pointer_intercepted',
  ]).has(reason);
  return {
    action,
    outcome: definitelyBlocked ? 'blocked' : 'failed',
    reason,
    actionDispatched: definitelyBlocked ? false : 'unknown',
    clickDispatched: definitelyBlocked ? false : 'unknown',
    targetState,
    pageUrl: safeUrl(page.url()),
    startedAt,
    occurredAt: new Date().toISOString(),
  };
}

export function inspectTargetState(locator: Locator): Promise<SafeTargetState | null>;
export function inspectTargetState(
  locator: ElementHandle<HTMLElement | SVGElement>,
): Promise<SafeTargetState | null>;
export async function inspectTargetState(
  locator: Locator | ElementHandle<HTMLElement | SVGElement>,
): Promise<SafeTargetState | null> {
  const inspect = (element: Element): SafeTargetState => {
    const semanticRole = (candidate: Element): string | null => {
      const explicit = candidate.getAttribute('role')?.trim().split(/\s+/)[0];
      if (explicit !== undefined && explicit.length > 0) return explicit;
      const tagName = candidate.tagName.toLocaleLowerCase();
      if (tagName === 'button' || tagName === 'summary') return 'button';
      if ((tagName === 'a' || tagName === 'area') && candidate.hasAttribute('href')) return 'link';
      if (tagName === 'textarea') return 'textbox';
      if (tagName === 'select') {
        const select = candidate as HTMLSelectElement;
        return select.multiple || select.size > 1 ? 'listbox' : 'combobox';
      }
      if (tagName === 'input') {
        const type = (candidate as HTMLInputElement).type.toLocaleLowerCase();
        if (type === 'button' || type === 'image' || type === 'reset' || type === 'submit') return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return 'searchbox';
        if (type !== 'hidden') return 'textbox';
      }
      if (/^h[1-6]$/.test(tagName)) return 'heading';
      if (tagName === 'img' && candidate.hasAttribute('alt')) return 'img';
      if (tagName === 'main') return 'main';
      if (tagName === 'nav') return 'navigation';
      if (tagName === 'dialog') return 'dialog';
      return null;
    };
    if (!element.isConnected) {
      throw new Error('Target element is detached.');
    }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0';
    let visibleLeft = Math.max(0, rect.left);
    let visibleRight = Math.min(window.innerWidth, rect.right);
    let visibleTop = Math.max(0, rect.top);
    let visibleBottom = Math.min(window.innerHeight, rect.bottom);
    for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
      const ancestorStyle = getComputedStyle(ancestor);
      const ancestorRect = ancestor.getBoundingClientRect();
      if (/(auto|clip|hidden|scroll)/u.test(ancestorStyle.overflowX)) {
        visibleLeft = Math.max(visibleLeft, ancestorRect.left);
        visibleRight = Math.min(visibleRight, ancestorRect.right);
      }
      if (/(auto|clip|hidden|scroll)/u.test(ancestorStyle.overflowY)) {
        visibleTop = Math.max(visibleTop, ancestorRect.top);
        visibleBottom = Math.min(visibleBottom, ancestorRect.bottom);
      }
    }
    const inViewport = visible && visibleRight > visibleLeft && visibleBottom > visibleTop;
    const centerX = visibleLeft + (visibleRight - visibleLeft) / 2;
    const centerY = visibleTop + (visibleBottom - visibleTop) / 2;
    const hit = inViewport ? document.elementFromPoint(centerX, centerY) : null;
    const receivesPointerEvents = hit === null
      ? null
      : hit === element || element.contains(hit);
    const htmlDisabled = 'disabled' in element && Boolean((element as HTMLButtonElement).disabled);
    const ariaDisabled = element.getAttribute('aria-disabled') === 'true';
    const coveredBy = receivesPointerEvents === false && hit !== null
      ? {
          tagName: hit.tagName.toLocaleLowerCase(),
          role: semanticRole(hit),
          pointerEvents: getComputedStyle(hit).pointerEvents,
        }
      : null;
    return {
      visible,
      enabled: !htmlDisabled && !ariaDisabled,
      inViewport,
      receivesPointerEvents,
      tagName: element.tagName.toLocaleLowerCase(),
      role: semanticRole(element),
      coveredBy,
    };
  };
  try {
    if ('elementHandle' in locator) {
      return await locator.evaluate(inspect);
    }
    return await locator.evaluate(inspect);
  } catch {
    return null;
  }
}

export class PageDiagnosticBuffer {
  private readonly records = new WeakMap<Page, PageDiagnosticRecord>();

  bind(page: Page): void {
    if (this.records.has(page)) {
      return;
    }
    const record: PageDiagnosticRecord = {
      totals: {
        consoleErrors: 0,
        consoleWarnings: 0,
        pageErrors: 0,
        failedRequests: 0,
        httpErrors: 0,
        httpRedirects: 0,
        httpSuccesses: 0,
      },
      consoleEvents: [],
      networkEvents: [],
      lastAction: null,
      lastActionNetworkEvents: [],
      activeActionStartedAt: null,
      activeActionNetworkEndAtMs: null,
    };
    this.records.set(page, record);

    page.on('console', (message) => this.recordConsole(record, message));
    page.on('pageerror', (error) => {
      record.totals.pageErrors += 1;
      boundedPush(record.consoleEvents, {
        severity: 'error',
        category: 'uncaught_exception',
        sourceUrl: safeUrl(page.url()),
        fingerprint: privacyFingerprint(`${error.name}:${error.message}:${error.stack ?? ''}`),
        occurredAt: new Date().toISOString(),
      });
    });
    page.on('requestfailed', (request) => this.recordFailedRequest(record, request));
    page.on('response', (response) => this.recordHttpResponse(record, response));
  }

  beginAction(page: Page, startedAt: string): void {
    const record = this.recordFor(page);
    record.lastActionNetworkEvents = [];
    record.activeActionStartedAt = startedAt;
    record.activeActionNetworkEndAtMs = null;
  }

  recordAction(page: Page, diagnostic: SanitizedActionDiagnostic): void {
    const record = this.recordFor(page);
    if (record.activeActionStartedAt !== diagnostic.startedAt) {
      record.lastActionNetworkEvents = [];
      record.activeActionStartedAt = diagnostic.startedAt;
    }
    record.lastAction = diagnostic;
    record.activeActionNetworkEndAtMs = new Date(diagnostic.occurredAt).getTime() + ACTION_NETWORK_TAIL_MS;
  }

  snapshot(page: Page): PageRuntimeDiagnostics {
    const record = this.recordFor(page);
    return {
      pageUrl: safeUrl(page.url()),
      totals: { ...record.totals },
      consoleEvents: [...record.consoleEvents],
      networkEvents: [...record.networkEvents],
      lastAction: record.lastAction === null ? null : { ...record.lastAction },
      lastActionNetworkEvents: [...record.lastActionNetworkEvents],
      privacy: 'Raw console messages, exception text, request bodies, headers, query strings, fragments, click coordinates, and event payloads are excluded.',
    };
  }

  private recordFor(page: Page): PageDiagnosticRecord {
    const existing = this.records.get(page);
    if (existing !== undefined) {
      return existing;
    }
    this.bind(page);
    const created = this.records.get(page);
    if (created === undefined) {
      throw new Error('Page diagnostics could not be initialized.');
    }
    return created;
  }

  private recordConsole(record: PageDiagnosticRecord, message: ConsoleMessage): void {
    const type = message.type();
    if (type !== 'error' && type !== 'warning') {
      return;
    }
    if (type === 'error') {
      record.totals.consoleErrors += 1;
    } else {
      record.totals.consoleWarnings += 1;
    }
    const text = message.text();
    boundedPush(record.consoleEvents, {
      severity: type,
      category: consoleCategory(text),
      sourceUrl: safeUrl(message.location().url),
      fingerprint: privacyFingerprint(text),
      occurredAt: new Date().toISOString(),
    });
  }

  private recordFailedRequest(record: PageDiagnosticRecord, request: Request): void {
    record.totals.failedRequests += 1;
    this.recordNetworkEvent(record, {
      kind: 'request_failed',
      method: safeMethod(request),
      resourceType: safeResourceType(request),
      url: safeUrl(request.url()),
      status: null,
      failureCategory: networkFailureCategory(request.failure()?.errorText),
      occurredAt: new Date().toISOString(),
    });
  }

  private recordHttpResponse(record: PageDiagnosticRecord, response: Response): void {
    const status = response.status();
    if (status >= 400) {
      record.totals.httpErrors += 1;
    } else if (status >= 300) {
      record.totals.httpRedirects += 1;
    } else {
      record.totals.httpSuccesses += 1;
    }
    const request = response.request();
    this.recordNetworkEvent(record, {
      kind: status >= 400 ? 'http_error' : 'http_response',
      method: safeMethod(request),
      resourceType: safeResourceType(request),
      url: safeUrl(response.url()),
      status,
      failureCategory: null,
      occurredAt: new Date().toISOString(),
    });
  }

  private recordNetworkEvent(record: PageDiagnosticRecord, event: SanitizedNetworkDiagnostic): void {
    boundedPush(record.networkEvents, event);
    if (record.activeActionStartedAt === null || event.occurredAt < record.activeActionStartedAt) {
      return;
    }
    if (
      record.activeActionNetworkEndAtMs !== null &&
      new Date(event.occurredAt).getTime() > record.activeActionNetworkEndAtMs
    ) {
      return;
    }
    boundedPush(record.lastActionNetworkEvents, event);
  }
}
