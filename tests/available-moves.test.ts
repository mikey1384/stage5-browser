import { describe, expect, it } from 'vitest';

import { deriveBrowserAvailableMoves, type BrowserMoveContext } from '../src/protocol.js';

const EMPTY_COUNTS: BrowserMoveContext['capabilityCounts'] = {
  observedTabs: 0,
  semanticSnapshots: 0,
  snapshotRefs: 0,
  textEditorRefs: 0,
  fileInputRefs: 0,
  scrollContainerRefs: 0,
  controlInspections: 0,
  controlOptions: 0,
  popupOwnerCandidates: 0,
  formInspections: 0,
  formFields: 0,
};

function context(overrides: Partial<BrowserMoveContext> = {}): BrowserMoveContext {
  const { capabilityCounts, ...rest } = overrides;
  return {
    lifecycleState: 'stopped',
    browserConnected: false,
    livePageCount: 0,
    selectedPage: false,
    controlMode: 'agent',
    policyMode: 'normal',
    pageStateRisk: null,
    capabilityCounts: EMPTY_COUNTS,
    ...rest,
    capabilityCounts: { ...EMPTY_COUNTS, ...capabilityCounts },
  };
}

function derive(value: BrowserMoveContext, includeBlocked = true, maxMoves = 100) {
  return deriveBrowserAvailableMoves(value, { includeBlocked, maxMoves });
}

describe('browser available moves', () => {
  it('shows explicit startup and viable preparation paths without launching a stopped browser', () => {
    const result = derive(context());
    expect(result.moves.find(({ moveId }) => moveId === 'start:start_profile')).toMatchObject({
      availability: 'available',
      expectedEffect: 'lifecycle_transition',
      replay: 'lifecycle_reconcile',
    });
    expect(result.moves.find(({ moveId }) => moveId === 'open:open_url')).toMatchObject({
      availability: 'needs_preparation',
      missingPrerequisites: ['browser_running'],
      enablingCommands: ['availableBrowsers', 'start'],
    });
    for (const moveId of [
      'switchBrowser:switch_profile',
      'stop:stop_profile',
      'waitForDownload:wait_for_download',
    ]) {
      expect(result.moves.find((move) => move.moveId === moveId)).toMatchObject({
        availability: 'blocked',
        enablingCommands: [],
      });
    }
    expect(result.moves.find(({ moveId }) => moveId === 'requestLoginHandoff:native_authentication_handoff')).toMatchObject({
      availability: 'needs_preparation',
      missingPrerequisites: ['browser_running'],
    });
    expect(JSON.stringify(result)).not.toMatch(/https?:|selector|accessibleName|fieldValue/u);
  });

  it('distinguishes semantic and ref pathways plus document and nested scrolling', () => {
    const result = derive(context({
      lifecycleState: 'running',
      browserConnected: true,
      livePageCount: 1,
      selectedPage: true,
    }));
    expect(result.moves.find(({ moveId }) => moveId === 'clickByRole:click')?.availability).toBe('available');
    expect(result.moves.find(({ moveId }) => moveId === 'clickRef:click')).toMatchObject({
      availability: 'needs_preparation',
      enablingCommands: ['snapshot'],
    });
    expect(result.moves.find(({ moveId }) => moveId === 'scroll:scroll_document')?.availability).toBe('available');
    expect(result.moves.find(({ moveId }) => moveId === 'scroll:scroll_observed_container')).toMatchObject({
      availability: 'needs_preparation',
      missingPrerequisites: ['scroll_container_ref'],
    });
    expect(result.moves.find(({ moveId }) =>
      moveId === 'inspectControl:declare_popup_owner_from_observed_candidates')).toMatchObject({
        availability: 'needs_preparation',
        missingPrerequisites: ['popup_owner_candidate'],
        enablingCommands: ['inspectControl'],
        callerRequirements: expect.arrayContaining(['current_bounded_candidate_judgment']),
      });
  });

  it('makes capability-bound motions immediately available after observation', () => {
    const result = derive(context({
      lifecycleState: 'running',
      browserConnected: true,
      livePageCount: 2,
      selectedPage: true,
      capabilityCounts: {
        observedTabs: 2,
        semanticSnapshots: 1,
        snapshotRefs: 8,
        textEditorRefs: 1,
        fileInputRefs: 1,
        scrollContainerRefs: 2,
        controlInspections: 1,
        controlOptions: 6,
        popupOwnerCandidates: 1,
        formInspections: 1,
        formFields: 9,
      },
    }));
    for (const moveId of [
      'clickRef:click',
      'fillRef:fill_text',
      'setInputFiles:set_observed_file_input',
      'scroll:scroll_observed_container',
      'selectTab:select_tab',
      'applyFormPlan:apply_staged_plan',
      'inspectControl:declare_popup_owner_from_observed_candidates',
    ]) {
      expect(result.moves.find((move) => move.moveId === moveId)?.availability).toBe('available');
    }
  });

  it('surfaces acknowledgement as an agent decision only on navigation-capable paths', () => {
    const result = derive(context({
      lifecycleState: 'running',
      browserConnected: true,
      livePageCount: 1,
      selectedPage: true,
      pageStateRisk: {
        kind: 'possible_unsaved_file_selections',
        fileCount: 2,
        acknowledgementRequired: true,
      },
    }));
    expect(result.moves.find(({ moveId }) => moveId === 'open:open_url')?.callerRequirements)
      .toContain('same_page_navigation_requires_current_page_state_risk_acknowledgement');
    expect(result.moves.find(({ moveId }) => moveId === 'clickByRole:click')?.callerRequirements)
      .toContain('navigation_intent_requires_current_page_state_risk_acknowledgement');
    expect(result.moves.find(({ moveId }) => moveId === 'fillByRole:fill_text')?.callerRequirements)
      .not.toContain('acknowledge_current_page_state_risk');
  });

  it('exposes only the exact status and resume family during private handoff', () => {
    const result = derive(context({
      lifecycleState: 'running',
      browserConnected: true,
      livePageCount: 1,
      selectedPage: true,
      controlMode: 'private_field',
    }));
    const availableCommands = new Set(result.moves
      .filter(({ availability }) => availability === 'available')
      .map(({ command }) => command));
    expect(availableCommands).toEqual(new Set([
      'policyStatus',
      'privateFieldStatus',
      'resumePrivateFieldHandoff',
    ]));
    expect(result.moves.find(({ moveId }) => moveId === 'snapshot:semantic_snapshot')?.availability).toBe('blocked');
  });

  it('treats a retained authentication release as the canonical alternative login prerequisite', () => {
    const result = derive(context({ controlMode: 'authentication_release' }));
    expect(result.moves.find(({ moveId }) =>
      moveId === 'requestLoginHandoff:native_authentication_handoff')).toMatchObject({
        availability: 'available',
        missingPrerequisites: [],
      });
    expect(result.moves.find(({ moveId }) => moveId === 'start:start_profile')?.availability).toBe('blocked');
  });

  it('keeps review-policy judgment explicit while blocking prohibited command classes', () => {
    const result = derive(context({
      lifecycleState: 'running',
      browserConnected: true,
      livePageCount: 1,
      selectedPage: true,
      policyMode: 'review_only',
    }));
    expect(result.moves.find(({ moveId }) => moveId === 'closeTab:close_exact_tab')?.availability).toBe('blocked');
    expect(result.moves.find(({ moveId }) => moveId === 'clickByRole:click')).toMatchObject({
      availability: 'available',
      callerRequirements: expect.arrayContaining(['review_safe_agent_declared_intent']),
    });
    expect(result.moves.find(({ moveId }) => moveId === 'motion:hover')?.callerRequirements)
      .not.toContain('review_safe_agent_declared_intent');
  });

  it('bounds and deterministically reports omitted moves', () => {
    const first = derive(context(), true, 5);
    const second = derive(context(), true, 5);
    expect(first.moves).toEqual(second.moves);
    expect(first.returnedCount).toBe(5);
    expect(first.truncated).toBe(true);
    expect(first.omittedCount).toBe(first.matchingCount - 5);
  });

  it('exposes caller-selectable tactics rather than duplicating internal command phases', () => {
    const result = derive(context());
    expect(result.moves.filter(({ command }) => command === 'status')).toHaveLength(1);
    expect(result.moves.filter(({ command }) => command === 'resumeAfterLogin')).toHaveLength(1);
    expect(result.moves.find(({ command }) => command === 'resumeAfterLogin')?.technique)
      .toBe('resume_authentication_handoff');
  });
});
