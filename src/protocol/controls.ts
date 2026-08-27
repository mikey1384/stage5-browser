export const SUPPORTED_ARIA_ROLES = [
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menu',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'tree',
  'treeitem',
] as const;

export type SupportedAriaRole = (typeof SUPPORTED_ARIA_ROLES)[number];

export const URL_MATCH_MODES = ['exact', 'prefix', 'contains'] as const;
export type UrlMatchMode = (typeof URL_MATCH_MODES)[number];

export interface UrlExpectation {
  url: string;
  match: UrlMatchMode;
}

export interface VisibleElementExpectation {
  role: SupportedAriaRole;
  name: string;
  exact: boolean;
  frameId: string | null;
}

export interface FileInputObservation {
  ref: string;
  accept: string | null;
  multiple: boolean;
  disabled: boolean;
  visible: boolean;
  label: string | null;
}

export interface FileProcessingExpectation {
  expectedComplete: VisibleElementExpectation | null;
  expectedError: VisibleElementExpectation | null;
  timeoutMs: number;
}

export interface FileSelectionWarning {
  code:
    | 'attachment_preview_unavailable'
    | 'file_input_list_truncated'
    | 'processing_completion_unverified'
    | 'processing_error_observed'
    | 'processing_marker_preexisting'
    | 'progress_disappeared_unverified';
  message: string;
  suggestedAction: string;
}

export interface ClickPostcondition {
  expectedUrl: UrlExpectation | null;
  expectedNewPageUrl?: UrlExpectation | null;
  expectedDownload?: boolean;
  expectedSelected: boolean | null;
  expectedVisible: VisibleElementExpectation | null;
  expectedHidden?: VisibleElementExpectation | null;
  satisfaction?: 'all' | 'any';
  timeoutMs: number;
}

export interface PostconditionCheck {
  kind: 'download' | 'new_page_url' | 'popup_closed' | 'selected' | 'selection_representation' | 'url' | 'visible';
  passed: boolean;
  expected: string | boolean;
  observed: string | boolean | null;
}

export interface PostconditionResult {
  passed: true;
  checks: PostconditionCheck[];
}

export type ControlKind = 'custom_popup' | 'native_select';
export type ControlRevealInteraction = 'auto' | 'keyboard' | 'pointer';
export type ControlRevealMethod = Exclude<ControlRevealInteraction, 'auto'>;
export type ControlPopupAssociationProof = 'active_descendant' | 'explicit' | 'structural' | 'focused' | 'expanded' | 'spatial' | 'agent_declared' | 'post_dispatch_unique';
export type ControlPopupSurfaceProof = 'semantic_role' | 'positioned_option_group';
export interface ControlPopupOwnershipEvidence {
  proofTier: 'expanded' | 'focused' | 'spatial' | 'structural' | 'none';
  candidateCount: number | null;
  exteriorCandidateCount: number | null;
  overlappingCandidateCount: number | null;
  surfaceCoveredCandidateCount: number | null;
  decision: 'covered_siblings_excluded' | 'decisive_distance' | 'missing' | 'single_candidate' | 'structural_conflict' | 'tie_or_near' | 'unbounded';
  targetFirstMiss?: 'competing_structural_owner' | 'insufficient_focus_or_expansion' | 'not_spatial' | 'relation_unavailable' | 'target_unavailable';
}

export interface ControlRecoveryEvidence {
  requestedControlResolution: 'resolved' | 'missing' | 'recovered_observed_owner';
  popupOwnerDecision: 'not_required' | 'required' | 'unavailable' | 'consumed';
  activeCandidateCount: number | null;
  exposedCandidateCount: number | null;
  issuedCapabilityCount: number | null;
  candidatesTruncated: boolean | null;
  requestedControlIsCandidate: boolean | null;
  agentJudgmentAvailable: boolean | null;
}

export interface ControlTarget {
  role: SupportedAriaRole;
  name: string;
  exact: boolean;
}

export type ControlPopupAgentAssociation =
  | {
      owner: 'requested_control';
      basis: 'agent_semantic_judgment';
    }
  | {
      owner: 'observed_candidate';
      ownerCandidateId: string;
      basis: 'agent_semantic_judgment';
    };

export interface ControlOptionTarget {
  name: string;
  exact: boolean;
}

export interface ControlOptionObservation {
  optionId: string;
  name: string;
  role: 'menuitem' | 'menuitemcheckbox' | 'menuitemradio' | 'option' | 'radio' | 'treeitem';
  selected: boolean | null;
  disabled: boolean;
}

export interface ControlOptionsInspection {
  inspectionId: string;
  kind: ControlKind;
  expanded: boolean | null;
  multiple: boolean;
  disabled: boolean;
  options: ControlOptionObservation[];
  optionsComplete: boolean;
  reveal: {
    requested: boolean;
    interactionUsed: ControlRevealMethod | null;
    openerActionDispatched: boolean | 'unknown';
    popupOpened: boolean;
    competingPopupDismissed: boolean;
    preparationActionDispatched: boolean | 'unknown';
    scrollSteps: number;
    boundaryReached: boolean;
    associationProof: ControlPopupAssociationProof | null;
    surfaceProof: ControlPopupSurfaceProof | null;
    renderedPopupCount: number | null;
    popupOwnership: ControlPopupOwnershipEvidence | null;
    controlRecovery: ControlRecoveryEvidence;
  };
  choice: {
    responsibility: 'agent';
    decisionRequired: boolean;
    reason: 'choose_observed_option' | 'no_selectable_options';
  };
}

export interface ControlSelectionEvidence {
  actionDispatched: boolean | 'unknown';
  inputEventObserved: boolean;
  changeEventObserved: boolean;
  selectionEffectObserved: boolean;
  selectedRepresentationObserved: boolean;
  selectedState: boolean | null;
  popupClosed: boolean | null;
  reconciliation: ControlSelectionReconciliationEvidence;
  searchableCommit?: SearchableSelectionEvidence;
}

export type ControlSelectionInteraction = 'auto' | 'observed_option' | 'type_and_enter';
export type ControlSelectionMethod = 'observed_option' | 'searchable_keyboard';
export type SearchableActiveOptionProof = 'aria_activedescendant' | 'focused_linked_option';

export interface SearchableSelectionEvidence {
  queryActionDispatched: boolean | 'unknown';
  activeOptionProof: SearchableActiveOptionProof | null;
  commitActionDispatched: boolean | 'unknown';
  selectionProof: 'selected_state' | 'value_and_popup_closed';
}

export interface ControlSelectionReconciliationEvidence {
  targetResolution: 'retained_exact' | 'retained_scope_after_control_replacement' | 'rebound_exact' | 'unresolved';
  attempts: number;
  durationMs: number;
  terminalProof: 'selected_state' | 'representation_change' | 'popup_closed' | 'unresolved';
}

export interface ControlSelectionSummary {
  outcome: 'succeeded';
  selectionSucceeded: true;
  interactionUsed: ControlSelectionMethod;
  actionDispatched: boolean | 'unknown';
  currentState: {
    requestedSelected: boolean;
    popupOpen: boolean | null;
    multiple: boolean;
  };
  nextAction: 'continue' | 'dismiss_popup' | 'select_more_or_dismiss_popup';
  viableNextMoves: Array<
    | 'continue'
    | 'continue_if_popup_not_obstructing'
    | 'dismiss_with_escape'
    | 'dismiss_with_exact_outside_click'
    | 'select_more_with_fresh_inspection'
  >;
}

export interface ControlMultiSelectionResult {
  optionId: string;
  selectedName: string;
  evidence: ControlSelectionEvidence;
}

export interface FillRefEvidence {
  actionDispatched: boolean | 'unknown';
  inputEventObserved: boolean;
  changeEventObserved: boolean;
  valueMatchedBefore: boolean;
  valueMatches: boolean;
  targetConnectedAfter: boolean;
  targetKind: 'contenteditable' | 'input' | 'textarea';
  inputSurface: 'contenteditable' | 'input' | 'password' | 'textarea';
}

export type NavigationWarningCode =
  'dom_readiness_timeout' | 'http_authentication_required' | 'http_client_error' | 'http_forbidden' | 'http_rate_limited' | 'http_server_error';

export interface NavigationWarning {
  code: NavigationWarningCode;
  message: string;
  status: number | null;
  suggestedAction: string;
}

export interface RedirectHop {
  kind: 'server';
  from: string;
  to: string;
  status: number | null;
}
