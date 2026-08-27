import { type ElementHandle, type Frame, type Locator } from '../dependencies.js';
import {
  boundedValue,
  CLICK_REF_ELEMENT_CANDIDATES,
  type ObservedControlPopupSurface,
  type ObservedReferenceResolution,
  type ObservedReferenceSemantic,
  remainingUntil,
} from '../model.js';
import { popupRenderedState } from './rendering.js';

export interface PopupSurfaceSetRendering {
  anyRendered: boolean;
  allRendered: boolean;
}

export async function inspectPopupSurfaceSetRendering(
  surfaces: readonly ObservedControlPopupSurface[],
  deadlineAt: number,
): Promise<PopupSurfaceSetRendering | null> {
  if (surfaces.length === 0) return { anyRendered: false, allRendered: false };
  const states: boolean[] = [];
  for (const surface of surfaces) {
    const state = await popupRenderedState(surface.handle, deadlineAt);
    if (state === null) return null;
    states.push(state);
  }
  return {
    anyRendered: states.includes(true),
    allRendered: states.every(Boolean),
  };
}

export async function elementWithinPopupSurfaces(
  target: ElementHandle<HTMLElement>,
  surfaces: readonly ObservedControlPopupSurface[],
  deadlineAt: number,
): Promise<boolean | null> {
  if (surfaces.length === 0) return false;
  return boundedValue(
    target.evaluate((element, roots) =>
      element.isConnected && roots.some((root) =>
        root.isConnected && (root === element || root.contains(element))),
    surfaces.map(({ handle }) => handle)),
    Math.max(1, remainingUntil(deadlineAt)),
    null,
  );
}

export async function popupSurfaceSetMultiple(
  surfaces: readonly ObservedControlPopupSurface[],
  deadlineAt: number,
): Promise<boolean> {
  for (const { handle } of surfaces) {
    const multiple = await boundedValue(
      handle.evaluate((popup) => popup.getAttribute('aria-multiselectable') === 'true'),
      Math.max(1, remainingUntil(deadlineAt)),
      false,
    );
    if (multiple) return true;
  }
  return false;
}

export async function resolveUniqueSemanticReferenceInPopupSurfaces(
  frame: Frame,
  surfaces: readonly ObservedControlPopupSurface[],
  semantic: ObservedReferenceSemantic,
  deadlineAt: number,
): Promise<ObservedReferenceResolution> {
  try {
    const locator = frame.getByRole(
      semantic.role as Parameters<Frame['getByRole']>[0],
      { name: semantic.name, exact: true },
    );
    const count = await boundedValue(
      locator.count(),
      Math.max(1, remainingUntil(deadlineAt)),
      -1,
    );
    if (count < 0) return { kind: 'timeout' };
    if (count > CLICK_REF_ELEMENT_CANDIDATES) return { kind: 'ambiguous' };

    let match: { locator: Locator; handle: ElementHandle<HTMLElement> } | null = null;
    for (let index = 0; index < count; index += 1) {
      const candidateLocator = locator.nth(index);
      const handle = await boundedValue(
        candidateLocator.elementHandle() as Promise<ElementHandle<HTMLElement> | null>,
        Math.max(1, remainingUntil(deadlineAt)),
        null,
      );
      if (handle === null) continue;
      const inside = await elementWithinPopupSurfaces(handle, surfaces, deadlineAt);
      if (inside === null) {
        await handle.dispose().catch(() => undefined);
        await match?.handle.dispose().catch(() => undefined);
        return { kind: 'timeout' };
      }
      if (!inside) {
        await handle.dispose().catch(() => undefined);
        continue;
      }
      if (match !== null) {
        await handle.dispose().catch(() => undefined);
        await match.handle.dispose().catch(() => undefined);
        return { kind: 'ambiguous' };
      }
      match = { locator: candidateLocator, handle };
    }
    return match === null ? { kind: 'missing' } : { kind: 'resolved', ...match };
  } catch {
    return { kind: 'missing' };
  }
}

export async function disposePopupSurfaces(
  surfaces: readonly ObservedControlPopupSurface[],
): Promise<void> {
  await Promise.allSettled(surfaces.map(({ handle }) => handle.dispose()));
}
