import { type ElementHandle, type Frame } from '../dependencies.js';
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

export type PopupOwnerResolution =
  | {
      kind: 'resolved';
      owner: ElementHandle<HTMLElement>;
      targetMatch: boolean;
      proof: 'expanded' | 'focused' | 'spatial' | 'structural';
    }
  | { kind: 'ambiguous' | 'missing' | 'unbounded' };

interface OwnerCandidate {
  handle: ElementHandle<HTMLElement>;
  expanded: boolean;
  focused: boolean;
  structural: boolean;
  spatial: boolean;
  spatialDistance: number;
}

function uniquelyNearestSpatialOwner(candidates: OwnerCandidate[]): OwnerCandidate | null {
  if (candidates.length === 0) return null;
  const ranked = [...candidates].sort((left, right) => left.spatialDistance - right.spatialDistance);
  const nearest = ranked[0]!;
  const next = ranked[1];
  return next === undefined || next.spatialDistance - nearest.spatialDistance > MIN_NORMALIZED_SPATIAL_LEAD
    ? nearest
    : null;
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
    return { kind: count > MAX_POPUP_OWNERS ? 'unbounded' : 'missing' };
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
    const selected = pool.length === 1
      ? pool[0]!
      : structural.length === 0
        ? uniquelyNearestSpatialOwner(pool)
        : null;
    if (selected === null) return { kind: pool.length > 1 ? 'ambiguous' : 'missing' };
    const targetMatch = await boundedValue(
      selected.handle.evaluate((owner, intended) => owner === intended, target),
      Math.max(1, remainingUntil(deadlineAt)),
      null,
    );
    if (targetMatch === null) return { kind: 'missing' };
    const proof = selected.structural
      ? 'structural' as const
      : selected.focused
        ? 'focused' as const
        : selected.expanded
          ? 'expanded' as const
          : 'spatial' as const;
    returnedOwner = selected.handle;
    return { kind: 'resolved', owner: selected.handle, targetMatch, proof };
  } catch {
    returnedOwner = null;
    return { kind: 'missing' };
  } finally {
    await Promise.allSettled(candidates
      .filter(({ handle }) => handle !== returnedOwner)
      .map(({ handle }) => handle.dispose()));
  }
}
