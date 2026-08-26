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
  kind:
    | 'download'
    | 'new_page_url'
    | 'popup_closed'
    | 'selected'
    | 'selection_representation'
    | 'url'
    | 'visible';
  passed: boolean;
  expected: string | boolean;
  observed: string | boolean | null;
}

export interface PostconditionResult {
  passed: true;
  checks: PostconditionCheck[];
}

export type ControlKind = 'custom_popup' | 'native_select';

export interface ControlTarget {
  role: SupportedAriaRole;
  name: string;
  exact: boolean;
}

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
    openerActionDispatched: boolean | 'unknown';
    popupOpened: boolean;
    competingPopupDismissed: boolean;
    preparationActionDispatched: boolean | 'unknown';
    scrollSteps: number;
    boundaryReached: boolean;
    associationProof:
      | 'explicit'
      | 'structural'
      | 'focused'
      | 'expanded'
      | 'spatial'
      | 'post_dispatch_unique'
      | null;
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
}

export type NavigationWarningCode =
  | 'dom_readiness_timeout'
  | 'http_authentication_required'
  | 'http_client_error'
  | 'http_forbidden'
  | 'http_rate_limited'
  | 'http_server_error';

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
