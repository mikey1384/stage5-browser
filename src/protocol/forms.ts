import type { FrameSummary, PageSummary } from './browser-state.js';
import type { ControlOptionTarget, ControlTarget, FillRefEvidence } from './controls.js';
import type { BrowserDialogActionResult, BrowserDialogExpectation } from './dialogs.js';
import type { BrowserActionIntent } from './policy.js';

export type FormFieldKind =
  | 'checkbox'
  | 'contenteditable'
  | 'custom_control'
  | 'date'
  | 'file'
  | 'native_select'
  | 'private'
  | 'radio'
  | 'text'
  | 'textarea';

export type RedactedValuePresence = 'empty' | 'not_applicable' | 'not_observed_private' | 'present';

export interface FormFieldState {
  valuePresence: RedactedValuePresence;
  selected: boolean | null;
  valid: boolean | null;
}

export interface FormFieldObservation extends FormFieldState {
  fieldId: string;
  kind: FormFieldKind;
  role: string;
  name: string | null;
  inputType: string | null;
  required: boolean;
  disabled: boolean;
  readOnly: boolean;
  multiple: boolean;
  optionNames: string[];
  selectedOptionNames: string[];
  optionsComplete: boolean;
}

export interface FormFieldResolutionEvidence {
  resolution: 'rebound_exact' | 'retained_exact';
  basis: 'stable_role_name_kind' | 'retained_handle_identity';
  rebindAttempts: 0 | 1;
}

export interface FormFieldRebindingSummary {
  attempted: boolean;
  reboundSteps: number;
  failed: boolean;
}

export interface FormActionObservation {
  role: 'button' | 'link';
  name: string;
  disabled: boolean;
}

export interface FormSummaryInput {
  frameId: string | null;
  maxFields: number;
  maxActions: number;
  timeoutMs: number;
}

export interface FormSummaryOutput {
  page: PageSummary;
  frame: FrameSummary;
  formId: string;
  scope: 'document' | 'modal';
  fields: FormFieldObservation[];
  actions: FormActionObservation[];
  fieldsComplete: boolean;
  actionsComplete: boolean;
  choice: {
    responsibility: 'agent';
    decisionRequired: boolean;
    reason: 'choose_materially_ambiguous_fields' | 'form_structurally_ready';
  };
}

export type FormPlanStep =
  | { kind: 'fill'; fieldId: string; value: string }
  | { kind: 'select'; fieldId: string; option: ControlOptionTarget }
  | { kind: 'set_checked'; fieldId: string; checked: boolean };

export interface FormPlanStepResult {
  index: number;
  fieldId: string;
  kind: FormPlanStep['kind'];
  actionDispatched: boolean | 'unknown';
  alreadySatisfied: boolean;
  fieldResolution: FormFieldResolutionEvidence;
  before: FormFieldState;
  after: FormFieldState;
  inputEvidence?: FillRefEvidence;
}

export interface ApplyFormPlanInput {
  formId: string;
  frameId: string | null;
  steps: FormPlanStep[];
  timeoutMs: number;
  intent?: BrowserActionIntent;
  dialogResponse?: BrowserDialogExpectation | null;
}

export interface ApplyFormPlanOutput {
  page: PageSummary;
  frame: FrameSummary;
  formId: string;
  completedSteps: FormPlanStepResult[];
  actionDispatched: boolean | 'unknown';
  fieldRebinding: FormFieldRebindingSummary;
  requiresFreshSummary: true;
  dialog?: BrowserDialogActionResult;
}

export interface SetCheckedInput {
  formId: string | null;
  fieldId: string | null;
  control: ControlTarget | null;
  checked: boolean;
  frameId: string | null;
  timeoutMs: number;
  intent?: BrowserActionIntent;
  dialogResponse?: BrowserDialogExpectation | null;
}

export interface SetCheckedOutput {
  page: PageSummary;
  frame: FrameSummary;
  checked: boolean;
  alreadySatisfied: boolean;
  actionDispatched: boolean | 'unknown';
  before: FormFieldState;
  after: FormFieldState;
  dialog?: BrowserDialogActionResult;
}
