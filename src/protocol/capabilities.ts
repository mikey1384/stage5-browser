import type { BrowserActionManager } from './command-contracts.js';

export interface BrowserManagerCapability {
  responsibility: string;
  techniques: readonly string[];
  compositionBoundary: string;
}

export const BROWSER_MANAGER_CAPABILITIES = {
  lifecycle_manager: {
    responsibility: 'Own browser runtime, isolated profile, process identity, and controlled start/switch/stop transitions.',
    techniques: ['preflight_backend', 'start_profile', 'switch_profile', 'stop_profile', 'reconcile_process_ownership'],
    compositionBoundary: 'Produces or retires the controlled browser context used by every other manager.',
  },
  perception_manager: {
    responsibility: 'Observe bounded privacy-safe browser, document, frame, visual, text, and diagnostic state.',
    techniques: ['status', 'diagnostics', 'page_lifecycle_events', 'semantic_snapshot', 'screenshot', 'list_frames', 'find_rendered_text'],
    compositionBoundary: 'Produces evidence and document-bound capabilities; never dispatches element input.',
  },
  navigation_manager: {
    responsibility: 'Move an exact selected page through URL and history state with commit/readiness reconciliation.',
    techniques: ['open_url', 'open_new_tab', 'back', 'forward', 'reload', 'wait_for_url'],
    compositionBoundary: 'Invalidates document capabilities on transition and never replays ambiguous navigation.',
  },
  tab_manager: {
    responsibility: 'Own stable opaque tab identity, selection, passive inspection, temporary activation, restoration, and close.',
    techniques: ['list_tabs', 'select_tab', 'activate_selected_page', 'inspect_tab_passively', 'temporarily_activate_and_restore', 'close_exact_tab'],
    compositionBoundary: 'Never falls back to title, URL, or mutable index when an exact tab identity is required.',
  },
  interaction_manager: {
    responsibility: 'Dispatch atomic composable pointer, focus, keyboard, drag, and viewport motions to exact targets.',
    techniques: ['click', 'hover', 'focus', 'press_key', 'double_click', 'context_click', 'drag_and_drop', 'scroll_surface'],
    compositionBoundary: 'One phased dispatch gate; possible trusted input is never replayed automatically.',
  },
  form_manager: {
    responsibility: 'Inspect, edit, validate, and stage exact form fields and option controls without deciding business meaning.',
    techniques: ['summarize_form', 'fill_text', 'fill_date', 'inspect_options', 'select_option', 'select_multiple_options', 'set_checked', 'apply_staged_plan'],
    compositionBoundary: 'Structural facts are deterministic; the agent chooses semantic values within user authority.',
  },
  transfer_manager: {
    responsibility: 'Move explicitly authorized files into observed inputs and capture browser downloads as private artifacts.',
    techniques: ['set_observed_file_input', 'observe_upload_processing', 'capture_download', 'wait_for_download', 'restore_download_manifest'],
    compositionBoundary: 'Transfers never imply remote processing/submission success and trigger actions are never replayed.',
  },
  dialog_manager: {
    responsibility: 'Prevent JavaScript dialogs from deadlocking the hand and respond only under an exact action-scoped expectation.',
    techniques: ['accept_expected_alert', 'accept_or_dismiss_confirm', 'answer_non_private_prompt', 'resolve_beforeunload', 'dismiss_unexpected_dialog', 'inspect_dialog_history'],
    compositionBoundary: 'Messages and prompt values are never retained; unexpected or mismatched dialogs fail closed.',
  },
  private_handoff_manager: {
    responsibility: 'Temporarily yield only the required private field or authenticated profile boundary to the user.',
    techniques: ['field_scoped_private_input', 'native_authentication_handoff', 'reattach_same_profile', 'redacted_resume_verification'],
    compositionBoundary: 'Credentials and private values never return to agent-visible state.',
  },
  policy_manager: {
    responsibility: 'Apply optional workflow policy from deterministic command class plus agent-declared semantic intent.',
    techniques: ['normal_mode', 'review_only_mode', 'declare_action_intent', 'block_consequential_class_before_dispatch'],
    compositionBoundary: 'Does not infer intent from labels, selectors, URLs, or regexes and never expands user authority.',
  },
  recovery_manager: {
    responsibility: 'Make deadlines, in-flight results, worker handoff, and one proven-zero-input recovery observable.',
    techniques: ['reserve_operation', 'query_operation_status', 'persist_terminal_timing', 'replace_compatible_worker', 'recover_once_before_input'],
    compositionBoundary: 'A timeout is not an outcome; authoritative possible input always forbids automatic replay.',
  },
} as const satisfies Record<BrowserActionManager, BrowserManagerCapability>;

export const BROWSER_CONTEXT_LAYERS = {
  durable: [
    'profile_ownership_lease',
    'operation_terminal_journal',
    'lounge_inbox_and_acknowledgements',
    'sanitized_download_manifest',
    'sanitized_dialog_manifest',
    'sanitized_page_lifecycle_manifest',
  ],
  session: [
    'controlled_browser_identity',
    'selected_profile',
    'stable_tab_ids',
    'selected_page',
    'action_policy_mode',
    'handoff_state',
  ],
  document: [
    'frame_ids',
    'document_versions',
    'snapshot_refs',
    'scroll_container_refs',
    'form_field_capabilities',
    'control_option_capabilities',
  ],
  action: [
    'absolute_deadline',
    'phase_transitions',
    'prepared_exact_handles',
    'trusted_dispatch_evidence',
    'postcondition_evidence',
    'action_scoped_dialog_expectation',
  ],
  private_ephemeral: [
    'fill_value',
    'prompt_value',
    'private_field_value',
    'authentication_secret',
  ],
} as const;

export const BROWSER_ACTION_LOOP = [
  'observe',
  'plan',
  'preflight',
  'prepare',
  'dispatch_once',
  'reconcile',
  'finalize',
] as const;
