import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  SUPPORTED_BROWSER_PRODUCTS,
  type BrowserProduct,
} from './browser-provider.js';
import type { SanitizedActionDiagnostic } from './page-diagnostics.js';
import { sanitizeUrlForJournal } from './url-policy.js';

const CONTROL_RECORD_NAME = '.stage5-browser-control.json';

export interface NativeControlRecord {
  version: 1;
  kind: 'chromium_cdp';
  browser: BrowserProduct;
  state: 'awaiting_user' | 'controlled';
  processId: number;
  port: number;
  createdAt: string;
  /** Opaque CDP target identity used only to preserve exact tab selection across worker replacement. */
  selectedTargetId?: string | null;
  /** Opaque loader identity used only to detect document replacement across worker reattachment. */
  selectedDocumentId?: string | null;
  /** Privacy-safe action evidence retained only for the exact selected target across worker replacement. */
  retainedAction?: {
    selectedTargetId: string;
    /** Opaque main-document loader identity; never returned or journaled. */
    documentId: string;
    diagnostic: SanitizedActionDiagnostic;
  };
}

export function nativeControlEndpoint(record: NativeControlRecord): string {
  return `http://127.0.0.1:${record.port}`;
}

export function nativeControlRecordPath(profileDir: string): string {
  return path.join(profileDir, CONTROL_RECORD_NAME);
}

function isSafeTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 64
    && Number.isFinite(Date.parse(value));
}

function isRecordWithOnlyKeys(
  value: unknown,
  allowedKeys: readonly string[],
): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isBooleanOrNull(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean';
}

function isSafeSemanticToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 64
    && /^[a-z0-9_-]+$/iu.test(value);
}

function isSafeTargetState(value: unknown): boolean {
  if (!isRecordWithOnlyKeys(value, [
    'visible', 'enabled', 'inViewport', 'receivesPointerEvents', 'pointerHitPoint', 'tagName', 'role', 'coveredBy',
  ])) return false;
  const coveredBy = value.coveredBy;
  const safeCover = coveredBy === null || (
    isRecordWithOnlyKeys(coveredBy, ['tagName', 'role', 'pointerEvents'])
    && isSafeSemanticToken(coveredBy.tagName)
    && (coveredBy.role === null || isSafeSemanticToken(coveredBy.role))
    && isSafeSemanticToken(coveredBy.pointerEvents)
  );
  return typeof value.visible === 'boolean'
    && typeof value.enabled === 'boolean'
    && typeof value.inViewport === 'boolean'
    && isBooleanOrNull(value.receivesPointerEvents)
    && (
      value.pointerHitPoint === undefined ||
      value.pointerHitPoint === null ||
      value.pointerHitPoint === 'center' ||
      value.pointerHitPoint === 'alternate'
    )
    && isSafeSemanticToken(value.tagName)
    && (value.role === null || isSafeSemanticToken(value.role))
    && safeCover;
}

function isSafeNativeWindowEvidence(value: unknown): boolean {
  if (!isRecordWithOnlyKeys(value, [
    'required', 'attempted', 'supported', 'ownedProcessAvailable', 'ownedProcessRunning',
    'targetWindowResolved', 'windowStateBefore', 'normalizationAttempted',
    'normalizationSucceeded', 'applicationActivationAttempted', 'applicationActivationSucceeded',
    'applicationHiddenBefore', 'unhideAttempted', 'unhideSucceeded', 'activationRequestAccepted',
    'frontProcessFallbackAttempted', 'frontProcessFallbackProcessResolved',
    'frontProcessFallbackRequestSucceeded', 'applicationFrontmostAfter', 'applicationHiddenAfter',
    'result',
  ])) return false;
  return [
    value.required,
    value.attempted,
    value.supported,
    value.ownedProcessAvailable,
    value.normalizationAttempted,
    value.applicationActivationAttempted,
    value.unhideAttempted,
    value.frontProcessFallbackAttempted,
  ].every((candidate) => typeof candidate === 'boolean')
    && [
      value.ownedProcessRunning,
      value.targetWindowResolved,
      value.normalizationSucceeded,
      value.applicationActivationSucceeded,
      value.applicationHiddenBefore,
      value.unhideSucceeded,
      value.activationRequestAccepted,
      value.frontProcessFallbackProcessResolved,
      value.frontProcessFallbackRequestSucceeded,
      value.applicationFrontmostAfter,
      value.applicationHiddenAfter,
    ].every(isBooleanOrNull)
    && ['fullscreen', 'maximized', 'minimized', 'normal', 'unknown'].includes(
      typeof value.windowStateBefore === 'string' ? value.windowStateBefore : '',
    )
    && [
      'activated', 'application_activation_failed', 'application_activation_unverified',
      'headless_not_applicable', 'native_activation_unsupported', 'not_required',
      'owned_process_not_running', 'owned_process_unavailable', 'target_window_unavailable',
      'visibility_unchanged', 'window_normalization_failed',
    ].includes(typeof value.result === 'string' ? value.result : '');
}

function isSafePageActivationEvidence(value: unknown): boolean {
  if (!isRecordWithOnlyKeys(value, [
    'attemptCount', 'controllerSelected', 'bringToFrontAttempted', 'bringToFrontSucceeded',
    'visibilityBefore', 'visibilityAfter', 'documentFocusedBefore', 'documentFocusedAfter',
    'nativeWindow',
  ])) return false;
  return Number.isSafeInteger(value.attemptCount)
    && (value.attemptCount as number) >= 0
    && (value.attemptCount as number) <= 100
    && typeof value.controllerSelected === 'boolean'
    && typeof value.bringToFrontAttempted === 'boolean'
    && typeof value.bringToFrontSucceeded === 'boolean'
    && ['hidden', 'prerender', 'unknown', 'visible'].includes(
      typeof value.visibilityBefore === 'string' ? value.visibilityBefore : '',
    )
    && ['hidden', 'prerender', 'unknown', 'visible'].includes(
      typeof value.visibilityAfter === 'string' ? value.visibilityAfter : '',
    )
    && isBooleanOrNull(value.documentFocusedBefore)
    && isBooleanOrNull(value.documentFocusedAfter)
    && isSafeNativeWindowEvidence(value.nativeWindow);
}

function isSafeDispatchEvidence(value: unknown): boolean {
  if (!isRecordWithOnlyKeys(value, [
    'strategy', 'forcedFallbackUsed', 'pageMouseFallbackUsed', 'pageActivation', 'guardExpired',
    'targetConnectedBefore', 'targetConnectedAtFirstEvent', 'targetConnectedAfter',
    'geometryChangedBeforeFirstEvent', 'trustedEventObserved', 'keyDownOnTarget', 'keyUpOnTarget',
    'pointerDownOnTarget', 'mouseDownOnTarget', 'pointerUpOnTarget', 'mouseUpOnTarget',
    'clickOnTarget', 'misdirectedEventBlocked', 'targetStateChangeBlocked',
  ])) return false;
  return value.strategy === 'guarded_exact_handle'
    && [
      value.forcedFallbackUsed,
      value.pageMouseFallbackUsed,
      value.guardExpired,
      value.targetConnectedBefore,
      value.targetConnectedAfter,
      value.trustedEventObserved,
      value.keyDownOnTarget,
      value.keyUpOnTarget,
      value.pointerDownOnTarget,
      value.mouseDownOnTarget,
      value.pointerUpOnTarget,
      value.mouseUpOnTarget,
      value.clickOnTarget,
      value.misdirectedEventBlocked,
      value.targetStateChangeBlocked,
    ].every((candidate) => typeof candidate === 'boolean')
    && isBooleanOrNull(value.targetConnectedAtFirstEvent)
    && isBooleanOrNull(value.geometryChangedBeforeFirstEvent)
    && isSafePageActivationEvidence(value.pageActivation);
}

function isSafeInputEvidence(value: unknown): boolean {
  if (!isRecordWithOnlyKeys(value, [
    'actionDispatched', 'inputEventObserved', 'changeEventObserved', 'valueMatchedBefore',
    'valueMatches', 'targetConnectedAfter', 'targetKind',
  ])) return false;
  return (typeof value.actionDispatched === 'boolean' || value.actionDispatched === 'unknown')
    && typeof value.inputEventObserved === 'boolean'
    && typeof value.changeEventObserved === 'boolean'
    && typeof value.valueMatchedBefore === 'boolean'
    && typeof value.valueMatches === 'boolean'
    && typeof value.targetConnectedAfter === 'boolean'
    && ['contenteditable', 'input', 'textarea'].includes(
      typeof value.targetKind === 'string' ? value.targetKind : '',
    );
}

function isRetainedActionDiagnostic(value: unknown): value is SanitizedActionDiagnostic {
  if (!isRecordWithOnlyKeys(value, [
    'action', 'outcome', 'reason', 'actionDispatched', 'clickDispatched', 'targetState',
    'dispatchEvidence', 'fillPhase', 'fillPreparationStep', 'inputEvidence', 'pageUrl',
    'startedAt', 'occurredAt',
  ])) return false;
  let serializedLength = Number.POSITIVE_INFINITY;
  try {
    serializedLength = JSON.stringify(value).length;
  } catch {
    return false;
  }
  return serializedLength <= 32_768
    && ['click_by_ref', 'click_by_role', 'fill_ref', 'scroll'].includes(
      typeof value.action === 'string' ? value.action : '',
    )
    && ['blocked', 'failed', 'postcondition_failed', 'succeeded'].includes(
      typeof value.outcome === 'string' ? value.outcome : '',
    )
    && (
      value.reason === null ||
      [
        'ambiguous_target', 'detached', 'not_enabled', 'not_visible', 'page_not_active',
        'pointer_intercepted', 'postcondition_not_met', 'target_missing', 'timeout', 'unknown',
      ].includes(typeof value.reason === 'string' ? value.reason : '')
    )
    && (typeof value.actionDispatched === 'boolean' || value.actionDispatched === 'unknown')
    && (
      value.clickDispatched === null ||
      typeof value.clickDispatched === 'boolean' ||
      value.clickDispatched === 'unknown'
    )
    && (value.targetState === null || isSafeTargetState(value.targetState))
    && (
      value.pageUrl === null ||
      (typeof value.pageUrl === 'string'
        && value.pageUrl.length <= 2_048
        && sanitizeUrlForJournal(value.pageUrl) === value.pageUrl)
    )
    && isSafeTimestamp(value.startedAt)
    && isSafeTimestamp(value.occurredAt)
    && (value.dispatchEvidence === undefined || isSafeDispatchEvidence(value.dispatchEvidence))
    && (
      value.fillPhase === undefined ||
      ['completed', 'event_verification', 'fill_dispatch', 'page_activation', 'target_preparation', 'value_matching']
        .includes(typeof value.fillPhase === 'string' ? value.fillPhase : '')
    )
    && (
      value.fillPreparationStep === undefined ||
      [
        'completed', 'editor_capability', 'editor_validation', 'reference_validation',
        'scope_validation', 'target_state', 'viewport_preparation',
      ].includes(typeof value.fillPreparationStep === 'string' ? value.fillPreparationStep : '')
    )
    && (value.inputEvidence === undefined || isSafeInputEvidence(value.inputEvidence));
}

function retainedAction(value: unknown): NativeControlRecord['retainedAction'] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as {
    selectedTargetId?: unknown;
    documentId?: unknown;
    diagnostic?: unknown;
  };
  if (
    typeof candidate.selectedTargetId !== 'string' ||
    candidate.selectedTargetId.length === 0 ||
    candidate.selectedTargetId.length > 256 ||
    typeof candidate.documentId !== 'string' ||
    candidate.documentId.length === 0 ||
    candidate.documentId.length > 256 ||
    !isRetainedActionDiagnostic(candidate.diagnostic)
  ) {
    return undefined;
  }
  return {
    selectedTargetId: candidate.selectedTargetId,
    documentId: candidate.documentId,
    diagnostic: candidate.diagnostic,
  };
}

function parsedNativeControlRecord(value: unknown): NativeControlRecord | null {
  if (!isRecordWithOnlyKeys(value, [
    'version',
    'kind',
    'browser',
    'state',
    'processId',
    'port',
    'createdAt',
    'selectedTargetId',
    'selectedDocumentId',
    'retainedAction',
  ])) {
    return null;
  }
  const candidate = value as Partial<NativeControlRecord>;
  const valid = candidate.version === 1
    && candidate.kind === 'chromium_cdp'
    && typeof candidate.browser === 'string'
    && (SUPPORTED_BROWSER_PRODUCTS as readonly string[]).includes(candidate.browser)
    && (candidate.state === 'awaiting_user' || candidate.state === 'controlled')
    && Number.isSafeInteger(candidate.processId)
    && (candidate.processId ?? 0) > 0
    && Number.isSafeInteger(candidate.port)
    && (candidate.port ?? 0) >= 1_024
    && (candidate.port ?? 0) <= 65_535
    && isSafeTimestamp(candidate.createdAt)
    && (
      candidate.selectedTargetId === undefined ||
      candidate.selectedTargetId === null ||
      (typeof candidate.selectedTargetId === 'string' && candidate.selectedTargetId.length > 0 && candidate.selectedTargetId.length <= 256)
    )
    && (
      candidate.selectedDocumentId === undefined ||
      candidate.selectedDocumentId === null ||
      (typeof candidate.selectedDocumentId === 'string' && candidate.selectedDocumentId.length > 0 && candidate.selectedDocumentId.length <= 256)
    );
  if (!valid) return null;
  const restoredAction = retainedAction(candidate.retainedAction);
  return {
    version: 1,
    kind: 'chromium_cdp',
    browser: candidate.browser as BrowserProduct,
    state: candidate.state as NativeControlRecord['state'],
    processId: candidate.processId as number,
    port: candidate.port as number,
    createdAt: candidate.createdAt as string,
    ...(candidate.selectedTargetId === undefined ? {} : { selectedTargetId: candidate.selectedTargetId }),
    ...(candidate.selectedDocumentId === undefined ? {} : { selectedDocumentId: candidate.selectedDocumentId }),
    ...(restoredAction === undefined ? {} : { retainedAction: restoredAction }),
  };
}

export async function writeNativeControlRecord(
  profileDir: string,
  record: NativeControlRecord,
): Promise<void> {
  const destination = nativeControlRecordPath(profileDir);
  const temporary = path.join(profileDir, `.${CONTROL_RECORD_NAME}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  await chmod(destination, 0o600);
}

export async function readNativeControlRecord(
  profileDir: string,
  expectedBrowser: BrowserProduct,
): Promise<NativeControlRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(nativeControlRecordPath(profileDir), 'utf8'));
    const record = parsedNativeControlRecord(parsed);
    return record?.browser === expectedBrowser ? record : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

export async function removeNativeControlRecord(profileDir: string): Promise<void> {
  await rm(nativeControlRecordPath(profileDir), { force: true });
}

export function processIsRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
