import type { BrowserCommandName } from './commands.js';

export const BROWSER_ACTION_POLICY_MODES = ['normal', 'review_only'] as const;
export type BrowserActionPolicyMode = (typeof BROWSER_ACTION_POLICY_MODES)[number];

export const BROWSER_ACTION_INTENTS = [
  'accept_terms',
  'account_change',
  'external_communication',
  'financial_transaction',
  'form_edit',
  'inspect',
  'local_validation',
  'navigate',
  'persist_form',
  'submit',
  'unclassified',
] as const;

export type BrowserActionIntent = (typeof BROWSER_ACTION_INTENTS)[number];

export type BrowserPolicyClass =
  | 'allowed_in_review'
  | 'blocked_in_review'
  | 'declared_intent_in_review'
  | 'policy_configuration';

export const REVIEW_SAFE_DECLARED_INTENTS = new Set<BrowserActionIntent>([
  'form_edit',
  'inspect',
  'local_validation',
  'navigate',
]);

export const BROWSER_COMMAND_POLICY = {
  initialize: 'policy_configuration',
  status: 'allowed_in_review',
  start: 'allowed_in_review',
  availableBrowsers: 'allowed_in_review',
  diagnostics: 'allowed_in_review',
  pageEvents: 'allowed_in_review',
  dialogStatus: 'allowed_in_review',
  switchBrowser: 'blocked_in_review',
  stop: 'blocked_in_review',
  open: 'allowed_in_review',
  navigateHistory: 'blocked_in_review',
  snapshot: 'allowed_in_review',
  screenshot: 'allowed_in_review',
  tabs: 'allowed_in_review',
  selectTab: 'allowed_in_review',
  activateSelectedPage: 'allowed_in_review',
  closeTab: 'blocked_in_review',
  inspectTab: 'allowed_in_review',
  frames: 'allowed_in_review',
  clickByRole: 'declared_intent_in_review',
  clickRef: 'declared_intent_in_review',
  setInputFiles: 'blocked_in_review',
  downloads: 'allowed_in_review',
  waitForDownload: 'allowed_in_review',
  fillByRole: 'declared_intent_in_review',
  fillRef: 'declared_intent_in_review',
  inspectControl: 'allowed_in_review',
  selectOption: 'declared_intent_in_review',
  selectOptions: 'declared_intent_in_review',
  formSummary: 'allowed_in_review',
  applyFormPlan: 'declared_intent_in_review',
  setChecked: 'declared_intent_in_review',
  motion: 'declared_intent_in_review',
  scroll: 'allowed_in_review',
  findText: 'allowed_in_review',
  waitForUrl: 'allowed_in_review',
  authStatus: 'allowed_in_review',
  privateFieldStatus: 'allowed_in_review',
  requestPrivateFieldHandoff: 'allowed_in_review',
  resumePrivateFieldHandoff: 'allowed_in_review',
  requestLoginHandoff: 'allowed_in_review',
  resumeAfterLogin: 'allowed_in_review',
  policyStatus: 'policy_configuration',
  setPolicy: 'policy_configuration',
  testHang: 'blocked_in_review',
} as const satisfies Record<BrowserCommandName, BrowserPolicyClass>;

export interface BrowserActionPolicyStatus {
  mode: BrowserActionPolicyMode;
  enforcement: 'deterministic_action_class_with_agent_declared_intent';
  reviewSafeIntents: BrowserActionIntent[];
  reviewBlockedIntents: BrowserActionIntent[];
}
