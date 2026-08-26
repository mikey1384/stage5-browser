import type { ElementHandle, Locator } from 'playwright';

import type { SafeTargetState } from './types.js';

interface ExactTargetHitPoint {
  page: { x: number; y: number };
  element: { x: number; y: number };
}

interface ExactTargetGeometry {
  state: SafeTargetState;
  hitPoint: ExactTargetHitPoint | null;
}

/**
 * Runs inside the target document. Keep this function self-contained so every
 * exact-target transport can use the browser's canonical hit-test result.
 */
export function inspectExactTargetGeometry(element: Element): ExactTargetGeometry {
  const semanticRole = (candidate: Element): string | null => {
    const explicit = candidate.getAttribute('role')?.trim().split(/\s+/)[0];
    if (explicit !== undefined && explicit.length > 0) return explicit;
    const tagName = candidate.tagName.toLocaleLowerCase();
    if (tagName === 'button' || tagName === 'summary') return 'button';
    if ((tagName === 'a' || tagName === 'area') && candidate.hasAttribute('href')) return 'link';
    if (tagName === 'textarea') return 'textbox';
    if (tagName === 'select') {
      const select = candidate as HTMLSelectElement;
      return select.multiple || select.size > 1 ? 'listbox' : 'combobox';
    }
    if (tagName === 'input') {
      const type = (candidate as HTMLInputElement).type.toLocaleLowerCase();
      if (type === 'button' || type === 'image' || type === 'reset' || type === 'submit') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (type !== 'hidden') return 'textbox';
    }
    if (/^h[1-6]$/.test(tagName)) return 'heading';
    if (tagName === 'img' && candidate.hasAttribute('alt')) return 'img';
    if (tagName === 'main') return 'main';
    if (tagName === 'nav') return 'navigation';
    if (tagName === 'dialog') return 'dialog';
    return null;
  };
  if (!element.isConnected) throw new Error('Target element is detached.');

  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const visible = rect.width > 0 && rect.height > 0 &&
    style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  let visibleLeft = Math.max(0, rect.left);
  let visibleRight = Math.min(window.innerWidth, rect.right);
  let visibleTop = Math.max(0, rect.top);
  let visibleBottom = Math.min(window.innerHeight, rect.bottom);
  const composedParent = (candidate: Element): HTMLElement | null => {
    if (candidate.assignedSlot !== null) return candidate.assignedSlot;
    if (candidate.parentElement !== null) return candidate.parentElement;
    const root = candidate.getRootNode();
    return root instanceof ShadowRoot ? root.host as HTMLElement : null;
  };
  const visited = new Set<Element>();
  for (
    let ancestor = composedParent(element);
    ancestor !== null && !visited.has(ancestor);
    ancestor = composedParent(ancestor)
  ) {
    visited.add(ancestor);
    const ancestorStyle = getComputedStyle(ancestor);
    const ancestorRect = ancestor.getBoundingClientRect();
    if (/(auto|clip|hidden|scroll)/u.test(ancestorStyle.overflowX)) {
      visibleLeft = Math.max(visibleLeft, ancestorRect.left);
      visibleRight = Math.min(visibleRight, ancestorRect.right);
    }
    if (/(auto|clip|hidden|scroll)/u.test(ancestorStyle.overflowY)) {
      visibleTop = Math.max(visibleTop, ancestorRect.top);
      visibleBottom = Math.min(visibleBottom, ancestorRect.bottom);
    }
  }

  const composedContains = (candidate: Element | null): boolean => {
    let current: Node | null = candidate;
    const visited = new Set<Node>();
    while (current !== null && !visited.has(current)) {
      if (current === element) return true;
      visited.add(current);
      if (current instanceof Element && current.assignedSlot !== null) {
        current = current.assignedSlot;
        continue;
      }
      const parent = current.parentNode;
      current = parent instanceof ShadowRoot ? parent.host : parent;
    }
    return false;
  };
  type CandidatePoint = { x: number; y: number; kind: 'center' | 'alternate' };
  const pointsForBox = (
    left: number,
    right: number,
    top: number,
    bottom: number,
    centerKind: CandidatePoint['kind'],
  ): CandidatePoint[] => {
    if (right <= left || bottom <= top) return [];
    const width = right - left;
    const height = bottom - top;
    return [
      { x: left + width * 0.5, y: top + height * 0.5, kind: centerKind },
      { x: left + width * 0.2, y: top + height * 0.5, kind: 'alternate' },
      { x: left + width * 0.8, y: top + height * 0.5, kind: 'alternate' },
      { x: left + width * 0.5, y: top + height * 0.2, kind: 'alternate' },
      { x: left + width * 0.5, y: top + height * 0.8, kind: 'alternate' },
      { x: left + width * 0.2, y: top + height * 0.2, kind: 'alternate' },
      { x: left + width * 0.8, y: top + height * 0.2, kind: 'alternate' },
      { x: left + width * 0.2, y: top + height * 0.8, kind: 'alternate' },
      { x: left + width * 0.8, y: top + height * 0.8, kind: 'alternate' },
    ];
  };

  const inferredInViewport = visible && visibleRight > visibleLeft && visibleBottom > visibleTop;
  const primaryPoints = inferredInViewport
    ? pointsForBox(visibleLeft, visibleRight, visibleTop, visibleBottom, 'center')
    : [];
  const hitObservation: {
    firstHit: Element | null;
    exactPoint: CandidatePoint | null;
  } = { firstHit: null, exactPoint: null };
  const inspectPoints = (points: CandidatePoint[]): void => {
    for (const point of points) {
      const hit = document.elementFromPoint(point.x, point.y);
      if (hitObservation.firstHit === null && hit !== null) hitObservation.firstHit = hit;
      if (composedContains(hit)) {
        hitObservation.exactPoint = point;
        return;
      }
    }
  };
  inspectPoints(primaryPoints);

  // CSS overflow clips do not apply to every positioned descendant. When the
  // inferred ancestor intersection disagrees, an exact browser hit is the
  // stronger, fail-closed proof that this particular target is onscreen.
  if (hitObservation.exactPoint === null && visible) {
    for (const clientRect of [...element.getClientRects()].slice(0, 20)) {
      inspectPoints(pointsForBox(
        Math.max(0, clientRect.left),
        Math.min(window.innerWidth, clientRect.right),
        Math.max(0, clientRect.top),
        Math.min(window.innerHeight, clientRect.bottom),
        'alternate',
      ));
      if (hitObservation.exactPoint !== null) break;
    }
  }

  const { exactPoint, firstHit } = hitObservation;
  const exactHitObserved = exactPoint !== null;
  const inViewport = inferredInViewport || exactHitObserved;
  const receivesPointerEvents = exactHitObserved
    ? true
    : inferredInViewport
      ? firstHit === null ? null : false
      : null;
  const htmlDisabled = 'disabled' in element && Boolean((element as HTMLButtonElement).disabled);
  const ariaDisabled = element.getAttribute('aria-disabled') === 'true';
  const coveredBy = receivesPointerEvents === false && firstHit !== null
    ? {
        tagName: firstHit.tagName.toLocaleLowerCase(),
        role: semanticRole(firstHit),
        pointerEvents: getComputedStyle(firstHit).pointerEvents,
      }
    : null;
  return {
    state: {
      visible,
      enabled: !htmlDisabled && !ariaDisabled,
      inViewport,
      viewportEvidence: inferredInViewport
        ? 'clipped_geometry'
        : exactHitObserved ? 'exact_hit_test_override' : 'none',
      receivesPointerEvents,
      pointerHitPoint: exactPoint?.kind ?? null,
      tagName: element.tagName.toLocaleLowerCase(),
      role: semanticRole(element),
      coveredBy,
    },
    hitPoint: exactPoint === null
      ? null
      : {
          page: { x: exactPoint.x, y: exactPoint.y },
          element: { x: exactPoint.x - rect.left, y: exactPoint.y - rect.top },
        },
  };
}

export function inspectTargetState(locator: Locator): Promise<SafeTargetState | null>;
export function inspectTargetState(
  locator: ElementHandle<HTMLElement | SVGElement>,
): Promise<SafeTargetState | null>;
export async function inspectTargetState(
  locator: Locator | ElementHandle<HTMLElement | SVGElement>,
): Promise<SafeTargetState | null> {
  try {
    const geometry = 'elementHandle' in locator
      ? await locator.evaluate(inspectExactTargetGeometry)
      : await locator.evaluate(inspectExactTargetGeometry);
    return geometry.state;
  } catch {
    return null;
  }
}
