import type { BrowserCommandName } from './commands.js';

export const BROWSER_ACTION_MANAGERS = [
  'form_manager',
  'dialog_manager',
  'interaction_manager',
  'lifecycle_manager',
  'navigation_manager',
  'perception_manager',
  'planning_manager',
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

export const BROWSER_MOVE_PREREQUISITES = [
  'agent_control',
  'authentication_awaiting_user',
  'authentication_release_pending',
  'browser_running',
  'browser_stopped',
  'control_inspection',
  'file_input_ref',
  'form_inspection',
  'observed_tabs',
  'private_field_handoff',
  'scroll_container_ref',
  'selected_page',
  'semantic_snapshot',
  'snapshot_ref',
  'text_editor_ref',
] as const;

export type BrowserMovePrerequisite = (typeof BROWSER_MOVE_PREREQUISITES)[number];
export type BrowserMoveRequirementGroups = readonly (readonly BrowserMovePrerequisite[])[];

export interface BrowserCommandContract {
  manager: BrowserActionManager;
  techniques: readonly string[];
  requirementGroups: BrowserMoveRequirementGroups;
  techniqueRequirementGroups: Readonly<Record<string, BrowserMoveRequirementGroups>>;
  missingPrerequisitePolicy: 'prepare_when_safe' | 'not_meaningful';
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

const NONE: BrowserMoveRequirementGroups = [];
const AGENT: BrowserMoveRequirementGroups = [['agent_control']];
const RUNNING: BrowserMoveRequirementGroups = [...AGENT, ['browser_running']];
const PAGE: BrowserMoveRequirementGroups = [...RUNNING, ['selected_page']];
const TABS: BrowserMoveRequirementGroups = [...RUNNING, ['observed_tabs']];

export const BROWSER_COMMAND_CONTRACTS = {
  initialize: contract('lifecycle_manager', ['restore_agent_backend_context'], 'lifecycle_state_machine', 'lifecycle_transition', 'lifecycle_reconcile'),
  availableMoves: contract('planning_manager', ['enumerate_viable_moves', 'explain_move_requirements'], 'read_only_observation', 'none', 'idempotent_observation'),
  status: contract('lifecycle_manager', ['status'], 'read_only_observation', 'none', 'idempotent_observation'),
  start: contract('lifecycle_manager', ['start_profile'], 'lifecycle_state_machine', 'lifecycle_transition', 'lifecycle_reconcile', [...AGENT, ['browser_stopped']]),
  availableBrowsers: contract('lifecycle_manager', ['preflight_backend'], 'read_only_observation', 'none', 'idempotent_observation', AGENT),
  diagnostics: contract('perception_manager', ['diagnostics'], 'read_only_observation', 'none', 'idempotent_observation', AGENT),
  pageEvents: contract('perception_manager', ['page_lifecycle_events'], 'read_only_observation', 'none', 'idempotent_observation', AGENT),
  dialogStatus: contract('dialog_manager', ['inspect_dialog_history'], 'read_only_observation', 'none', 'idempotent_observation', AGENT),
  switchBrowser: contract('lifecycle_manager', ['switch_profile'], 'lifecycle_state_machine', 'lifecycle_transition', 'lifecycle_reconcile', RUNNING, {}, 'not_meaningful'),
  stop: contract('lifecycle_manager', ['stop_profile'], 'lifecycle_state_machine', 'lifecycle_transition', 'lifecycle_reconcile', RUNNING, {}, 'not_meaningful'),
  open: contract('navigation_manager', ['open_url', 'open_new_tab'], 'navigation_state_machine', 'navigation', 'never_after_possible_dispatch', RUNNING),
  navigateHistory: contract('navigation_manager', ['back', 'forward', 'reload'], 'navigation_state_machine', 'navigation', 'never_after_possible_dispatch', PAGE),
  snapshot: contract('perception_manager', ['semantic_snapshot'], 'read_only_observation', 'none', 'idempotent_observation', PAGE),
  screenshot: contract('perception_manager', ['screenshot'], 'read_only_observation', 'reversible_view_state', 'bounded_reversible', PAGE),
  tabs: contract('tab_manager', ['list_tabs'], 'read_only_observation', 'none', 'idempotent_observation', RUNNING),
  selectTab: contract('tab_manager', ['select_tab'], 'navigation_state_machine', 'reversible_view_state', 'lifecycle_reconcile', TABS),
  activateSelectedPage: contract('tab_manager', ['activate_selected_page'], 'bounded_reversible_loop', 'reversible_view_state', 'bounded_reversible', PAGE),
  closeTab: contract('tab_manager', ['close_exact_tab'], 'action_phases', 'lifecycle_transition', 'never_after_possible_dispatch', TABS),
  inspectTab: contract('tab_manager', ['inspect_tab_passively', 'temporarily_activate_and_restore'], 'bounded_reversible_loop', 'reversible_view_state', 'bounded_reversible', TABS),
  frames: contract('perception_manager', ['list_frames'], 'read_only_observation', 'none', 'idempotent_observation', PAGE),
  clickByRole: contract('interaction_manager', ['click'], 'action_phases', 'element_input', 'never_after_possible_dispatch', PAGE),
  clickRef: contract('interaction_manager', ['click'], 'action_phases', 'element_input', 'never_after_possible_dispatch', [...PAGE, ['semantic_snapshot'], ['snapshot_ref']]),
  setInputFiles: contract('transfer_manager', ['set_observed_file_input', 'observe_upload_processing'], 'action_phases', 'file_transfer', 'never_after_possible_dispatch', [...PAGE, ['semantic_snapshot'], ['file_input_ref']]),
  downloads: contract('transfer_manager', ['restore_download_manifest'], 'read_only_observation', 'none', 'idempotent_observation', AGENT),
  waitForDownload: contract('transfer_manager', ['wait_for_download'], 'read_only_observation', 'none', 'idempotent_observation', RUNNING, {}, 'not_meaningful'),
  fillByRole: contract('form_manager', ['fill_text', 'fill_date'], 'action_phases', 'element_input', 'never_after_possible_dispatch', PAGE),
  fillRef: contract('form_manager', ['fill_text', 'fill_date'], 'action_phases', 'element_input', 'never_after_possible_dispatch', [...PAGE, ['semantic_snapshot'], ['text_editor_ref']]),
  inspectControl: contract('form_manager', ['inspect_options', 'declare_popup_owner_from_observed_candidates'], 'action_phases', 'reversible_view_state', 'never_after_possible_dispatch', PAGE),
  selectOption: contract('form_manager', ['set_option_state'], 'action_phases', 'element_input', 'never_after_possible_dispatch', PAGE),
  selectOptions: contract('form_manager', ['select_multiple_options'], 'form_workflow', 'element_input', 'never_after_possible_dispatch', PAGE),
  formSummary: contract('form_manager', ['summarize_form'], 'read_only_observation', 'none', 'idempotent_observation', PAGE),
  applyFormPlan: contract('form_manager', ['apply_staged_plan'], 'form_workflow', 'element_input', 'never_after_possible_dispatch', [...PAGE, ['form_inspection']]),
  setChecked: contract('form_manager', ['set_checked'], 'action_phases', 'element_input', 'never_after_possible_dispatch', PAGE),
  motion: contract('interaction_manager', ['hover', 'focus', 'press_key', 'double_click', 'context_click', 'drag_and_drop'], 'action_phases', 'element_input', 'never_after_possible_dispatch', PAGE),
  scroll: contract('interaction_manager', ['scroll_document', 'scroll_observed_container'], 'bounded_reversible_loop', 'reversible_view_state', 'bounded_reversible', PAGE, {
    scroll_observed_container: [['scroll_container_ref']],
  }),
  findText: contract('perception_manager', ['find_rendered_text'], 'read_only_observation', 'none', 'idempotent_observation', PAGE),
  waitForUrl: contract('navigation_manager', ['wait_for_url'], 'read_only_observation', 'none', 'idempotent_observation', PAGE),
  authStatus: contract('private_handoff_manager', ['inspect_authentication_handoff'], 'read_only_observation', 'none', 'idempotent_observation'),
  privateFieldStatus: contract('private_handoff_manager', ['inspect_private_field_handoff'], 'read_only_observation', 'none', 'idempotent_observation'),
  requestPrivateFieldHandoff: contract('private_handoff_manager', ['field_scoped_private_input'], 'handoff_state_machine', 'private_boundary', 'lifecycle_reconcile', PAGE),
  resumePrivateFieldHandoff: contract('private_handoff_manager', ['redacted_resume_verification'], 'handoff_state_machine', 'private_boundary', 'lifecycle_reconcile', [['private_field_handoff']]),
  requestLoginHandoff: contract('private_handoff_manager', ['native_authentication_handoff'], 'handoff_state_machine', 'private_boundary', 'lifecycle_reconcile', [['browser_running', 'authentication_release_pending']]),
  resumeAfterLogin: contract('private_handoff_manager', ['resume_authentication_handoff'], 'handoff_state_machine', 'private_boundary', 'lifecycle_reconcile', [['authentication_awaiting_user']]),
  policyStatus: contract('policy_manager', ['inspect_policy'], 'read_only_observation', 'none', 'idempotent_observation'),
  setPolicy: contract('policy_manager', ['normal_mode', 'review_only_mode'], 'lifecycle_state_machine', 'lifecycle_transition', 'lifecycle_reconcile'),
  testHang: contract('recovery_manager', ['exercise_supervisor_timeout'], 'supervisor_recovery', 'test_only', 'supervisor_only'),
} as const satisfies Record<BrowserCommandName, BrowserCommandContract>;

function contract(
  manager: BrowserActionManager,
  techniques: readonly string[],
  phaseSystem: BrowserPhaseSystem,
  dispatch: BrowserCommandContract['dispatch'],
  replay: BrowserCommandContract['replay'],
  requirementGroups: BrowserMoveRequirementGroups = NONE,
  techniqueRequirementGroups: Readonly<Record<string, BrowserMoveRequirementGroups>> = {},
  missingPrerequisitePolicy: BrowserCommandContract['missingPrerequisitePolicy'] = 'prepare_when_safe',
): BrowserCommandContract {
  return {
    manager,
    techniques,
    requirementGroups,
    techniqueRequirementGroups,
    missingPrerequisitePolicy,
    phaseSystem,
    dispatch,
    replay,
  };
}

export function browserCommandContract(command: BrowserCommandName): BrowserCommandContract {
  return BROWSER_COMMAND_CONTRACTS[command];
}
