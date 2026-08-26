import type { PageSummary } from './browser-state.js';
import type { ControlTarget } from './controls.js';
import type { FormFieldState } from './forms.js';

export const PRIVATE_FIELD_VALUE_TYPES = [
  'address',
  'credential',
  'government_identifier',
  'identity_document',
  'one_time_code',
  'payment_information',
  'phone_number',
  'tax_identifier',
  'other_private_value',
] as const;

export type PrivateFieldValueType = (typeof PRIVATE_FIELD_VALUE_TYPES)[number];

export type PrivateFieldTarget =
  | { kind: 'form_field'; formId: string; fieldId: string }
  | { kind: 'control'; control: ControlTarget };

export interface PrivateFieldHandoffStatus {
  controlMode: 'agent' | 'private_field';
  state: 'awaiting_user' | 'inactive';
  handoffId: string | null;
  fieldLabel: string | null;
  valueType: PrivateFieldValueType | null;
  requestedAt: string | null;
}

export interface RequestPrivateFieldHandoffInput {
  target: PrivateFieldTarget;
  valueType: PrivateFieldValueType;
  frameId: string | null;
  timeoutMs: number;
}

export interface RequestPrivateFieldHandoffOutput extends PrivateFieldHandoffStatus {
  controlMode: 'private_field';
  state: 'awaiting_user';
  handoffId: string;
  fieldLabel: string;
  valueType: PrivateFieldValueType;
  requestedAt: string;
  page: PageSummary;
  instructions: string;
}

export interface ResumePrivateFieldHandoffInput {
  handoffId: string;
  timeoutMs: number;
}

export interface ResumePrivateFieldHandoffOutput extends PrivateFieldHandoffStatus {
  controlMode: 'agent';
  state: 'inactive';
  outcome: 'completed' | 'target_changed' | 'unchanged' | 'validation_error' | 'unverifiable_change';
  page: PageSummary;
  fieldLabel: string;
  valueType: PrivateFieldValueType;
  before: FormFieldState;
  after: FormFieldState | null;
  validationMessagePresent: boolean | null;
  instructions: string;
}
