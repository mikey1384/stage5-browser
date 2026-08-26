import { type ElementHandle, type Frame } from '../dependencies.js';
import { boundedValue, remainingUntil } from '../model.js';

const POPUP_OWNER_SELECTOR = '[aria-controls], [aria-owns], [aria-haspopup]';
const MAX_POPUP_OWNERS = 100;

export type PopupOwnerResolution =
  | {
      kind: 'resolved';
      owner: ElementHandle<HTMLElement>;
      targetMatch: boolean;
      proof: 'expanded' | 'focused' | 'structural';
    }
  | { kind: 'ambiguous' | 'missing' | 'unbounded' };

interface OwnerCandidate {
  handle: ElementHandle<HTMLElement>;
  expanded: boolean;
  focused: boolean;
  structural: boolean;
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
          return {
            structural: (surface.id.length > 0 && ids.includes(surface.id))
              || control.contains(surface)
              || (control.id.length > 0 && labelledBy.includes(control.id)),
            focused: control.ownerDocument.activeElement === control
              || control.contains(control.ownerDocument.activeElement),
            expanded: control.getAttribute('aria-expanded') === 'true',
          };
        }, popup),
        Math.max(1, remainingUntil(deadlineAt)),
        null,
      );
      if (relation === null || (!relation.structural && !relation.focused && !relation.expanded)) {
        await handle.dispose().catch(() => undefined);
        continue;
      }
      candidates.push({ handle, ...relation });
    }

    const structural = candidates.filter((candidate) => candidate.structural);
    const focused = candidates.filter((candidate) => !candidate.structural && candidate.focused);
    const expanded = candidates.filter((candidate) =>
      !candidate.structural && !candidate.focused && candidate.expanded);
    const pool = structural.length > 0
      ? structural
      : focused.length > 0
        ? focused
        : expanded;
    if (pool.length !== 1) {
      return { kind: pool.length > 1 ? 'ambiguous' : 'missing' };
    }
    const selected = pool[0]!;
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
        : 'expanded' as const;
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
