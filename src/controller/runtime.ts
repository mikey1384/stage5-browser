import { type AuthenticationBoundaryOutcome, type Browser, type BrowserContext, type BrowserLaunchIdentity, type BrowserLifecycleState, type BrowserProduct, type Frame, type HumanBrowserLauncher, inspectChromiumProfileOwner, inspectControlledProfileStorage, inspectProfileStorage, inspectRuntimeProfile, type LaunchFailureDiagnostic, type NativeControlRecord, NativeHumanBrowserLauncher, NativeOwnedBrowserWindowActivator, type OwnedBrowserWindowActivator, type OwnedProcessObservation, type Page, PageDiagnosticBuffer, path, ProfileOwnershipLeaseController, randomUUID, type RuntimeProfileObservation, type SafeTargetState, type SanitizedActionDiagnostic, type SanitizedClickDispatchEvidence, type Stage5BrowserConfig, type WorkerCommandTelemetry } from './dependencies.js';
import { ActionPhaseManager } from './action/phase-manager.js';
import { clickExecutorOperations, type ClickExecutorOperations } from './action/click-executor.js';
import { type AuthenticationHandoff, type ClickDispatchConclusion, type ControlledStartBoundaryObservation, type ExternalClickDispatchObservation, type ObservedFormInspection, type ObservedSnapshot, type PendingHandoffRelease, type PrivateFieldHandoff, type ScrollHistory } from './model.js';
import { lifecycleStartOperations, type LifecycleStartOperations } from './lifecycle/start.js';
import { lifecycleAvailabilityOperations, type LifecycleAvailabilityOperations } from './lifecycle/availability.js';
import { lifecycleStateOperations, type LifecycleStateOperations } from './lifecycle/state.js';
import { observationPageOperations, type ObservationPageOperations } from './observation/page.js';
import { observationTabsOperations, type ObservationTabsOperations } from './observation/tabs.js';
import { inputActionsOperations, type InputActionsOperations } from './input/actions.js';
import { inputFilesOperations, type InputFilesOperations } from './input/files.js';
import { inputFillOperations, type InputFillOperations } from './input/fill.js';
import { inputFillEvidenceOperations, type InputFillEvidenceOperations } from './input/fill-evidence.js';
import { scrollActionOperations, type ScrollActionOperations } from './scroll/action.js';
import { observationTextOperations, type ObservationTextOperations } from './observation/text.js';
import { navigationWaitOperations, type NavigationWaitOperations } from './navigation/wait.js';
import { handoffRequestOperations, type HandoffRequestOperations } from './handoff/request.js';
import { handoffReleaseOperations, type HandoffReleaseOperations } from './handoff/release.js';
import { handoffResumeOperations, type HandoffResumeOperations } from './handoff/resume.js';
import { handoffDurableOperations, type HandoffDurableOperations } from './handoff/durable.js';
import { lifecycleOwnershipOperations, type LifecycleOwnershipOperations } from './lifecycle/ownership.js';
import { lifecycleNativeAttachOperations, type LifecycleNativeAttachOperations } from './lifecycle/native-attach.js';
import { lifecycleContextOperations, type LifecycleContextOperations } from './lifecycle/context.js';
import { observationSnapshotInputsOperations, type ObservationSnapshotInputsOperations } from './observation/snapshot-inputs.js';
import { observationStateOperations, type ObservationStateOperations } from './observation/state.js';
import { inputPostconditionsOperations, type InputPostconditionsOperations } from './input/postconditions.js';
import { inputFileProcessingOperations, type InputFileProcessingOperations } from './input/file-processing.js';
import { navigationUrlOperations, type NavigationUrlOperations } from './navigation/url.js';
import { scrollHelpersOperations, type ScrollHelpersOperations } from './scroll/helpers.js';
import { handoffHelpersOperations, type HandoffHelpersOperations } from './handoff/helpers.js';
import { observationTabModelOperations, type ObservationTabModelOperations } from './observation/tab-model.js';
import { inputClickTargetOperations, type InputClickTargetOperations } from './input/click-target.js';
import { inputClickReferenceOperations, type InputClickReferenceOperations } from './input/click-reference.js';
import { inputClickDispatchOperations, type InputClickDispatchOperations } from './input/click-dispatch.js';
import { inputActivationOperations, type InputActivationOperations } from './input/activation.js';
import { inputHitTestingOperations, type InputHitTestingOperations } from './input/hit-testing.js';
import { inputClickFailureOperations, type InputClickFailureOperations } from './input/click-failure.js';
import { inputVirtualizationOperations, type InputVirtualizationOperations } from './input/virtualization.js';
import { inputDiagnosticsOperations, type InputDiagnosticsOperations } from './input/diagnostics.js';
import { controlCapabilityOperations, type ControlCapabilityOperations } from './controls/capabilities.js';
import { controlOptionOperations, type ControlOptionOperations } from './controls/options.js';
import { controlInspectionOperations, type ControlInspectionOperations } from './controls/inspection.js';
import { controlSelectionOperations, type ControlSelectionOperations } from './controls/selection.js';
import { observationTabActivationOperations, type ObservationTabActivationOperations } from './observation/tab-activation.js';
import { interactionMotionTargetOperations, type InteractionMotionTargetOperations } from './interaction/motion-target.js';
import { interactionMotionProbeOperations, type InteractionMotionProbeOperations } from './interaction/motion-probe.js';
import { interactionMotionOperations, type InteractionMotionOperations } from './interaction/motion.js';
import { navigationHistoryOperations, type NavigationHistoryOperations } from './navigation/history.js';
import { observationTabCloseOperations, type ObservationTabCloseOperations } from './observation/tab-close.js';
import { formCapabilityOperations, type FormCapabilityOperations } from './forms/capabilities.js';
import { formSummaryOperations, type FormSummaryOperations } from './forms/summary.js';
import { formFieldFillOperations, type FormFieldFillOperations } from './forms/field-fill.js';
import { formFieldSelectOperations, type FormFieldSelectOperations } from './forms/field-select.js';
import { formFieldCheckOperations, type FormFieldCheckOperations } from './forms/field-check.js';
import { formPlanOperations, type FormPlanOperations } from './forms/plan.js';
import { FormWorkflowManager } from './forms/workflow-manager.js';
import { privateFieldHandoffOperations, type PrivateFieldHandoffOperations } from './handoff/private-field.js';
import { BrowserActionPolicyManager } from './policy/manager.js';
import { actionPolicyOperations, type ActionPolicyOperations } from './policy/actions.js';
import { BrowserDownloadManager } from './transfers/download-manager.js';
import { downloadOperations, type DownloadOperations } from './transfers/downloads.js';
import { BrowserDialogManager } from './dialogs/manager.js';
import { dialogOperations, type DialogOperations } from './dialogs/actions.js';
import { popupPreparationOperations, type PopupPreparationOperations } from './controls/popup-preparation.js';
import { controlRevealOperations, type ControlRevealOperations } from './controls/reveal.js';
import { controlMultiSelectionOperations, type ControlMultiSelectionOperations } from './controls/multi-selection.js';
import { BrowserPageLifecycleManager, pageLifecycleOperations, type PageLifecycleOperations } from './lifecycle/page-events.js';
export interface BrowserControllerContext extends
  LifecycleStartOperations,
  LifecycleAvailabilityOperations,
  LifecycleStateOperations,
  ObservationPageOperations,
  ObservationTabsOperations,
  ClickExecutorOperations,
  InputActionsOperations,
  InputFilesOperations,
  InputFillOperations,
  InputFillEvidenceOperations,
  ScrollActionOperations,
  ObservationTextOperations,
  NavigationWaitOperations,
  HandoffRequestOperations,
  HandoffReleaseOperations,
  HandoffResumeOperations,
  HandoffDurableOperations,
  LifecycleOwnershipOperations,
  LifecycleNativeAttachOperations,
  LifecycleContextOperations,
  ObservationSnapshotInputsOperations,
  ObservationStateOperations,
  InputPostconditionsOperations,
  InputFileProcessingOperations,
  NavigationUrlOperations,
  ScrollHelpersOperations,
  HandoffHelpersOperations,
  ObservationTabModelOperations,
  InputClickTargetOperations,
  InputClickReferenceOperations,
  InputClickDispatchOperations,
  InputActivationOperations,
  InputHitTestingOperations,
  InputClickFailureOperations,
  InputVirtualizationOperations,
  InputDiagnosticsOperations,
  ControlCapabilityOperations,
  ControlOptionOperations,
  ControlInspectionOperations,
  ControlSelectionOperations,
  ControlMultiSelectionOperations,
  ObservationTabActivationOperations,
  InteractionMotionTargetOperations,
  InteractionMotionProbeOperations,
  InteractionMotionOperations,
  NavigationHistoryOperations,
  ObservationTabCloseOperations,
  FormCapabilityOperations,
  FormSummaryOperations,
  FormFieldFillOperations,
  FormFieldSelectOperations,
  FormFieldCheckOperations,
  FormPlanOperations,
  PrivateFieldHandoffOperations,
  ActionPolicyOperations,
  DownloadOperations,
  DialogOperations,
  PopupPreparationOperations,
  ControlRevealOperations,
  PageLifecycleOperations {
  context: BrowserContext | undefined;
  activePage: Page | undefined;
  state: BrowserLifecycleState;
  lastKnownUrl: string | null;
  selectedBrowser: BrowserProduct;
  frameIds: WeakMap<Frame, string>;
  framesById: Map<string, Frame>;
  tabIds: WeakMap<Page, string>;
  observedTabsById: Map<string, Page>;
  frameDocumentVersions: WeakMap<Frame, number>;
  observedSnapshots: Map<Frame, ObservedSnapshot>;
  scrollHistories: WeakMap<Frame, ScrollHistory>;
  pageDiagnostics: PageDiagnosticBuffer;
  boundPages: WeakSet<Page>;
  lastLaunchFailure: LaunchFailureDiagnostic | null;
  authenticationHandoff: AuthenticationHandoff | null;
  pendingHandoffRelease: PendingHandoffRelease | null;
  lastHandoffOutcome: AuthenticationBoundaryOutcome | null;
  controlledLaunchIdentity: BrowserLaunchIdentity | null;
  runtimeProfileObservation: RuntimeProfileObservation | null;
  controlledStartBoundary: ControlledStartBoundaryObservation | null;
  nativeAttachedBrowser: Browser | undefined;
  nativeControlRecord: NativeControlRecord | null;
  controlledBrowserProcessId: number | null;
  controlledBrowserProcess: OwnedProcessObservation | null;
  ownershipLease: ProfileOwnershipLeaseController;
  clickDispatchBindingName: string;
  clickDispatchBindings: WeakSet<Page>;
  externalClickDispatchObservations: Map<string, ExternalClickDispatchObservation>;
  actionPhases: ActionPhaseManager;
  controlInspections: Map<string, import('./model.js').ObservedControlInspection>;
  formInspections: Map<string, ObservedFormInspection>;
  formWorkflows: FormWorkflowManager;
  privateFieldHandoff: PrivateFieldHandoff | null;
  actionPolicy: BrowserActionPolicyManager;
  downloadManager: BrowserDownloadManager;
  dialogManager: BrowserDialogManager;
  pageLifecycleManager: BrowserPageLifecycleManager;
  config: Stage5BrowserConfig;
  humanBrowserLauncher: HumanBrowserLauncher;
  profileStorageInspector: typeof inspectProfileStorage;
  controlledProfileStorageInspector: typeof inspectControlledProfileStorage;
  runtimeProfileInspector: typeof inspectRuntimeProfile;
  nativeWindowActivator: OwnedBrowserWindowActivator;
  profileOwnerInspector: typeof inspectChromiumProfileOwner;
  failClickBeforeDispatch(
    page: Page,
    startedAt: string,
    targetState: SafeTargetState | null,
    diagnosticReason: SanitizedActionDiagnostic['reason'],
    reason: string,
    message: string,
    suggestedAction: string,
    code?: 'AMBIGUOUS_TARGET' | 'OPERATION_FAILED' | 'TARGET_NOT_FOUND',
    action?: SanitizedActionDiagnostic['action'],
    extraDetails?: Readonly<Record<string, unknown>> | null,
  ): never;
  failVirtualizedClickRebind(
    page: Page,
    startedAt: string,
    result: 'ambiguous' | 'missing',
    priorTargetState: SafeTargetState,
  ): never;
  throwObservedClickDispatchFailure(
    page: Page,
    error: unknown,
    targetState: SafeTargetState | null,
    startedAt: string,
    evidence: SanitizedClickDispatchEvidence | null,
    action: SanitizedActionDiagnostic['action'],
    conclusion?: ClickDispatchConclusion | null,
  ): never;
}

export interface BrowserController extends
  LifecycleStartOperations,
  LifecycleAvailabilityOperations,
  LifecycleStateOperations,
  ObservationPageOperations,
  ObservationTabsOperations,
  ClickExecutorOperations,
  InputActionsOperations,
  InputFilesOperations,
  InputFillOperations,
  InputFillEvidenceOperations,
  ScrollActionOperations,
  ObservationTextOperations,
  NavigationWaitOperations,
  HandoffRequestOperations,
  HandoffReleaseOperations,
  HandoffResumeOperations,
  HandoffDurableOperations,
  LifecycleOwnershipOperations,
  LifecycleNativeAttachOperations,
  LifecycleContextOperations,
  ObservationSnapshotInputsOperations,
  ObservationStateOperations,
  InputPostconditionsOperations,
  InputFileProcessingOperations,
  NavigationUrlOperations,
  ScrollHelpersOperations,
  HandoffHelpersOperations,
  ObservationTabModelOperations,
  InputClickTargetOperations,
  InputClickReferenceOperations,
  InputClickDispatchOperations,
  InputActivationOperations,
  InputHitTestingOperations,
  InputClickFailureOperations,
  InputVirtualizationOperations,
  InputDiagnosticsOperations,
  ControlCapabilityOperations,
  ControlOptionOperations,
  ControlInspectionOperations,
  ControlSelectionOperations,
  ControlMultiSelectionOperations,
  ObservationTabActivationOperations,
  InteractionMotionTargetOperations,
  InteractionMotionProbeOperations,
  InteractionMotionOperations,
  NavigationHistoryOperations,
  ObservationTabCloseOperations,
  FormCapabilityOperations,
  FormSummaryOperations,
  FormFieldFillOperations,
  FormFieldSelectOperations,
  FormFieldCheckOperations,
  FormPlanOperations,
  PrivateFieldHandoffOperations,
  ActionPolicyOperations,
  DownloadOperations,
  DialogOperations,
  PopupPreparationOperations,
  ControlRevealOperations,
  PageLifecycleOperations {}

export class BrowserController {
  private context: BrowserContext | undefined;
  private activePage: Page | undefined;
  private state: BrowserLifecycleState = 'stopped';
  private lastKnownUrl: string | null = null;
  private selectedBrowser: BrowserProduct;
  private frameIds = new WeakMap<Frame, string>();
  private readonly framesById = new Map<string, Frame>();
  private tabIds = new WeakMap<Page, string>();
  private readonly observedTabsById = new Map<string, Page>();
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
  private readonly actionPhases = new ActionPhaseManager();
  private readonly controlInspections = new Map<string, import('./model.js').ObservedControlInspection>();
  private readonly formInspections = new Map<string, ObservedFormInspection>();
  private readonly formWorkflows = new FormWorkflowManager();
  private privateFieldHandoff: PrivateFieldHandoff | null = null;
  private readonly actionPolicy = new BrowserActionPolicyManager();
  private readonly downloadManager: BrowserDownloadManager;
  private readonly dialogManager: BrowserDialogManager;
  private readonly pageLifecycleManager: BrowserPageLifecycleManager;

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
    this.downloadManager = new BrowserDownloadManager(path.join(config.artifactsDir, 'downloads'));
    this.dialogManager = new BrowserDialogManager(config.artifactsDir);
    this.pageLifecycleManager = new BrowserPageLifecycleManager(config.artifactsDir);
  }

  drainActionPhaseTelemetry(): WorkerCommandTelemetry {
    return {
      actionPhases: this.actionPhases.drainCompleted().map((snapshot) => ({
        action: snapshot.action,
        startedAtMs: snapshot.startedAtMs,
        deadlineAtMs: snapshot.deadlineAtMs,
        transitions: snapshot.transitions.map((transition) => ({ ...transition })),
        dispatchState: snapshot.dispatchState,
        dispatchAttempts: snapshot.dispatchAttempts,
        recovery: snapshot.recovery === null ? null : { ...snapshot.recovery },
        viewportPreparation: snapshot.viewportPreparation === null ? null : { ...snapshot.viewportPreparation },
        terminalOutcome: snapshot.terminalOutcome,
        completedAtMs: snapshot.completedAtMs,
      })),
    };
  }
}

function installOperations(
  prototype: object,
  operations: Readonly<Record<string, unknown>>,
): void {
  for (const [name, implementation] of Object.entries(operations)) {
    Object.defineProperty(prototype, name, {
      configurable: true,
      enumerable: false,
      value: implementation,
      writable: true,
    });
  }
}

for (const operations of [
  lifecycleStartOperations,
  lifecycleAvailabilityOperations,
  lifecycleStateOperations,
  observationPageOperations,
  observationTabsOperations,
  clickExecutorOperations,
  inputActionsOperations,
  inputFilesOperations,
  inputFillOperations,
  inputFillEvidenceOperations,
  scrollActionOperations,
  observationTextOperations,
  navigationWaitOperations,
  handoffRequestOperations,
  handoffReleaseOperations,
  handoffResumeOperations,
  handoffDurableOperations,
  lifecycleOwnershipOperations,
  lifecycleNativeAttachOperations,
  lifecycleContextOperations,
  observationSnapshotInputsOperations,
  observationStateOperations,
  inputPostconditionsOperations,
  inputFileProcessingOperations,
  navigationUrlOperations,
  scrollHelpersOperations,
  handoffHelpersOperations,
  observationTabModelOperations,
  inputClickTargetOperations,
  inputClickReferenceOperations,
  inputClickDispatchOperations,
  inputActivationOperations,
  inputHitTestingOperations,
  inputClickFailureOperations,
  inputVirtualizationOperations,
  inputDiagnosticsOperations,
  controlCapabilityOperations,
  controlOptionOperations,
  controlInspectionOperations,
  controlSelectionOperations,
  controlMultiSelectionOperations,
  observationTabActivationOperations,
  interactionMotionTargetOperations,
  interactionMotionProbeOperations,
  interactionMotionOperations,
  navigationHistoryOperations,
  observationTabCloseOperations,
  formCapabilityOperations,
  formSummaryOperations,
  formFieldFillOperations,
  formFieldSelectOperations,
  formFieldCheckOperations,
  formPlanOperations,
  privateFieldHandoffOperations,
  actionPolicyOperations,
  downloadOperations,
  dialogOperations,
  popupPreparationOperations,
  controlRevealOperations,
  pageLifecycleOperations,
]) {
  installOperations(BrowserController.prototype, operations);
}
