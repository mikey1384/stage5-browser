import { BROWSER_COMMAND_CONTRACTS, type BrowserActionManager, type BrowserCommandContract, type BrowserMovePrerequisite, type BrowserPhaseSystem } from './command-contracts.js';
import type { BrowserCommandName } from './commands.js';
import type { BrowserLifecycleState } from './browser-state.js';
import { BROWSER_COMMAND_POLICY, type BrowserActionPolicyMode } from './policy.js';

export const BROWSER_MOVE_AVAILABILITIES = ['available', 'needs_preparation', 'blocked'] as const;
export type BrowserMoveAvailability = (typeof BROWSER_MOVE_AVAILABILITIES)[number];

export type BrowserControlMode =
  | 'agent'
  | 'authentication_release'
  | 'authentication_user'
  | 'private_field';

export interface BrowserMoveContext {
  lifecycleState: BrowserLifecycleState;
  browserConnected: boolean;
  livePageCount: number;
  selectedPage: boolean;
  controlMode: BrowserControlMode;
  policyMode: BrowserActionPolicyMode;
  capabilityCounts: {
    observedTabs: number;
    semanticSnapshots: number;
    snapshotRefs: number;
    textEditorRefs: number;
    fileInputRefs: number;
    scrollContainerRefs: number;
    controlInspections: number;
    controlOptions: number;
    popupOwnerCandidates: number;
    formInspections: number;
    formFields: number;
  };
}

export interface BrowserAvailableMove {
  moveId: string;
  command: BrowserCommandName;
  technique: string;
  manager: BrowserActionManager;
  phaseSystem: BrowserPhaseSystem;
  availability: BrowserMoveAvailability;
  missingPrerequisites: BrowserMovePrerequisite[];
  enablingCommands: BrowserCommandName[];
  expectedEffect: BrowserCommandContract['dispatch'];
  cost: 'bounded_observation' | 'bounded_reversible' | 'human_wait' | 'single_dispatch' | 'state_transition';
  authority: 'existing_user_scope' | 'none' | 'private_user_boundary';
  callerRequirements: string[];
  replay: BrowserCommandContract['replay'];
}

export interface BrowserAvailableMovesInput {
  includeBlocked: boolean;
  manager?: BrowserActionManager | null;
  availability?: BrowserMoveAvailability | null;
  maxMoves: number;
}

export interface BrowserAvailableMovesOutput {
  context: BrowserMoveContext;
  moves: BrowserAvailableMove[];
  returnedCount: number;
  totalCount: number;
  matchingCount: number;
  omittedCount: number;
  truncated: boolean;
  meaning: {
    available: 'runtime_prerequisites_satisfied';
    needsPreparation: 'one_or_more_safe_structural_prerequisites_can_be_observed_or_prepared';
    blocked: 'current_control_mode_policy_or_incompatible_state_blocks_this_motion';
    semanticChoice: 'agent';
    structuralTruth: 'deterministic_managers';
    authority: 'never_expanded_by_this_observation';
  };
}

const HIDDEN_COMMANDS = new Set<BrowserCommandName>(['initialize', 'availableMoves', 'testHang']);
const PREPARABLE = new Set<BrowserMovePrerequisite>([
  'browser_running',
  'control_inspection',
  'file_input_ref',
  'form_inspection',
  'observed_tabs',
  'popup_owner_candidate',
  'scroll_container_ref',
  'selected_page',
  'semantic_snapshot',
  'snapshot_ref',
  'text_editor_ref',
]);

export function deriveBrowserAvailableMoves(
  context: BrowserMoveContext,
  input: BrowserAvailableMovesInput,
): BrowserAvailableMovesOutput {
  const moves = Object.entries(BROWSER_COMMAND_CONTRACTS).flatMap(([rawCommand, contract]) => {
    const command = rawCommand as BrowserCommandName;
    if (HIDDEN_COMMANDS.has(command)) return [];
    return contract.techniques.map((technique) => deriveMove(context, command, technique, contract));
  }).sort(compareMoves);
  const visible = moves.filter((move) =>
    (input.includeBlocked || move.availability !== 'blocked') &&
    (input.manager === undefined || input.manager === null || move.manager === input.manager) &&
    (input.availability === undefined || input.availability === null || move.availability === input.availability));
  const selected = visible.slice(0, input.maxMoves);
  return {
    context,
    moves: selected,
    returnedCount: selected.length,
    totalCount: moves.length,
    matchingCount: visible.length,
    omittedCount: visible.length - selected.length,
    truncated: selected.length < visible.length,
    meaning: {
      available: 'runtime_prerequisites_satisfied',
      needsPreparation: 'one_or_more_safe_structural_prerequisites_can_be_observed_or_prepared',
      blocked: 'current_control_mode_policy_or_incompatible_state_blocks_this_motion',
      semanticChoice: 'agent',
      structuralTruth: 'deterministic_managers',
      authority: 'never_expanded_by_this_observation',
    },
  };
}

function deriveMove(
  context: BrowserMoveContext,
  command: BrowserCommandName,
  technique: string,
  contract: BrowserCommandContract,
): BrowserAvailableMove {
  const groups = [
    ...contract.requirementGroups,
    ...(contract.techniqueRequirementGroups[technique] ?? []),
  ];
  const missing = groups.flatMap((group) => {
    if (group.some((requirement) => prerequisiteSatisfied(context, requirement))) return [];
    return [group.find((requirement) => PREPARABLE.has(requirement)) ?? group[0]!];
  });
  const controlModeAllows = commandAllowedInControlMode(command, context.controlMode);
  const policyBlocked = context.policyMode === 'review_only' && BROWSER_COMMAND_POLICY[command] === 'blocked_in_review';
  const missingPrerequisites = [...new Set(missing)];
  const availability: BrowserMoveAvailability = !controlModeAllows || policyBlocked
    ? 'blocked'
    : missingPrerequisites.length === 0
      ? 'available'
      : contract.missingPrerequisitePolicy === 'prepare_when_safe' &&
          missingPrerequisites.every((requirement) => PREPARABLE.has(requirement))
        ? 'needs_preparation'
        : 'blocked';
  const callerRequirements = callerRequirementsFor(command, technique, context.policyMode);
  if (policyBlocked) callerRequirements.push('review_policy_change_requires_user_authorized_workflow');
  const enablingCommands = contract.missingPrerequisitePolicy === 'not_meaningful' &&
    missingPrerequisites.length > 0
    ? []
    : enablingCommandsFor(missingPrerequisites, context.controlMode);
  return {
    moveId: `${command}:${technique}`,
    command,
    technique,
    manager: contract.manager,
    phaseSystem: contract.phaseSystem,
    availability,
    missingPrerequisites,
    enablingCommands,
    expectedEffect: contract.dispatch,
    cost: costFor(contract),
    authority: authorityFor(contract),
    callerRequirements,
    replay: contract.replay,
  };
}

function prerequisiteSatisfied(context: BrowserMoveContext, requirement: BrowserMovePrerequisite): boolean {
  const counts = context.capabilityCounts;
  switch (requirement) {
    case 'agent_control': return context.controlMode === 'agent';
    case 'authentication_awaiting_user': return context.controlMode === 'authentication_user';
    case 'authentication_release_pending': return context.controlMode === 'authentication_release';
    case 'browser_running': return context.lifecycleState === 'running' && context.browserConnected;
    case 'browser_stopped': return context.lifecycleState === 'stopped' && !context.browserConnected;
    case 'control_inspection': return counts.controlInspections > 0;
    case 'file_input_ref': return counts.fileInputRefs > 0;
    case 'form_inspection': return counts.formInspections > 0;
    case 'observed_tabs': return counts.observedTabs > 0;
    case 'popup_owner_candidate': return counts.popupOwnerCandidates > 0;
    case 'private_field_handoff': return context.controlMode === 'private_field';
    case 'scroll_container_ref': return counts.scrollContainerRefs > 0;
    case 'selected_page': return context.selectedPage;
    case 'semantic_snapshot': return counts.semanticSnapshots > 0;
    case 'snapshot_ref': return counts.snapshotRefs > 0;
    case 'text_editor_ref': return counts.textEditorRefs > 0;
  }
}

function commandAllowedInControlMode(command: BrowserCommandName, mode: BrowserControlMode): boolean {
  if (command === 'availableMoves' || command === 'policyStatus') return true;
  if (mode === 'agent') return true;
  if (mode === 'private_field') {
    return command === 'privateFieldStatus' || command === 'resumePrivateFieldHandoff';
  }
  if (mode === 'authentication_release') {
    return command === 'authStatus' || command === 'requestLoginHandoff';
  }
  return command === 'authStatus' || command === 'resumeAfterLogin';
}

function enablingCommandsFor(
  missing: BrowserMovePrerequisite[],
  controlMode: BrowserControlMode,
): BrowserCommandName[] {
  const commands = new Set<BrowserCommandName>();
  for (const requirement of missing) {
    if (requirement === 'browser_running') {
      commands.add('availableBrowsers');
      commands.add('start');
    } else if (requirement === 'selected_page') {
      commands.add('tabs');
      commands.add('open');
    } else if (requirement === 'observed_tabs') commands.add('tabs');
    else if (requirement === 'semantic_snapshot' || requirement === 'snapshot_ref' ||
      requirement === 'text_editor_ref' || requirement === 'file_input_ref' ||
      requirement === 'scroll_container_ref') commands.add('snapshot');
    else if (requirement === 'control_inspection') commands.add('inspectControl');
    else if (requirement === 'popup_owner_candidate') commands.add('inspectControl');
    else if (requirement === 'form_inspection') commands.add('formSummary');
    else if (requirement === 'private_field_handoff') commands.add('requestPrivateFieldHandoff');
    else if (requirement === 'authentication_release_pending') commands.add('requestLoginHandoff');
    else if (requirement === 'authentication_awaiting_user') commands.add('requestLoginHandoff');
    else if (requirement === 'agent_control' && controlMode === 'private_field') commands.add('resumePrivateFieldHandoff');
    else if (requirement === 'agent_control' && controlMode === 'authentication_release') commands.add('requestLoginHandoff');
    else if (requirement === 'agent_control') commands.add('resumeAfterLogin');
  }
  return [...commands];
}

function callerRequirementsFor(
  command: BrowserCommandName,
  technique: string,
  policyMode: BrowserActionPolicyMode,
): string[] {
  const requirements: string[] = [];
  if (['clickByRole', 'fillByRole', 'motion', 'inspectControl', 'selectOption', 'selectOptions', 'setChecked'].includes(command)) {
    requirements.push('exact_current_semantic_target');
  }
  if (command === 'clickRef' || command === 'fillRef' || command === 'setInputFiles') {
    requirements.push('fresh_document_bound_capability');
  }
  if (command === 'selectOption' || command === 'selectOptions') requirements.push('agent_chosen_option_meaning');
  if (technique === 'declare_popup_owner_from_observed_candidates') {
    requirements.push('current_bounded_candidate_judgment');
  }
  if (command === 'clickByRole' || command === 'clickRef' || command === 'motion') {
    requirements.push('bounded_postcondition_for_state_change');
  }
  if (command === 'open' || command === 'waitForUrl') requirements.push('authorized_url_intent');
  if (command === 'setInputFiles') requirements.push('explicitly_authorized_local_files');
  if (command === 'applyFormPlan') requirements.push('agent_chosen_staged_field_plan');
  if (policyMode === 'review_only' && BROWSER_COMMAND_POLICY[command] === 'declared_intent_in_review' &&
    !(command === 'motion' && (technique === 'focus' || technique === 'hover'))) {
    requirements.push('review_safe_agent_declared_intent');
  }
  if (authorityFor(BROWSER_COMMAND_CONTRACTS[command]) === 'existing_user_scope') {
    requirements.push('existing_user_authority');
  }
  return requirements;
}

function authorityFor(contract: BrowserCommandContract): BrowserAvailableMove['authority'] {
  if (contract.dispatch === 'private_boundary') return 'private_user_boundary';
  if (contract.dispatch === 'none' &&
    (contract.manager === 'lifecycle_manager' || contract.manager === 'planning_manager' || contract.manager === 'policy_manager')) {
    return 'none';
  }
  return 'existing_user_scope';
}

function costFor(contract: BrowserCommandContract): BrowserAvailableMove['cost'] {
  if (contract.dispatch === 'private_boundary') return 'human_wait';
  if (contract.dispatch === 'none') return 'bounded_observation';
  if (contract.dispatch === 'reversible_view_state') return 'bounded_reversible';
  if (contract.dispatch === 'lifecycle_transition') return 'state_transition';
  return 'single_dispatch';
}

function compareMoves(left: BrowserAvailableMove, right: BrowserAvailableMove): number {
  const rank = { available: 0, needs_preparation: 1, blocked: 2 } as const;
  return rank[left.availability] - rank[right.availability]
    || left.missingPrerequisites.length - right.missingPrerequisites.length
    || left.manager.localeCompare(right.manager)
    || left.technique.localeCompare(right.technique)
    || left.command.localeCompare(right.command);
}
