import type { ElementHandle } from '../dependencies.js';
import { boundedValue, remainingUntil } from '../model.js';

const MAX_COMPOSED_POPUP_ANCESTORS = 16;

/**
 * Proves that several semantic popup roots are partitions of one newly opened
 * positioned surface, rather than independent popups that merely appeared at
 * the same time.
 */
export async function resolvePositionedPopupSurfaceEnvelope(
  surfaces: readonly ElementHandle<HTMLElement>[],
  deadlineAt: number,
): Promise<ElementHandle<HTMLElement> | null> {
  if (surfaces.length < 2) return null;
  const envelopeHandle = await boundedValue(
    surfaces[0]!.evaluateHandle((firstSurface, args) => {
      const roots = args.roots;
      if (
        roots.length < 2 ||
        roots[0] !== firstSurface ||
        roots.some((root) => !root.isConnected)
      ) return null;

      const composedParent = (element: Element): HTMLElement | null => {
        if (element.assignedSlot !== null) return element.assignedSlot;
        if (element.parentElement !== null) return element.parentElement;
        const root = element.getRootNode();
        return root instanceof ShadowRoot ? root.host as HTMLElement : null;
      };
      const composedAncestors = (element: Element): HTMLElement[] => {
        const ancestors: HTMLElement[] = [];
        let current = composedParent(element);
        for (let depth = 0; current !== null && depth < args.maximumAncestors; depth += 1) {
          ancestors.push(current);
          current = composedParent(current);
        }
        return ancestors;
      };
      const popupLike = (element: HTMLElement): boolean => {
        if (
          element === document.body ||
          element === document.documentElement ||
          element.matches('main, form')
        ) return false;
        const style = getComputedStyle(element);
        return style.position === 'absolute' ||
          style.position === 'fixed' ||
          style.position === 'sticky' ||
          element.hasAttribute('popover') ||
          element.matches('[aria-modal="true"], dialog[open]');
      };

      const paths = roots.map(composedAncestors);
      const commonEnvelope = paths[0]!.find((candidate) =>
        popupLike(candidate) && paths.slice(1).every((path) => path.includes(candidate)));
      if (commonEnvelope === undefined) return null;

      // A lower popup-like branch for any root means the common envelope may
      // only be an overlay containing independent panels. Keep that ambiguous.
      return paths.every((path) => {
        const envelopeIndex = path.indexOf(commonEnvelope);
        return envelopeIndex >= 0 && !path.slice(0, envelopeIndex).some(popupLike);
      }) ? commonEnvelope : null;
    }, {
      maximumAncestors: MAX_COMPOSED_POPUP_ANCESTORS,
      roots: surfaces,
    }),
    Math.max(1, remainingUntil(deadlineAt)),
    null,
  );
  const envelope = envelopeHandle?.asElement() as ElementHandle<HTMLElement> | null;
  if (envelope === null) await envelopeHandle?.dispose().catch(() => undefined);
  return envelope;
}
