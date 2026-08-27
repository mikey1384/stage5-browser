import { type BrowserCommandOutput, type BrowserLaunchIdentity, type BrowserLaunchTarget, type ControlKind, type ControlOptionObservation, type ControlPopupAssociationProof, type ControlPopupSurfaceProof, type ElementHandle, type FileInputObservation, type FormFieldObservation, type FormFieldState, type Frame, type HumanBrowserSession, type JSHandle, type Locator, type ObservedScrollContainer, type OwnedProcessObservation, type Page, type PrivateFieldValueType, type ProfileShutdownDecision, type ProfileShutdownInspection, type ProfileStorageInspection, type SafeTargetState, type SanitizedClickDispatchEvidence, type SanitizedNativeWindowActivationEvidence, type SanitizedPageActivationEvidence, type ScrollContentObservation, type SupportedAriaRole } from './dependencies.js';
import type { ViewportPreparationTelemetry } from '../protocol/telemetry.js';

export async function boundedValue<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
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

export interface ObservedSnapshot {
  id: string;
  documentVersion: number;
  scope: 'document' | 'modal';
  scopeHandle: ElementHandle<HTMLElement>;
  refs: Set<string>;
  refSemantics: Map<string, ObservedReferenceSemantic>;
  textEditors: Map<string, ObservedTextEditor>;
  fileInputs: Map<string, ObservedFileInput>;
  scrollContainers: Map<string, ObservedScrollContainer>;
}

export interface ObservedReferenceSemantic {
  role: string;
  name: string;
  url: string | null;
}

export interface ObservedReferenceCapability {
  locator: Locator;
  handle: ElementHandle<HTMLElement | SVGElement>;
  identity: ClickTargetSemanticIdentity;
}

export interface ObservedTextEditor {
  handle: ElementHandle<HTMLElement>;
}

export interface ObservedFileInput {
  handle: ElementHandle<HTMLInputElement>;
  observation: FileInputObservation;
}

export interface ObservedControlOption {
  observation: ControlOptionObservation;
  locator: Locator;
  handle: ElementHandle<HTMLElement>;
  selectedRepresentationObserved?: boolean;
  selectionStateConflict?: boolean;
}

export interface ObservedControlPopupSurface {
  locator: Locator | null;
  handle: ElementHandle<HTMLElement>;
  surfaceProof: ControlPopupSurfaceProof;
}

export type AgentDeclaredPopupOwner =
  | { kind: 'requested_control' }
  | { kind: 'observed_candidate'; role: SupportedAriaRole; name: string };

export interface ObservedPopupOwnerDecision {
  frame: Frame;
  documentVersion: number;
  controlRole: string;
  controlName: string;
  controlExact: boolean;
  ownerRole: SupportedAriaRole;
  ownerName: string;
}

export interface ObservedControlInspection {
  id: string;
  frame: Frame;
  documentVersion: number;
  kind: ControlKind;
  controlRole: string;
  controlName: string;
  controlExact: boolean;
  controlLocator: Locator;
  controlHandle: ElementHandle<HTMLElement>;
  representationScopeHandle?: ElementHandle<HTMLElement>;
  popupSurfaces: ObservedControlPopupSurface[];
  popupAssociationProof: ControlPopupAssociationProof | null;
  agentDeclaredPopupOwner: AgentDeclaredPopupOwner | null;
  multiple: boolean;
  optionsComplete: boolean;
  options: Map<string, ObservedControlOption>;
}

export interface ObservedFormField {
  observation: FormFieldObservation;
  locator: Locator;
  handle: ElementHandle<HTMLElement>;
}

export interface ObservedFormInspection {
  id: string;
  frame: Frame;
  documentVersion: number;
  scope: 'document' | 'modal';
  fields: Map<string, ObservedFormField>;
}

export interface PrivateFieldHandoff {
  id: string;
  page: Page;
  frame: Frame;
  documentVersion: number;
  handle: ElementHandle<HTMLElement>;
  locator: Locator;
  fieldLabel: string;
  valueType: PrivateFieldValueType;
  before: FormFieldState;
  requestedAt: string;
  priorOutline: string;
  priorOutlineOffset: string;
}

export interface LocalFileSelection {
  canonicalPath: string;
  name: string;
  sizeBytes: number;
}

export interface FileInputEventObservation {
  inputEventObserved: boolean;
  changeEventObserved: boolean;
  files: Array<{ name: string; sizeBytes: number }>;
}

export interface ProgressSample {
  visibleCount: number;
  activeCount: number;
  completedCount: number;
  maxPercent: number | null;
}

export interface ScrollHistory {
  dynamicGrowthObserved: boolean;
}

export interface ScrollContentObservationSurface {
  handle: ElementHandle<HTMLElement> | null;
  ownsHandle: boolean;
}

export interface ScrollContentSample extends ScrollContentObservation {
  semanticLoadingIndicatorCount: number;
  genericTextLoadingIndicatorCount: number;
  genericTextLoadingObservationComplete: boolean;
  animationLoadingIndicatorCount: number;
  animationObservationComplete: boolean;
}

export interface AuthenticationHandoff {
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

export interface PendingHandoffRelease {
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

export interface ControlledStartBoundaryObservation {
  targetOrigin: string;
  storage: ProfileStorageInspection;
  targetOriginLoaded: boolean;
  navigatorWebdriver: boolean | null;
}

export interface SnapshotRoot {
  locator: Locator;
  scope: 'document' | 'modal';
  visibleModalCount: number;
  warnings: Array<{
    code: 'ambiguous_visible_modals';
    message: string;
    suggestedAction: string;
  }>;
}

export interface SearchableTextLine {
  line: number;
  text: string;
}

export interface ClickTargetSemanticIdentity {
  tagName: string;
  role: string | null;
  name: string;
  url: string | null;
  owner: {
    fingerprint: string;
    tagName: string;
    role: string | null;
    nestingDepth: number;
  } | null;
}

export interface PreparedObservedClickTarget {
  locator: Locator;
  handle: ElementHandle<HTMLElement | SVGElement>;
  targetState: SafeTargetState;
  activation: 'keyboard_enter' | 'keyboard_space' | 'pointer';
  pageActivation: SanitizedPageActivationEvidence | null;
  viewportPreparation: ViewportPreparationTelemetry | null;
}

export interface ClickViewportMovement {
  moved: boolean;
  horizontalMovement: boolean;
  verticalMovement: boolean;
  surface: 'document' | 'nested' | null;
  composedBoundaryTraversed: boolean;
}

export interface FillTargetDescriptor {
  targetKind: 'contenteditable' | 'input' | 'textarea';
  inputType: string | null;
  enabled: boolean;
}

export type ObservedReferenceResolution =
  | {
      kind: 'resolved';
      locator: Locator;
      handle: ElementHandle<HTMLElement | SVGElement>;
    }
  | { kind: 'ambiguous' | 'missing' | 'scope_changed' | 'timeout' };

export interface ClickDispatchConclusion {
  actionDispatched: boolean | 'unknown';
  clickDispatched: boolean | 'unknown';
}

export type RawClickDispatchEvidence = Omit<
  SanitizedClickDispatchEvidence,
  'forcedFallbackUsed' | 'pageActivation' | 'pageMouseFallbackUsed'
>;

export interface PageActivationObservation {
  documentFocused: boolean | null;
  visibility: SanitizedPageActivationEvidence['visibilityAfter'];
}

export interface ChromiumTargetWindowPreparation {
  targetWindowResolved: boolean;
  windowStateBefore: SanitizedNativeWindowActivationEvidence['windowStateBefore'];
  normalizationAttempted: boolean;
  normalizationSucceeded: boolean | null;
}

export interface ClickDispatchProbeController {
  snapshot: () => RawClickDispatchEvidence;
  finish: () => RawClickDispatchEvidence;
}

export interface InstalledClickDispatchProbe {
  controller: JSHandle<ClickDispatchProbeController>;
  token: string;
}

export interface ExternalClickDispatchObservation {
  page: Page;
  evidence: RawClickDispatchEvidence | null;
}

export type VirtualizedClickResolution =
  | { kind: 'ambiguous' | 'missing' }
  | {
      kind: 'resolved';
      locator: Locator;
      handle: ElementHandle<HTMLElement | SVGElement>;
    };

export const MAX_SEARCHABLE_TEXT_CHARACTERS = 2_000_000;
export const TEXT_SNIPPET_CONTEXT = 100;
export const TEXT_SNIPPET_SURROUNDING_LINES = 2;
export const TEXT_SNIPPET_CONTEXT_SCAN_LINES = 12;
export const TEXT_SNIPPET_CONTEXT_LINE_CHARACTERS = 160;
export const CLICK_REF_VIEWPORT_PREPARATION_TIMEOUT_MS = 5_000;
export const CLICK_REF_INCREMENTAL_SCROLL_STEPS = 32;
export const CLICK_REF_INCREMENTAL_SETTLE_MS = 75;
export const CLICK_REF_REBIND_SETTLE_MS = 500;
export const CLICK_REF_OWNER_TEXT_CHARACTERS = 20_000;
export const CLICK_REF_OWNER_CANDIDATES = 100;
export const CLICK_REF_OWNER_SELECTOR = 'article, [role="article"], tr, [role="row"], li, [role="listitem"]';
export const CLICK_REF_ELEMENT_CANDIDATES = 5_000;
export const CLICK_REF_NORMAL_DISPATCH_TIMEOUT_MS = 750;
export const CLICK_REF_FORCED_DISPATCH_TIMEOUT_MS = 750;
export const CLICK_REF_DISPATCH_PROBE_GRACE_MS = 1_000;
export const TAB_INSPECTION_RESTORE_RESERVE_MS = 1_500;
export const CLICK_ROLE_RESOLUTION_TIMEOUT_MS = 1_000;
export const CLICK_RESULT_FINALIZATION_RESERVE_MS = 500;
export const POPUP_OPTION_ROLES = new Set([
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'treeitem',
]);
export const POPUP_SURFACE_ROLES = new Set([
  'listbox',
  'menu',
  'tree',
]);
export const POPUP_RENDERED_STATE_ROLES = new Set([
  ...POPUP_OPTION_ROLES,
  ...POPUP_SURFACE_ROLES,
]);
export const MAX_POPUP_RENDERED_STATE_CANDIDATES = 100;
export const CONTROL_POPUP_OPTION_SELECTOR = '[role="option"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="treeitem"]';
export const CONTROL_OPTION_SELECTOR = `${CONTROL_POPUP_OPTION_SELECTOR}, [role="radio"]`;
export const CONTROL_POPUP_SELECTOR = '[role="listbox"], [role="menu"], [role="tree"]';
export const MAX_CONTROL_POPUP_OPTION_CANDIDATES = 200;
export const MAX_CONTROL_INSPECTION_SCROLL_STEPS = 16;
export const CONTROL_INSPECTION_SCROLL_SETTLE_MS = 75;
export const FILL_RESULT_FINALIZATION_RESERVE_MS = 750;
export const FILL_REF_VIEWPORT_PREPARATION_TIMEOUT_MS = 500;
export const SCROLL_RESULT_FINALIZATION_RESERVE_MS = 750;
export const HANDOFF_RESULT_FINALIZATION_RESERVE_MS = 500;
export const SCREENSHOT_RENDER_SETTLE_MS = 100;
export const NATIVE_WINDOW_ACTIVATION_TIMEOUT_MS = 1_000;
export const NATIVE_WINDOW_NORMALIZATION_WAIT_MS = 750;
export const NATIVE_WINDOW_VISIBILITY_WAIT_MS = 750;
export const NATIVE_WINDOW_VISIBILITY_POLL_MS = 50;
export const SCREENSHOT_MIN_COMPRESSED_BYTES_PER_PIXEL = 0.01;
export const MAX_FILE_INPUTS_PER_SNAPSHOT = 20;
export const MAX_TEXT_EDITORS_PER_SNAPSHOT = 100;
export const SCROLL_BOUNDARY_EPSILON_PX = 1;

export function clickFinalizationReserve(timeoutMs: number): number {
  return Math.min(
    CLICK_RESULT_FINALIZATION_RESERVE_MS,
    Math.max(50, Math.floor(timeoutMs * 0.15)),
  );
}

export function fillFinalizationReserve(timeoutMs: number): number {
  return Math.min(
    FILL_RESULT_FINALIZATION_RESERVE_MS,
    Math.max(100, Math.floor(timeoutMs * 0.2)),
  );
}

export function scrollFinalizationReserve(timeoutMs: number): number {
  return Math.min(
    SCROLL_RESULT_FINALIZATION_RESERVE_MS,
    Math.max(100, Math.floor(timeoutMs * 0.2)),
  );
}

export function remainingUntil(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

export function remainingHandoffWorkBudget(deadlineAt: number): number {
  const remaining = remainingUntil(deadlineAt);
  const reserve = Math.min(
    HANDOFF_RESULT_FINALIZATION_RESERVE_MS,
    Math.max(25, Math.floor(remaining * 0.15)),
  );
  return Math.max(0, remaining - reserve);
}
