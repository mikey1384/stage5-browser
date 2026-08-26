import type { ConsoleMessage, Page, Request, Response } from 'playwright';

import { ACTION_NETWORK_TAIL_MS, boundedPush, consoleCategory, networkFailureCategory, privacyFingerprint, safeMethod, safeResourceType, safeUrl } from './classification.js';
import type { PageDiagnosticRecord, PageRuntimeDiagnostics, SanitizedActionDiagnostic, SanitizedNetworkDiagnostic } from './types.js';

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

  restoreAction(page: Page, diagnostic: SanitizedActionDiagnostic): void {
    const record = this.recordFor(page);
    const currentOccurredAt = record.lastAction === null
      ? Number.NEGATIVE_INFINITY
      : new Date(record.lastAction.occurredAt).getTime();
    const retainedOccurredAt = new Date(diagnostic.occurredAt).getTime();
    if (currentOccurredAt >= retainedOccurredAt) return;
    record.lastAction = structuredClone(diagnostic);
    record.lastActionNetworkEvents = [];
    record.activeActionStartedAt = diagnostic.startedAt;
    record.activeActionNetworkEndAtMs = null;
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
