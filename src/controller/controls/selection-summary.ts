import type { ControlSelectionEvidence, ControlSelectionSummary } from '../dependencies.js';

export function completedSelectionSummary(
  evidence: readonly ControlSelectionEvidence[],
  multiple: boolean,
  requestedSelected: boolean,
): ControlSelectionSummary {
  const actionDispatched = evidence.some((item) => item.actionDispatched === 'unknown')
    ? 'unknown'
    : evidence.some((item) => item.actionDispatched)
      ? true
      : false;
  const popupClosed = evidence.at(-1)?.popupClosed ?? null;
  const popupOpen = popupClosed === null ? null : !popupClosed;
  const viableNextMoves: ControlSelectionSummary['viableNextMoves'] = popupOpen
    ? [
        ...(multiple ? ['select_more_with_fresh_inspection' as const] : []),
        'continue_if_popup_not_obstructing',
        'dismiss_with_escape',
        'dismiss_with_exact_outside_click',
      ]
    : ['continue'];
  return {
    outcome: 'succeeded',
    selectionSucceeded: true,
    actionDispatched,
    currentState: { requestedSelected, popupOpen, multiple },
    nextAction: popupOpen ? (multiple ? 'select_more_or_dismiss_popup' : 'dismiss_popup') : 'continue',
    viableNextMoves,
  };
}
