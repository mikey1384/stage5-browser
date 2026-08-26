import type { BrowserAvailability, BrowserProduct } from '../browser-provider.js';
import type { Stage5BrowserConfig } from '../config.js';
import type { BrowserDiagnostics } from '../diagnostics.js';
import type { RuntimeProcessInfo } from '../runtime-info.js';
import type { SanitizedPageActivationEvidence } from '../page-diagnostics.js';
import type { AuthenticationStatus } from './authentication.js';
import type { AvailableBrowsers, BrowserStatus, BrowserTabSummary, FrameSummary, PageSummary } from './browser-state.js';
import type { ClickPostcondition, ControlMultiSelectionResult, ControlOptionsInspection, ControlOptionTarget, ControlSelectionEvidence, ControlTarget, FileInputObservation, FillRefEvidence, NavigationWarning, PostconditionResult, RedirectHop, SupportedAriaRole, UrlExpectation, VisibleElementExpectation } from './controls.js';
import type { ScrollContainerObservation, ScrollDirection, ScrollEndState, ScrollPosition, ScrollWaitCondition, ScrollWaitResult } from './scroll.js';
import type { BrowserMotionInput, BrowserMotionOutput } from './motions.js';
import type { CloseTabOutput, NavigateHistoryInput, NavigateHistoryOutput } from './navigation.js';
import type { ApplyFormPlanInput, ApplyFormPlanOutput, FormSummaryInput, FormSummaryOutput, SetCheckedInput, SetCheckedOutput } from './forms.js';
import type { PrivateFieldHandoffStatus, RequestPrivateFieldHandoffInput, RequestPrivateFieldHandoffOutput, ResumePrivateFieldHandoffInput, ResumePrivateFieldHandoffOutput } from './private-field.js';
import type { BrowserActionIntent, BrowserActionPolicyMode, BrowserActionPolicyStatus } from './policy.js';
import type { DownloadListOutput, DownloadObservation, WaitForDownloadInput, WaitForDownloadOutput } from './downloads.js';
import type { BrowserDialogActionResult, BrowserDialogExpectation, BrowserDialogStatus } from './dialogs.js';
import type { PageLifecycleStatus } from './page-lifecycle.js';
import type { SetInputFilesInput, SetInputFilesOutput } from './uploads.js';

export interface BrowserCommandMap {
  initialize: {
    input: {
      config: Stage5BrowserConfig;
      browser: BrowserProduct;
      protocolVersion: number;
      mcpVersion: string;
      mcpBuildFingerprint: string | null;
      buildFingerprintPolicy?: 'diagnostic_only';
      actionPolicyMode: BrowserActionPolicyMode;
      contextScope: 'connection' | 'durable_agent';
    };
    output: { ready: true; workerPid: number; runtime: RuntimeProcessInfo };
  };
  status: {
    input: Record<string, never>;
    output: BrowserStatus;
  };
  start: {
    input: { browser?: BrowserProduct };
    output: BrowserStatus;
  };
  availableBrowsers: {
    input: Record<string, never>;
    output: AvailableBrowsers;
  };
  diagnostics: {
    input: Record<string, never>;
    output: { browser: BrowserDiagnostics; status: BrowserStatus; worker: RuntimeProcessInfo };
  };
  pageEvents: {
    input: { afterSequence: number | null; limit: number };
    output: PageLifecycleStatus;
  };
  switchBrowser: {
    input: { browser: BrowserProduct };
    output: BrowserStatus;
  };
  stop: {
    input: Record<string, never>;
    output: BrowserStatus;
  };
  open: {
    input: { url: string; newTab: boolean; stabilizationMs?: number; timeoutMs: number; dialogResponse?: BrowserDialogExpectation | null };
    output: {
      page: PageSummary;
      requestedUrl: string;
      finalUrl: string;
      responseStatus: number | null;
      readiness: 'commit' | 'domcontentloaded';
      redirected: boolean;
      redirectChain: RedirectHop[];
      observedUrls: string[];
      stabilizationMs: number;
      warnings: NavigationWarning[];
      dialog?: BrowserDialogActionResult;
    };
  };
  navigateHistory: {
    input: NavigateHistoryInput;
    output: NavigateHistoryOutput;
  };
  snapshot: {
    input: { depth: number; boxes: boolean; frameId: string | null; timeoutMs: number };
    output: {
      page: PageSummary;
      frame: FrameSummary;
      snapshotId: string;
      refCount: number;
      fileInputCount: number;
      fileInputs: FileInputObservation[];
      scrollContainerCount: number;
      scrollContainers: ScrollContainerObservation[];
      scope: 'document' | 'modal';
      visibleModalCount: number;
      warnings: Array<{
        code:
          | 'ambiguous_visible_modals'
          | 'file_input_list_truncated'
          | 'scroll_container_list_truncated';
        message: string;
        suggestedAction: string;
      }>;
      snapshot: string;
    };
  };
  screenshot: {
    input: { fullPage: boolean; timeoutMs: number };
    output: {
      page: PageSummary;
      path: string;
      mimeType: 'image/png';
      dataBase64: string;
      captureEvidence: {
        pageActivation: SanitizedPageActivationEvidence;
        pngBytes: number;
        artifactClassification: 'contentful' | 'possibly_uniform';
        semanticContentPresent: boolean;
        retryUsed: boolean;
      };
    };
  };
  tabs: {
    input: Record<string, never>;
    output: { pages: BrowserTabSummary[]; activePageIndex: number | null };
  };
  selectTab: {
    input: { tabId: string };
    output: { page: BrowserTabSummary; authenticationTargetUpdated: boolean };
  };
  activateSelectedPage: {
    input: { timeoutMs: number };
    output: {
      page: BrowserTabSummary;
      activation: SanitizedPageActivationEvidence;
      postcondition: {
        controllerSelected: true;
        rendererVisible: true;
        documentFocused: true;
        nativeApplicationFrontmost: true | null;
      };
    };
  };
  closeTab: {
    input: { tabId: string; timeoutMs: number };
    output: CloseTabOutput;
  };
  inspectTab: {
    input: {
      tabId: string;
      depth: number;
      temporaryActivation: boolean;
      waitFor: { condition: ScrollWaitCondition; timeoutMs: number } | null;
      timeoutMs: number;
    };
    output: {
      page: BrowserTabSummary;
      snapshot: string;
      scope: 'document' | 'modal';
      refCount: 0;
      elementActionsAvailable: false;
      activationAttempted: boolean;
      activationRestored: boolean | null;
      activationRestoreRecoveryUsed: boolean;
      rendererVisibility: 'visible' | 'hidden' | 'unknown';
      rendererVisibilityAfterRestore: 'visible' | 'hidden' | 'unknown';
      loadingWait: ScrollWaitResult | null;
      visibleModalCount: number;
      controllerSelectionUnchanged: boolean;
      warnings: Array<{
        code:
          | 'ambiguous_visible_modals'
          | 'visible_modal_in_document'
          | 'controller_selection_changed_externally'
          | 'loading_expectation_not_satisfied';
        message: string;
        suggestedAction: string;
      }>;
    };
  };
  frames: {
    input: Record<string, never>;
    output: { page: PageSummary; frames: FrameSummary[] };
  };
  clickByRole: {
    input: {
      role: SupportedAriaRole;
      name: string;
      exact: boolean;
      frameId: string | null;
      postcondition: ClickPostcondition | null;
      timeoutMs: number;
      intent?: BrowserActionIntent;
      dialogResponse?: BrowserDialogExpectation | null;
    };
    output: {
      page: PageSummary;
      frame: FrameSummary;
      postcondition: PostconditionResult | null;
      dispatch: { actionDispatched: true | 'unknown'; clickDispatched: true | 'unknown' };
      newPage: BrowserTabSummary | null;
      newPageCount: number;
      newDownload: DownloadObservation | null;
      newDownloadCount: number;
      dialog?: BrowserDialogActionResult;
    };
  };
  clickRef: {
    input: {
      snapshotId: string;
      ref: string;
      frameId: string | null;
      postcondition: ClickPostcondition | null;
      timeoutMs: number;
      intent?: BrowserActionIntent;
      dialogResponse?: BrowserDialogExpectation | null;
    };
    output: {
      page: PageSummary;
      frame: FrameSummary;
      postcondition: PostconditionResult | null;
      dispatch: { actionDispatched: true | 'unknown'; clickDispatched: true | 'unknown' };
      newPage: BrowserTabSummary | null;
      newPageCount: number;
      newDownload: DownloadObservation | null;
      newDownloadCount: number;
      dialog?: BrowserDialogActionResult;
    };
  };
  setInputFiles: {
    input: SetInputFilesInput;
    output: SetInputFilesOutput;
  };
  downloads: {
    input: { limit: number };
    output: DownloadListOutput;
  };
  waitForDownload: {
    input: WaitForDownloadInput;
    output: WaitForDownloadOutput;
  };
  dialogStatus: {
    input: { limit: number };
    output: BrowserDialogStatus;
  };
  fillByRole: {
    input: {
      role: SupportedAriaRole;
      name: string;
      exact: boolean;
      frameId: string | null;
      value: string;
      timeoutMs: number;
      intent?: BrowserActionIntent;
      dialogResponse?: BrowserDialogExpectation | null;
    };
    output: { page: PageSummary; frame: FrameSummary; input: FillRefEvidence; dialog?: BrowserDialogActionResult };
  };
  fillRef: {
    input: {
      snapshotId: string;
      ref: string;
      frameId: string | null;
      value: string;
      timeoutMs: number;
      intent?: BrowserActionIntent;
      dialogResponse?: BrowserDialogExpectation | null;
    };
    output: {
      page: PageSummary;
      frame: FrameSummary;
      input: FillRefEvidence;
      dialog?: BrowserDialogActionResult;
    };
  };
  inspectControl: {
    input: {
      control: ControlTarget;
      frameId: string | null;
      revealOptions: boolean;
      maxOptions: number;
      timeoutMs: number;
      dialogResponse?: BrowserDialogExpectation | null;
    };
    output: {
      page: PageSummary;
      frame: FrameSummary;
      inspection: ControlOptionsInspection;
      dialog?: BrowserDialogActionResult;
    };
  };
  selectOption: {
    input: {
      inspectionId: string | null;
      optionId: string | null;
      control: ControlTarget | null;
      option: ControlOptionTarget | null;
      frameId: string | null;
      timeoutMs: number;
      intent?: BrowserActionIntent;
      dialogResponse?: BrowserDialogExpectation | null;
    };
    output: {
      page: PageSummary;
      frame: FrameSummary;
      inspectionId: string;
      optionId: string;
      selectedName: string;
      kind: ControlOptionsInspection['kind'];
      evidence: ControlSelectionEvidence;
      dialog?: BrowserDialogActionResult;
    };
  };
  selectOptions: {
    input: {
      inspectionId: string | null;
      optionIds: string[] | null;
      control: ControlTarget | null;
      options: ControlOptionTarget[] | null;
      frameId: string | null;
      timeoutMs: number;
      intent?: BrowserActionIntent;
      dialogResponse?: BrowserDialogExpectation | null;
    };
    output: {
      page: PageSummary;
      frame: FrameSummary;
      inspectionId: string;
      kind: ControlOptionsInspection['kind'];
      selectedNames: string[];
      selections: ControlMultiSelectionResult[];
      dialog?: BrowserDialogActionResult;
    };
  };
  formSummary: {
    input: FormSummaryInput;
    output: FormSummaryOutput;
  };
  applyFormPlan: {
    input: ApplyFormPlanInput;
    output: ApplyFormPlanOutput;
  };
  setChecked: {
    input: SetCheckedInput;
    output: SetCheckedOutput;
  };
  motion: {
    input: BrowserMotionInput & { intent?: BrowserActionIntent };
    output: BrowserMotionOutput;
  };
  scroll: {
    input: {
      direction: ScrollDirection;
      amount: 'half_viewport' | 'viewport' | 'document_start' | 'document_end';
      count: number;
      settleMs: number;
      frameId: string | null;
      endMarker: VisibleElementExpectation | null;
      target: { snapshotId: string; ref: string } | null;
      waitFor: { condition: ScrollWaitCondition; timeoutMs: number } | null;
      timeoutMs: number;
      dialogResponse?: BrowserDialogExpectation | null;
    };
    output: {
      page: PageSummary;
      frame: FrameSummary;
      target: { kind: 'document'; ref: null } | { kind: 'container'; ref: string };
      before: ScrollPosition;
      after: ScrollPosition;
      wait: ScrollWaitResult;
      stepsCompleted: number;
      moved: boolean;
      contentGrew: boolean;
      targetBoundaryReached: boolean;
      documentBoundaryReached: boolean;
      nestedScrollContainerCandidateCount: number;
      endReached: boolean;
      endState: ScrollEndState;
      warnings: Array<{
        code:
          | 'content_wait_timed_out'
          | 'dynamic_content_stalled'
          | 'nested_scroll_containers_available'
          | 'scroll_end_unconfirmed'
          | 'scroll_position_unchanged';
        message: string;
        suggestedAction: string;
      }>;
      dialog?: BrowserDialogActionResult;
    };
  };
  findText: {
    input: {
      query: string;
      mode: 'contains' | 'exact_line';
      caseSensitive: boolean;
      maxResults: number;
      frameId: string | null;
      timeoutMs: number;
    };
    output: {
      page: PageSummary;
      frame: FrameSummary;
      query: string;
      matchCount: number;
      returnedCount: number;
      truncated: boolean;
      textTruncated: boolean;
      matches: Array<{ line: number; snippet: string }>;
    };
  };
  waitForUrl: {
    input: { expected: UrlExpectation; timeoutMs: number };
    output: { page: PageSummary; matched: true; expected: UrlExpectation };
  };
  authStatus: {
    input: Record<string, never>;
    output: AuthenticationStatus;
  };
  privateFieldStatus: {
    input: Record<string, never>;
    output: PrivateFieldHandoffStatus;
  };
  requestPrivateFieldHandoff: {
    input: RequestPrivateFieldHandoffInput;
    output: RequestPrivateFieldHandoffOutput;
  };
  resumePrivateFieldHandoff: {
    input: ResumePrivateFieldHandoffInput;
    output: ResumePrivateFieldHandoffOutput;
  };
  policyStatus: {
    input: Record<string, never>;
    output: BrowserActionPolicyStatus;
  };
  setPolicy: {
    input: { mode: BrowserActionPolicyMode };
    output: BrowserActionPolicyStatus;
  };
  requestLoginHandoff: {
    input: { url: string | null; timeoutMs: number };
    output: AuthenticationStatus & {
      userActionRequired: true;
      instructions: string;
    };
  };
  resumeAfterLogin: {
    input: { expected: UrlExpectation | null; timeoutMs: number };
    output: AuthenticationStatus & {
      userActionRequired: false;
      instructions: string;
      verificationPreview: {
        observation: 'bounded_semantic_preview';
        available: boolean;
        depth: number;
        snapshot: string | null;
      };
    };
  };
  testHang: {
    input: Record<string, never>;
    output: never;
  };
}

export type BrowserCommandName = keyof BrowserCommandMap;
export type BrowserCommandInput<Name extends BrowserCommandName> = BrowserCommandMap[Name]['input'];
export type BrowserCommandOutput<Name extends BrowserCommandName> = BrowserCommandMap[Name]['output'];
