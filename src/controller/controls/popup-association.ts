import {
  type ControlPopupAssociationProof,
  type ControlPopupOwnershipEvidence,
  type ControlPopupSurfaceProof,
  type ElementHandle,
  type Frame,
  type Locator,
} from '../dependencies.js';
import {
  boundedValue,
  type ObservedControlPopupSurface,
  remainingUntil,
} from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import {
  resolveControlPopupOwner,
  type PopupOwnerCandidateObservation,
} from './popup-ownership.js';
import { discoverControlPopupSurfaces } from './popup-surfaces.js';

interface PopupCandidate {
  locator: Locator | null;
  handle: ElementHandle<HTMLElement>;
  surfaceProof: ControlPopupSurfaceProof;
  explicit: boolean;
  structurallyRelated: boolean;
  rendered: boolean;
}

export interface ControlPopupAssociationPolicy {
  allowAgentDeclaredTargetOwner?: boolean;
  allowUniqueRenderedAfterDispatch?: boolean;
  requireRendered?: boolean;
}

export type ControlPopupAssociation =
  | {
      kind: 'resolved';
      surfaces: ObservedControlPopupSurface[];
      proof: ControlPopupAssociationProof;
      surfaceProof: ControlPopupSurfaceProof;
      renderedSurfaceCount: number;
      popupOwnership: ControlPopupOwnershipEvidence | null;
    }
  | {
      kind: 'ambiguous';
      renderedSurfaceCount: number | null;
      popupOwnership: ControlPopupOwnershipEvidence | null;
      ownerCandidates: PopupOwnerCandidateObservation[];
      ownerCandidatesTruncated: boolean;
      requestedControlIsCandidate: boolean;
      agentJudgmentAvailable: boolean;
    }
  | {
      kind: 'missing';
      renderedSurfaceCount: number | null;
      popupOwnership: ControlPopupOwnershipEvidence | null;
    };

function weakestAssociationProof(
  proofs: Array<'structural' | 'focused' | 'expanded' | 'spatial'>,
): ControlPopupAssociationProof {
  if (proofs.includes('spatial')) return 'spatial';
  if (proofs.includes('expanded')) return 'expanded';
  if (proofs.includes('focused')) return 'focused';
  return 'structural';
}

async function outermostPopupCandidates(
  candidates: PopupCandidate[],
  deadlineAt: number,
): Promise<PopupCandidate[]> {
  const nested = new Set<PopupCandidate>();
  for (const candidate of candidates) {
    for (const possibleAncestor of candidates) {
      if (candidate === possibleAncestor) continue;
      const contained = await boundedValue(
        possibleAncestor.handle.evaluate(
          (ancestor, descendant) =>
            ancestor.isConnected && descendant.isConnected && ancestor.contains(descendant),
          candidate.handle,
        ),
        Math.max(1, remainingUntil(deadlineAt)),
        null,
      );
      if (contained === true) {
        nested.add(candidate);
        break;
      }
    }
  }
  return candidates.filter((candidate) => !nested.has(candidate));
}

export const controlPopupAssociationOperations = {
  async associatedControlPopup(
    frame: Frame,
    controlHandle: ElementHandle<HTMLElement>,
    deadlineAt: number,
    policy: ControlPopupAssociationPolicy = {},
  ): Promise<ControlPopupAssociation> {
    const connected = await boundedValue(
      controlHandle.evaluate((control) => control.isConnected),
      Math.max(1, remainingUntil(deadlineAt)),
      false,
    );
    if (!connected) {
      return { kind: 'missing', renderedSurfaceCount: null, popupOwnership: null };
    }

    const discovery = await discoverControlPopupSurfaces(frame, deadlineAt);
    if (discovery.kind === 'unbounded') {
      return {
        kind: 'ambiguous',
        renderedSurfaceCount: null,
        popupOwnership: null,
        ownerCandidates: [],
        ownerCandidatesTruncated: true,
        requestedControlIsCandidate: false,
        agentJudgmentAvailable: false,
      };
    }
    const candidates: PopupCandidate[] = [];
    try {
      for (const surface of discovery.surfaces) {
        const { locator, handle, surfaceProof } = surface;
        const state = await boundedValue(
          controlHandle.evaluate((control, popup) => {
            if (!control.isConnected || !popup.isConnected) return null;
            const rect = popup.getBoundingClientRect();
            const style = getComputedStyle(popup);
            const rendered = rect.width > 0 && rect.height > 0 &&
              rect.right > 0 && rect.bottom > 0 &&
              rect.left < innerWidth && rect.top < innerHeight &&
              style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            const labelledBy = (popup.getAttribute('aria-labelledby') ?? '')
              .split(/\s+/)
              .filter(Boolean);
            return {
              explicit: popup.id.length > 0 && [
                ...(control.getAttribute('aria-controls') ?? '').split(/\s+/),
                ...(control.getAttribute('aria-owns') ?? '').split(/\s+/),
              ].includes(popup.id),
              structurallyRelated: control === popup || control.contains(popup) ||
                (control.id.length > 0 && labelledBy.includes(control.id)),
              rendered,
            };
          }, handle),
          Math.max(1, remainingUntil(deadlineAt)),
          null,
        );
        if (state === null) {
          await handle.dispose().catch(() => undefined);
          continue;
        }
        candidates.push({ locator, handle, surfaceProof, ...state });
      }

      const explicit = candidates.filter(
        (candidate) => candidate.explicit && (!policy.requireRendered || candidate.rendered),
      );
      const activeExplicit = explicit.some(({ rendered }) => rendered)
        ? explicit.filter(({ rendered }) => rendered)
        : explicit;
      const structural = candidates.filter(
        (candidate) => candidate.structurallyRelated && candidate.rendered,
      );
      const rendered = candidates.filter((candidate) => candidate.rendered);
      const selected = new Set<PopupCandidate>();
      let selectedProof: ControlPopupAssociationProof | null = activeExplicit.length > 0
        ? 'explicit'
        : structural.length > 0
          ? 'structural'
          : null;
      for (const candidate of activeExplicit.length > 0 ? activeExplicit : structural) {
        selected.add(candidate);
      }

      let ownershipAmbiguous = false;
      let requestedControlIsAmbiguousCandidate = false;
      let ownerCandidates: PopupOwnerCandidateObservation[] = [];
      let ownerCandidatesTruncated = false;
      const ownershipDiagnostics: ControlPopupOwnershipEvidence[] = [];
      const ownerMatched: Array<{
        candidate: PopupCandidate;
        proof: 'structural' | 'focused' | 'expanded' | 'spatial';
      }> = [];
      for (const candidate of rendered) {
        const ownership = await resolveControlPopupOwner(
          frame,
          candidate.handle,
          controlHandle,
          deadlineAt,
        );
        ownershipDiagnostics.push(ownership.diagnostics);
        if (ownership.kind === 'resolved') {
          if (ownership.targetMatch) ownerMatched.push({ candidate, proof: ownership.proof });
          await ownership.owner.dispose().catch(() => undefined);
        } else if (ownership.kind === 'ambiguous' || ownership.kind === 'unbounded') {
          ownershipAmbiguous = true;
          if (ownership.kind === 'ambiguous') {
            requestedControlIsAmbiguousCandidate ||= ownership.targetCandidate;
            ownerCandidates = ownership.candidates;
            ownerCandidatesTruncated = ownership.candidatesTruncated;
          }
        }
      }

      if (selected.size === 0) {
        for (const { candidate } of ownerMatched) selected.add(candidate);
      }
      if (selectedProof === null && selected.size > 0 && ownerMatched.length > 0) {
        selectedProof = weakestAssociationProof(ownerMatched.map(({ proof }) => proof));
      }
      if (
        selected.size === 0 &&
        policy.allowAgentDeclaredTargetOwner === true &&
        rendered.length === 1 &&
        requestedControlIsAmbiguousCandidate
      ) {
        selected.add(rendered[0]!);
        selectedProof = 'agent_declared';
      }
      if (
        selected.size === 0 &&
        policy.allowUniqueRenderedAfterDispatch === true &&
        rendered.length === 1
      ) {
        selected.add(rendered[0]!);
        selectedProof = 'post_dispatch_unique';
      }

      const selectedSurfaces = await outermostPopupCandidates([...selected], deadlineAt);
      const retained = new Set(selectedSurfaces);
      for (const candidate of candidates) {
        if (!retained.has(candidate)) await candidate.handle.dispose().catch(() => undefined);
      }
      const renderedSurfaceCount = rendered.length;
      const popupOwnership = rendered.length === 1 && ownershipDiagnostics.length === 1
        ? ownershipDiagnostics[0]!
        : null;
      if (selectedSurfaces.length > 0 && selectedProof !== null) {
        return {
          kind: 'resolved',
          surfaces: selectedSurfaces.map(({ locator, handle, surfaceProof }) => ({
            locator,
            handle,
            surfaceProof,
          })),
          proof: selectedProof,
          surfaceProof: selectedSurfaces[0]!.surfaceProof,
          renderedSurfaceCount,
          popupOwnership,
        };
      }
      if (ownershipAmbiguous) {
        return {
          kind: 'ambiguous',
          renderedSurfaceCount,
          popupOwnership,
          ownerCandidates,
          ownerCandidatesTruncated,
          requestedControlIsCandidate: requestedControlIsAmbiguousCandidate,
          agentJudgmentAvailable: rendered.length === 1 && requestedControlIsAmbiguousCandidate,
        };
      }
      return { kind: 'missing', renderedSurfaceCount, popupOwnership };
    } catch (error) {
      await Promise.allSettled(candidates.map(({ handle }) => handle.dispose()));
      throw error;
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type ControlPopupAssociationOperations = typeof controlPopupAssociationOperations;
