import { type BrowserCommandInput, type ControlPopupAgentAssociation, type Frame, randomUUID, Stage5BrowserError } from '../dependencies.js';
import type { AgentDeclaredPopupOwner, ObservedControlInspection, ObservedPopupOwnerDecision } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import type { PopupOwnerCandidateObservation } from './popup-ownership.js';
import { disposePopupSurfaces } from './popup-set.js';

export const controlCapabilityOperations = {
  retainControlInspection(inspection: ObservedControlInspection): void {
    this.discardControlInspectionsForFrame(inspection.frame);
    this.controlInspections.set(inspection.id, inspection);
  },

  issuePopupOwnerDecision(
    frame: Frame,
    documentVersion: number,
    control: BrowserCommandInput<'inspectControl'>['control'],
    candidates: PopupOwnerCandidateObservation[],
    eligible: boolean,
  ): { candidates: PopupOwnerCandidateObservation[]; agentJudgmentAvailable: boolean } {
    this.discardControlInspectionsForFrame(frame);
    if (!eligible) return { candidates, agentJudgmentAvailable: false };

    const semanticCounts = new Map<string, number>();
    for (const candidate of candidates) {
      const key = popupOwnerSemanticKey(candidate.role, candidate.name);
      semanticCounts.set(key, (semanticCounts.get(key) ?? 0) + 1);
    }
    let issued = 0;
    const boundedCandidates = candidates.map((candidate) => {
      const key = popupOwnerSemanticKey(candidate.role, candidate.name);
      if (candidate.name.length === 0 || semanticCounts.get(key) !== 1) return candidate;
      const ownerCandidateId = `popup-owner-candidate-${randomUUID()}`;
      const decision: ObservedPopupOwnerDecision = {
        frame,
        documentVersion,
        controlRole: control.role,
        controlName: control.name,
        controlExact: control.exact,
        ownerRole: candidate.role,
        ownerName: candidate.name,
      };
      this.popupOwnerDecisions.set(ownerCandidateId, decision);
      issued += 1;
      return { ...candidate, ownerCandidateId };
    });
    return { candidates: boundedCandidates, agentJudgmentAvailable: issued > 0 };
  },

  consumeAgentDeclaredPopupOwner(
    frame: Frame,
    documentVersion: number,
    control: BrowserCommandInput<'inspectControl'>['control'],
    association: ControlPopupAgentAssociation | null | undefined,
  ): AgentDeclaredPopupOwner | null {
    if (association === null || association === undefined) return null;
    if (association.owner === 'requested_control') return { kind: 'requested_control' };

    const decision = this.popupOwnerDecisions.get(association.ownerCandidateId);
    this.discardPopupOwnerDecisionsForFrame(decision?.frame ?? frame);
    const stale = decision === undefined ||
      decision.frame !== frame ||
      frame.isDetached() ||
      decision.documentVersion !== documentVersion;
    const wrongControl = !stale && (
      decision.controlRole !== control.role ||
      decision.controlName !== control.name ||
      decision.controlExact !== control.exact
    );
    if (stale || wrongControl) {
      throw new Stage5BrowserError(
        stale ? 'TARGET_NOT_FOUND' : 'OPERATION_FAILED',
        stale
          ? 'The observed popup-owner candidate is stale or unavailable.'
          : 'The observed popup-owner candidate belongs to a different requested control.',
        {
          recoverable: true,
          details: {
            reason: stale ? 'stale_popup_owner_candidate' : 'popup_owner_candidate_control_mismatch',
            actionDispatched: false,
            suggestedAction: 'Passively inspect the exact current control again and choose only one newly returned ownerCandidateId. No control input was dispatched.',
          },
        },
      );
    }
    return {
      kind: 'observed_candidate',
      role: decision.ownerRole,
      name: decision.ownerName,
    };
  },

  consumeControlInspection(
    frame: Frame,
    inspectionId: string,
  ): ObservedControlInspection {
    const inspection = this.controlInspections.get(inspectionId);
    this.controlInspections.delete(inspectionId);
    if (
      inspection === undefined ||
      inspection.frame !== frame ||
      frame.isDetached() ||
      inspection.documentVersion !== this.documentVersion(frame)
    ) {
      if (inspection !== undefined) void this.disposeControlInspection(inspection);
      throw new Stage5BrowserError(
        'TARGET_NOT_FOUND',
        'The control inspection capability is stale or does not belong to the active document.',
        {
          recoverable: true,
          details: {
            reason: 'stale_control_inspection',
            actionDispatched: false,
            suggestedAction: 'Inspect the intended control once more. Stage5 Browser confirmed that no selection input was dispatched.',
          },
        },
      );
    }
    return inspection;
  },

  discardControlInspectionsForFrame(frame: Frame): void {
    for (const [inspectionId, inspection] of this.controlInspections) {
      if (inspection.frame !== frame) continue;
      this.controlInspections.delete(inspectionId);
      void this.disposeControlInspection(inspection);
    }
    this.discardPopupOwnerDecisionsForFrame(frame);
  },

  discardPopupOwnerDecisionsForFrame(frame: Frame): void {
    for (const [candidateId, decision] of this.popupOwnerDecisions) {
      if (decision.frame === frame) this.popupOwnerDecisions.delete(candidateId);
    }
  },

  discardAllControlInspections(): void {
    for (const inspection of this.controlInspections.values()) {
      void this.disposeControlInspection(inspection);
    }
    this.controlInspections.clear();
    this.popupOwnerDecisions.clear();
  },

  async disposeControlInspection(inspection: ObservedControlInspection): Promise<void> {
    await Promise.allSettled([
      inspection.controlHandle.dispose(),
      inspection.representationScopeHandle?.dispose() ?? Promise.resolve(),
      disposePopupSurfaces(inspection.popupSurfaces),
      ...[...inspection.options.values()].map(({ handle }) => handle.dispose()),
    ]);
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

function popupOwnerSemanticKey(role: string, name: string): string {
  return JSON.stringify([role, name]);
}

export type ControlCapabilityOperations = typeof controlCapabilityOperations;
