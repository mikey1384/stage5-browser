import { createHmac, randomBytes } from 'node:crypto';

import type { Page, Request } from 'playwright';

import { sanitizeUrlForJournal } from '../url-policy.js';
import type { ActionFailureReason, ConsoleDiagnosticCategory, NetworkFailureCategory, SafeTargetState, SanitizedActionDiagnostic } from './types.js';

const MAX_EVENTS_PER_CATEGORY = 40;
export const ACTION_NETWORK_TAIL_MS = 2_000;
const ALLOWED_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
const DIAGNOSTIC_FINGERPRINT_KEY = randomBytes(32);

export function boundedPush<T>(values: T[], value: T): void {
  values.push(value);
  if (values.length > MAX_EVENTS_PER_CATEGORY) {
    values.splice(0, values.length - MAX_EVENTS_PER_CATEGORY);
  }
}

export function privacyFingerprint(value: string): string {
  return createHmac('sha256', DIAGNOSTIC_FINGERPRINT_KEY).update(value).digest('hex').slice(0, 12);
}

export function safeUrl(value: string | undefined): string | null {
  return sanitizeUrlForJournal(value) ?? null;
}

export function consoleCategory(value: string): ConsoleDiagnosticCategory {
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

export function networkFailureCategory(value: string | undefined): NetworkFailureCategory {
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

export function safeMethod(request: Request): string {
  const method = request.method().toUpperCase();
  return ALLOWED_METHODS.has(method) ? method : 'OTHER';
}

export function safeResourceType(request: Request): string {
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
