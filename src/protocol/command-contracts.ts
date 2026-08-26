import type { BrowserCommandName } from './commands.js';

export const BROWSER_ACTION_MANAGERS = [
  'form_manager',
  'dialog_manager',
  'interaction_manager',
  'lifecycle_manager',
  'navigation_manager',
  'perception_manager',
  'private_handoff_manager',
  'policy_manager',
  'recovery_manager',
  'tab_manager',
  'transfer_manager',
] as const;

export type BrowserActionManager = (typeof BROWSER_ACTION_MANAGERS)[number];

export type BrowserPhaseSystem =
  | 'action_phases'
  | 'bounded_reversible_loop'
  | 'form_workflow'
  | 'handoff_state_machine'
  | 'lifecycle_state_machine'
  | 'navigation_state_machine'
  | 'read_only_observation'
  | 'supervisor_recovery';

export interface BrowserCommandContract {
  manager: BrowserActionManager;
  phaseSystem: BrowserPhaseSystem;
  dispatch:
    | 'element_input'
    | 'file_transfer'
    | 'lifecycle_transition'
    | 'navigation'
    | 'none'
    | 'private_boundary'
    | 'reversible_view_state'
    | 'test_only';
  replay:
    | 'bounded_reversible'
    | 'idempotent_observation'
    | 'lifecycle_reconcile'
    | 'never_after_possible_dispatch'
    | 'supervisor_only';
}

export const BROWSER_COMMAND_CONTRACTS = {
  initialize: contract('lifecycle_manager', 'lifecycle_state_machine', 'lifecycle_transition', 'lifecycle_reconcile'),
  status: contract('lifecycle_manager', 'read_only_observation', 'none', 'idempotent_observation'),
  start: contract('lifecycle_manager', 'lifecycle_state_machine', 'lifecycle_transition', 'lifecycle_reconcile'),
  availableBrowsers: contract('lifecycle_manager', 'read_only_observation', 'none', 'idempotent_observation'),
  diagnostics: contract('perception_manager', 'read_only_observation', 'none', 'idempotent_observation'),
  pageEvents: contract('perception_manager', 'read_only_observation', 'none', 'idempotent_observation'),
  dialogStatus: contract('dialog_manager', 'read_only_observation', 'none', 'idempotent_observation'),
  switchBrowser: contract('lifecycle_manager', 'lifecycle_state_machine', 'lifecycle_transition', 'lifecycle_reconcile'),
  stop: contract('lifecycle_manager', 'lifecycle_state_machine', 'lifecycle_transition', 'lifecycle_reconcile'),
  open: contract('navigation_manager', 'navigation_state_machine', 'navigation', 'never_after_possible_dispatch'),
  navigateHistory: contract('navigation_manager', 'navigation_state_machine', 'navigation', 'never_after_possible_dispatch'),
  snapshot: contract('perception_manager', 'read_only_observation', 'none', 'idempotent_observation'),
  screenshot: contract('perception_manager', 'read_only_observation', 'reversible_view_state', 'bounded_reversible'),
  tabs: contract('tab_manager', 'read_only_observation', 'none', 'idempotent_observation'),
  selectTab: contract('tab_manager', 'navigation_state_machine', 'reversible_view_state', 'lifecycle_reconcile'),
  activateSelectedPage: contract('tab_manager', 'bounded_reversible_loop', 'reversible_view_state', 'bounded_reversible'),
  closeTab: contract('tab_manager', 'action_phases', 'lifecycle_transition', 'never_after_possible_dispatch'),
  inspectTab: contract('tab_manager', 'bounded_reversible_loop', 'reversible_view_state', 'bounded_reversible'),
  frames: contract('perception_manager', 'read_only_observation', 'none', 'idempotent_observation'),
  clickByRole: contract('interaction_manager', 'action_phases', 'element_input', 'never_after_possible_dispatch'),
  clickRef: contract('interaction_manager', 'action_phases', 'element_input', 'never_after_possible_dispatch'),
  setInputFiles: contract('transfer_manager', 'action_phases', 'file_transfer', 'never_after_possible_dispatch'),
  downloads: contract('transfer_manager', 'read_only_observation', 'none', 'idempotent_observation'),
  waitForDownload: contract('transfer_manager', 'read_only_observation', 'none', 'idempotent_observation'),
  fillByRole: contract('form_manager', 'action_phases', 'element_input', 'never_after_possible_dispatch'),
  fillRef: contract('form_manager', 'action_phases', 'element_input', 'never_after_possible_dispatch'),
  inspectControl: contract('form_manager', 'action_phases', 'reversible_view_state', 'never_after_possible_dispatch'),
  selectOption: contract('form_manager', 'action_phases', 'element_input', 'never_after_possible_dispatch'),
  selectOptions: contract('form_manager', 'form_workflow', 'element_input', 'never_after_possible_dispatch'),
  formSummary: contract('form_manager', 'read_only_observation', 'none', 'idempotent_observation'),
  applyFormPlan: contract('form_manager', 'form_workflow', 'element_input', 'never_after_possible_dispatch'),
  setChecked: contract('form_manager', 'action_phases', 'element_input', 'never_after_possible_dispatch'),
  motion: contract('interaction_manager', 'action_phases', 'element_input', 'never_after_possible_dispatch'),
  scroll: contract('interaction_manager', 'bounded_reversible_loop', 'reversible_view_state', 'bounded_reversible'),
  findText: contract('perception_manager', 'read_only_observation', 'none', 'idempotent_observation'),
  waitForUrl: contract('navigation_manager', 'read_only_observation', 'none', 'idempotent_observation'),
  authStatus: contract('private_handoff_manager', 'read_only_observation', 'none', 'idempotent_observation'),
  privateFieldStatus: contract('private_handoff_manager', 'read_only_observation', 'none', 'idempotent_observation'),
  requestPrivateFieldHandoff: contract('private_handoff_manager', 'handoff_state_machine', 'private_boundary', 'lifecycle_reconcile'),
  resumePrivateFieldHandoff: contract('private_handoff_manager', 'handoff_state_machine', 'private_boundary', 'lifecycle_reconcile'),
  requestLoginHandoff: contract('private_handoff_manager', 'handoff_state_machine', 'private_boundary', 'lifecycle_reconcile'),
  resumeAfterLogin: contract('private_handoff_manager', 'handoff_state_machine', 'private_boundary', 'lifecycle_reconcile'),
  policyStatus: contract('policy_manager', 'read_only_observation', 'none', 'idempotent_observation'),
  setPolicy: contract('policy_manager', 'lifecycle_state_machine', 'lifecycle_transition', 'lifecycle_reconcile'),
  testHang: contract('recovery_manager', 'supervisor_recovery', 'test_only', 'supervisor_only'),
} as const satisfies Record<BrowserCommandName, BrowserCommandContract>;

function contract(
  manager: BrowserActionManager,
  phaseSystem: BrowserPhaseSystem,
  dispatch: BrowserCommandContract['dispatch'],
  replay: BrowserCommandContract['replay'],
): BrowserCommandContract {
  return { manager, phaseSystem, dispatch, replay };
}

export function browserCommandContract(command: BrowserCommandName): BrowserCommandContract {
  return BROWSER_COMMAND_CONTRACTS[command];
}
