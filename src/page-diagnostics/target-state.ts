import type { ElementHandle, Locator } from 'playwright';

import type { SafeTargetState } from './types.js';

export function inspectTargetState(locator: Locator): Promise<SafeTargetState | null>;
export function inspectTargetState(
  locator: ElementHandle<HTMLElement | SVGElement>,
): Promise<SafeTargetState | null>;
export async function inspectTargetState(
  locator: Locator | ElementHandle<HTMLElement | SVGElement>,
): Promise<SafeTargetState | null> {
  const inspect = (element: Element): SafeTargetState => {
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
    if (!element.isConnected) {
      throw new Error('Target element is detached.');
    }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0';
    let visibleLeft = Math.max(0, rect.left);
    let visibleRight = Math.min(window.innerWidth, rect.right);
    let visibleTop = Math.max(0, rect.top);
    let visibleBottom = Math.min(window.innerHeight, rect.bottom);
    for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
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
    const inViewport = visible && visibleRight > visibleLeft && visibleBottom > visibleTop;
    const width = Math.max(0, visibleRight - visibleLeft);
    const height = Math.max(0, visibleBottom - visibleTop);
    const points = [
      [0.5, 0.5],
      [0.2, 0.5], [0.8, 0.5], [0.5, 0.2], [0.5, 0.8],
      [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8],
    ] as const;
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
    const hits = inViewport
      ? points.map(([xRatio, yRatio]) => document.elementFromPoint(
        visibleLeft + width * xRatio,
        visibleTop + height * yRatio,
      ))
      : [];
    const safeHitIndex = hits.findIndex(composedContains);
    const firstHit = hits.find((hit) => hit !== null) ?? null;
    const receivesPointerEvents = safeHitIndex >= 0
      ? true
      : firstHit === null ? null : false;
    const pointerHitPoint = safeHitIndex === 0
      ? 'center' as const
      : safeHitIndex > 0 ? 'alternate' as const : null;
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
      visible,
      enabled: !htmlDisabled && !ariaDisabled,
      inViewport,
      receivesPointerEvents,
      pointerHitPoint,
      tagName: element.tagName.toLocaleLowerCase(),
      role: semanticRole(element),
      coveredBy,
    };
  };
  try {
    if ('elementHandle' in locator) {
      return await locator.evaluate(inspect);
    }
    return await locator.evaluate(inspect);
  } catch {
    return null;
  }
}
