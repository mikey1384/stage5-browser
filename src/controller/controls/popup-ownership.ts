import { type ControlPopupOwnershipEvidence, type ElementHandle, type Frame } from '../dependencies.js';
import { boundedValue, remainingUntil } from '../model.js';

const POPUP_OWNER_SELECTOR = [
  '[aria-controls]',
  '[aria-owns]',
  '[aria-haspopup]',
  'button',
  '[role="button"]',
  '[role="combobox"]',
  '[role="searchbox"]',
  'input[list]',
].join(', ');
const MAX_POPUP_OWNERS = 100;
const MIN_NORMALIZED_SPATIAL_LEAD = 0.1;
const MAX_NORMALIZED_COVERED_SIBLING_ANCHOR_GAP = 0.25;

type PopupOwnerProofTier = ControlPopupOwnershipEvidence['proofTier'];
type PopupOwnerDecision = ControlPopupOwnershipEvidence['decision'];

export type PopupOwnerResolution =
  | {
      kind: 'resolved';
      owner: ElementHandle<HTMLElement>;
      targetMatch: boolean;
      proof: 'expanded' | 'focused' | 'spatial' | 'structural';
      diagnostics: ControlPopupOwnershipEvidence;
    }
  | { kind: 'ambiguous' | 'missing' | 'unbounded'; diagnostics: ControlPopupOwnershipEvidence };

interface OwnerCandidate {
  handle: ElementHandle<HTMLElement>;
  expanded: boolean;
  focused: boolean;
  structural: boolean;
  spatial: boolean;
  spatialDistance: number;
  overlapsSurface: boolean;
  surfaceCoversControl: boolean;
}

function positionalOwner(
  candidates: OwnerCandidate[],
  proofTier: Exclude<PopupOwnerProofTier, 'none' | 'structural'>,
): { selected: OwnerCandidate | null; decision: PopupOwnerDecision } {
  if (candidates.length === 0) return { selected: null, decision: 'missing' };
  if (candidates.length === 1) return { selected: candidates[0]!, decision: 'single_candidate' };
  const surfaceCovered = candidates.filter((candidate) => candidate.surfaceCoversControl);
  const coveredSiblingsExcluded = proofTier === 'spatial' && surfaceCovered.length > 0;
  const eligible = coveredSiblingsExcluded
    ? candidates.filter((candidate) => !candidate.surfaceCoversControl)
    : candidates;
  if (eligible.length === 0) return { selected: null, decision: 'tie_or_near' };
  const ranked = [...eligible].sort((left, right) => left.spatialDistance - right.spatialDistance);
  const nearest = ranked[0]!;
  const next = ranked[1];
  if (
    coveredSiblingsExcluded &&
    nearest.spatialDistance > MAX_NORMALIZED_COVERED_SIBLING_ANCHOR_GAP
  ) {
    return { selected: null, decision: 'tie_or_near' };
  }
  if (next === undefined) {
    return {
      selected: nearest,
      decision: coveredSiblingsExcluded ? 'covered_siblings_excluded' : 'single_candidate',
    };
  }
  return next.spatialDistance - nearest.spatialDistance > MIN_NORMALIZED_SPATIAL_LEAD
    ? {
        selected: nearest,
        decision: coveredSiblingsExcluded ? 'covered_siblings_excluded' : 'decisive_distance',
      }
    : { selected: null, decision: 'tie_or_near' };
}

function ownerDiagnostics(
  proofTier: PopupOwnerProofTier,
  candidates: OwnerCandidate[],
  decision: PopupOwnerDecision,
): ControlPopupOwnershipEvidence {
  return {
    proofTier,
    candidateCount: candidates.length,
    exteriorCandidateCount: candidates.filter((candidate) => !candidate.overlapsSurface).length,
    overlappingCandidateCount: candidates.filter((candidate) => candidate.overlapsSurface).length,
    surfaceCoveredCandidateCount: candidates.filter((candidate) => candidate.surfaceCoversControl).length,
    decision,
  };
}

export async function resolveControlPopupOwner(
  frame: Frame,
  popup: ElementHandle<HTMLElement>,
  target: ElementHandle<HTMLElement>,
  deadlineAt: number,
): Promise<PopupOwnerResolution> {
  const owners = frame.locator(POPUP_OWNER_SELECTOR);
  const count = await boundedValue(
    owners.count(),
    Math.max(1, remainingUntil(deadlineAt)),
    -1,
  );
  if (count < 0 || count > MAX_POPUP_OWNERS) {
    const kind = count > MAX_POPUP_OWNERS ? 'unbounded' : 'missing';
    return {
      kind,
      diagnostics: {
        proofTier: 'none',
        candidateCount: null,
        exteriorCandidateCount: null,
        overlappingCandidateCount: null,
        surfaceCoveredCandidateCount: null,
        decision: kind,
      },
    };
  }

  const candidates: OwnerCandidate[] = [];
  let returnedOwner: ElementHandle<HTMLElement> | null = null;
  try {
    for (let index = 0; index < count; index += 1) {
      const handle = await boundedValue(
        owners.nth(index).elementHandle() as Promise<ElementHandle<HTMLElement> | null>,
        Math.max(1, remainingUntil(deadlineAt)),
        null,
      );
      if (handle === null) continue;
      const relation = await boundedValue(
        handle.evaluate((control, surface) => {
          if (!control.isConnected || !surface.isConnected) return null;
          const ids = [
            ...(control.getAttribute('aria-controls') ?? '').split(/\s+/),
            ...(control.getAttribute('aria-owns') ?? '').split(/\s+/),
          ].filter(Boolean);
          const labelledBy = (surface.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
          const controlRect = control.getBoundingClientRect();
          const surfaceRect = surface.getBoundingClientRect();
          const controlStyle = getComputedStyle(control);
          const surfaceStyle = getComputedStyle(surface);
          const rendered = (rect: DOMRect, style: CSSStyleDeclaration): boolean =>
            rect.width > 0 && rect.height > 0 &&
            rect.right > 0 && rect.bottom > 0 &&
            rect.left < innerWidth && rect.top < innerHeight &&
            style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
          const overlap = (startA: number, endA: number, startB: number, endB: number): number =>
            Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
          const horizontalOverlap = overlap(controlRect.left, controlRect.right, surfaceRect.left, surfaceRect.right);
          const verticalOverlap = overlap(controlRect.top, controlRect.bottom, surfaceRect.top, surfaceRect.bottom);
          const horizontalRatio = horizontalOverlap / Math.max(1, Math.min(controlRect.width, surfaceRect.width));
          const verticalRatio = verticalOverlap / Math.max(1, Math.min(controlRect.height, surfaceRect.height));
          const verticalGap = surfaceRect.top >= controlRect.bottom
            ? surfaceRect.top - controlRect.bottom
            : controlRect.top >= surfaceRect.bottom
              ? controlRect.top - surfaceRect.bottom
              : 0;
          const horizontalGap = surfaceRect.left >= controlRect.right
            ? surfaceRect.left - controlRect.right
            : controlRect.left >= surfaceRect.right
              ? controlRect.left - surfaceRect.right
              : 0;
          const overlapsSurface = horizontalOverlap > 0 && verticalOverlap > 0;
          const overlapRatio = overlapsSurface
            ? horizontalOverlap * verticalOverlap / Math.max(1, controlRect.width * controlRect.height)
            : 0;
          const overlapLeft = Math.max(0, controlRect.left, surfaceRect.left);
          const overlapRight = Math.min(innerWidth, controlRect.right, surfaceRect.right);
          const overlapTop = Math.max(0, controlRect.top, surfaceRect.top);
          const overlapBottom = Math.min(innerHeight, controlRect.bottom, surfaceRect.bottom);
          const overlapHit = overlapRight > overlapLeft && overlapBottom > overlapTop
            ? control.ownerDocument.elementFromPoint(
                (overlapLeft + overlapRight) / 2,
                (overlapTop + overlapBottom) / 2,
              )
            : null;
          const surfaceCoversControl = overlapRatio >= 0.5 && overlapHit !== null &&
            (overlapHit === surface || surface.contains(overlapHit));
          const spatialDistance = Math.hypot(
            horizontalGap / Math.max(1, Math.min(controlRect.width, surfaceRect.width)),
            verticalGap / Math.max(1, Math.min(controlRect.height, surfaceRect.height)),
          );
          const spatial = !surface.contains(control) &&
            rendered(controlRect, controlStyle) && rendered(surfaceRect, surfaceStyle) &&
            ((horizontalRatio >= 0.5 && verticalGap <= Math.max(48, controlRect.height * 2)) ||
              (verticalRatio >= 0.5 && horizontalGap <= Math.max(48, controlRect.width * 0.5)));
          return {
            structural: (surface.id.length > 0 && ids.includes(surface.id))
              || control.contains(surface)
              || (control.id.length > 0 && labelledBy.includes(control.id)),
            focused: control.ownerDocument.activeElement === control
              || control.contains(control.ownerDocument.activeElement),
            expanded: control.getAttribute('aria-expanded') === 'true',
            spatial,
            spatialDistance,
            overlapsSurface,
            surfaceCoversControl,
          };
        }, popup),
        Math.max(1, remainingUntil(deadlineAt)),
        null,
      );
      if (relation === null || (!relation.structural && !relation.focused && !relation.expanded && !relation.spatial)) {
        await handle.dispose().catch(() => undefined);
        continue;
      }
      candidates.push({ handle, ...relation });
    }

    const structural = candidates.filter((candidate) => candidate.structural);
    const focused = candidates.filter((candidate) =>
      !candidate.structural && candidate.focused && candidate.spatial);
    const expanded = candidates.filter((candidate) =>
      !candidate.structural && !candidate.focused && candidate.expanded && candidate.spatial);
    const spatial = candidates.filter((candidate) =>
      !candidate.structural && !candidate.focused && !candidate.expanded && candidate.spatial);
    const pool = structural.length > 0
      ? structural
      : focused.length > 0
        ? focused
        : expanded.length > 0
          ? expanded
          : spatial;
    const proofTier: PopupOwnerProofTier = structural.length > 0
      ? 'structural'
      : focused.length > 0
        ? 'focused'
        : expanded.length > 0
          ? 'expanded'
          : spatial.length > 0
            ? 'spatial'
            : 'none';
    const positional = proofTier === 'focused' || proofTier === 'expanded' || proofTier === 'spatial'
      ? positionalOwner(pool, proofTier)
      : {
          selected: pool.length === 1 ? pool[0]! : null,
          decision: pool.length === 1
            ? 'single_candidate' as const
            : pool.length > 1
              ? 'structural_conflict' as const
              : 'missing' as const,
        };
    const diagnostics = ownerDiagnostics(proofTier, pool, positional.decision);
    const selected = positional.selected;
    if (selected === null) {
      return { kind: pool.length > 1 ? 'ambiguous' : 'missing', diagnostics };
    }
    const targetMatch = await boundedValue(
      selected.handle.evaluate((owner, intended) => owner === intended, target),
      Math.max(1, remainingUntil(deadlineAt)),
      null,
    );
    if (targetMatch === null) return { kind: 'missing', diagnostics };
    const proof = selected.structural
      ? 'structural' as const
      : selected.focused
        ? 'focused' as const
        : selected.expanded
          ? 'expanded' as const
          : 'spatial' as const;
    returnedOwner = selected.handle;
    return { kind: 'resolved', owner: selected.handle, targetMatch, proof, diagnostics };
  } catch {
    returnedOwner = null;
    return {
      kind: 'missing',
      diagnostics: {
        proofTier: 'none',
        candidateCount: null,
        exteriorCandidateCount: null,
        overlappingCandidateCount: null,
        surfaceCoveredCandidateCount: null,
        decision: 'missing',
      },
    };
  } finally {
    await Promise.allSettled(candidates
      .filter(({ handle }) => handle !== returnedOwner)
      .map(({ handle }) => handle.dispose()));
  }
}
