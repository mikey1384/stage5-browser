import { type BrowserCommandInput, type ControlRecoveryEvidence, type ControlTarget, type Frame, Stage5BrowserError } from '../dependencies.js';
import type { AgentDeclaredPopupOwner } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import { observeOpenPopupOwnerCandidates, type ControlPopupAssociation } from './popup-association.js';
import { resolveUniqueControl } from './resolution.js';

export interface ResolvedInspectionTarget {
  agentDeclaredPopupOwner: AgentDeclaredPopupOwner | null;
  control: ControlTarget;
  handle: Awaited<ReturnType<typeof resolveUniqueControl>>['handle'];
  locator: Awaited<ReturnType<typeof resolveUniqueControl>>['locator'];
  recoveredMissingRequestedControl: boolean;
}

export async function resolveInspectionTarget(
  context: BrowserControllerContext,
  input: BrowserCommandInput<'inspectControl'>,
  frame: Frame,
  documentVersion: number,
  deadlineAt: number,
): Promise<ResolvedInspectionTarget> {
  const agentDeclaredPopupOwner = context.consumeAgentDeclaredPopupOwner(frame, documentVersion, input.control, input.popupAssociation);
  try {
    const resolved = await resolveUniqueControl(input.control, frame, deadlineAt);
    return {
      agentDeclaredPopupOwner,
      control: input.control,
      ...resolved,
      recoveredMissingRequestedControl: false,
    };
  } catch (error) {
    if (!controlUnavailableBeforeInspection(error)) throw error;
    if (agentDeclaredPopupOwner?.kind === 'observed_candidate') {
      const control = {
        role: agentDeclaredPopupOwner.role,
        name: agentDeclaredPopupOwner.name,
        exact: true,
      };
      const resolved = await resolveUniqueControl(control, frame, deadlineAt);
      return {
        agentDeclaredPopupOwner,
        control,
        ...resolved,
        recoveredMissingRequestedControl: true,
      };
    }
    if (input.popupAssociation != null) throw error;

    const association = await observeOpenPopupOwnerCandidates(frame, deadlineAt);
    if (association === null) throw error;
    const decision = context.issuePopupOwnerDecision(
      frame,
      documentVersion,
      input.control,
      association.ownerCandidates,
      association.agentJudgmentAvailable && !association.ownerCandidatesTruncated,
    );
    throw popupAssociationFailure(
      {
        ...association,
        ownerCandidates: decision.candidates,
        agentJudgmentAvailable: decision.agentJudgmentAvailable,
      },
      false,
      'control_missing_with_open_popup',
      'missing',
    );
  }
}

export function popupAssociationFailure(
  association: Extract<ControlPopupAssociation, { kind: 'ambiguous' }>,
  actionDispatched: boolean | 'unknown',
  reason = 'ambiguous_control_popup_after_reveal',
  requestedControlResolution: ControlRecoveryEvidence['requestedControlResolution'] = 'resolved',
): Stage5BrowserError {
  const issuedCapabilityCount = association.ownerCandidates.filter(({ ownerCandidateId }) => ownerCandidateId !== undefined).length;
  return new Stage5BrowserError('AMBIGUOUS_TARGET', 'The current popup owner remains ambiguous among bounded observed controls.', {
    recoverable: true,
    details: {
      reason,
      actionDispatched,
      renderedPopupCount: association.renderedSurfaceCount,
      popupOwnership: association.popupOwnership,
      ownerCandidates: association.ownerCandidates,
      ownerCandidatesTruncated: association.ownerCandidatesTruncated,
      requestedControlIsCandidate: association.requestedControlIsCandidate,
      agentJudgmentAvailable: association.agentJudgmentAvailable,
      controlRecovery: {
        requestedControlResolution,
        popupOwnerDecision: association.agentJudgmentAvailable ? 'required' : 'unavailable',
        activeCandidateCount: association.popupOwnership?.candidateCount ?? null,
        exposedCandidateCount: association.ownerCandidates.length,
        issuedCapabilityCount,
        candidatesTruncated: association.ownerCandidatesTruncated,
        requestedControlIsCandidate: association.requestedControlIsCandidate,
        agentJudgmentAvailable: association.agentJudgmentAvailable,
      } satisfies ControlRecoveryEvidence,
      decision: { kind: 'decision_required', responsible: 'agent' },
      suggestedAction:
        actionDispatched === false && association.agentJudgmentAvailable
          ? 'Choose exactly one current ownerCandidates ownerCandidateId using page semantics, then repeat one passive inspection with popupAssociation={owner:observed_candidate,ownerCandidateId,basis:agent_semantic_judgment}. The capability is document-bound and one-use; association dispatches no input.'
          : 'Inspect authoritative control state. Possible opener input is never replayed; use an agent-declared owner only in a separately authorized fresh passive inspection.',
    },
  });
}

export function completedControlRecovery(recoveredMissingRequestedControl: boolean, activeCandidateCount: number | null): ControlRecoveryEvidence {
  return recoveredMissingRequestedControl
    ? {
        requestedControlResolution: 'recovered_observed_owner',
        popupOwnerDecision: 'consumed',
        activeCandidateCount,
        exposedCandidateCount: null,
        issuedCapabilityCount: null,
        candidatesTruncated: null,
        requestedControlIsCandidate: false,
        agentJudgmentAvailable: true,
      }
    : {
        requestedControlResolution: 'resolved',
        popupOwnerDecision: 'not_required',
        activeCandidateCount: null,
        exposedCandidateCount: null,
        issuedCapabilityCount: null,
        candidatesTruncated: null,
        requestedControlIsCandidate: null,
        agentJudgmentAvailable: null,
      };
}

function controlUnavailableBeforeInspection(error: unknown): error is Stage5BrowserError {
  return (
    error instanceof Stage5BrowserError &&
    error.code === 'TARGET_NOT_FOUND' &&
    (error.details?.reason === 'control_not_found' || error.details?.reason === 'control_detached_before_inspection')
  );
}
