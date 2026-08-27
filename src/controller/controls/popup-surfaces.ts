import { type ControlPopupSurfaceProof, type ElementHandle, type Frame, type Locator } from '../dependencies.js';
import { boundedValue, CONTROL_POPUP_OPTION_SELECTOR, CONTROL_POPUP_SELECTOR, MAX_CONTROL_POPUP_OPTION_CANDIDATES, remainingUntil } from '../model.js';
import { popupRendered, popupRenderedState } from './rendering.js';

const MAX_POPUP_SURFACES = 50;
const MAX_POPUP_ANCESTORS = 16;
const MIN_POPUP_PARTITION_GAP_PX = 32;

export interface DiscoveredPopupSurface {
  locator: Locator | null;
  handle: ElementHandle<HTMLElement>;
  surfaceProof: ControlPopupSurfaceProof;
}

export type PopupSurfaceDiscovery =
  | { kind: 'bounded'; surfaces: DiscoveredPopupSurface[] }
  | { kind: 'unbounded'; surfaces: [] };

export async function discoverControlPopupSurfaces(
  frame: Frame,
  deadlineAt: number,
): Promise<PopupSurfaceDiscovery> {
  const surfaces: DiscoveredPopupSurface[] = [];
  const semantic = frame.locator(CONTROL_POPUP_SELECTOR);
  const semanticCount = await boundedValue(
    semantic.count(),
    Math.max(1, remainingUntil(deadlineAt)),
    -1,
  );
  if (semanticCount < 0 || semanticCount > MAX_POPUP_SURFACES) {
    return { kind: 'unbounded', surfaces: [] };
  }

  try {
    for (let index = 0; index < semanticCount; index += 1) {
      const locator = semantic.nth(index);
      const handle = await boundedValue(
        locator.elementHandle() as Promise<ElementHandle<HTMLElement> | null>,
        Math.max(1, remainingUntil(deadlineAt)),
        null,
      );
      if (handle !== null) surfaces.push({ locator, handle, surfaceProof: 'semantic_role' });
    }

    const optionLocator = frame.locator(CONTROL_POPUP_OPTION_SELECTOR);
    const optionCount = await boundedValue(
      optionLocator.count(),
      Math.max(1, remainingUntil(deadlineAt)),
      -1,
    );
    if (optionCount < 0 || optionCount > MAX_CONTROL_POPUP_OPTION_CANDIDATES) {
      await disposeSurfaces(surfaces);
      return { kind: 'unbounded', surfaces: [] };
    }

    for (let index = 0; index < optionCount; index += 1) {
      const option = await boundedValue(
        optionLocator.nth(index).elementHandle() as Promise<ElementHandle<HTMLElement> | null>,
        Math.max(1, remainingUntil(deadlineAt)),
        null,
      );
      if (option === null) continue;
      let root: ElementHandle<HTMLElement> | null = null;
      try {
        const rootHandle = await boundedValue(
          option.evaluateHandle((element, args) => {
            const rendered = (candidate: Element): boolean => {
              const rect = candidate.getBoundingClientRect();
              const style = getComputedStyle(candidate);
              return rect.width > 0 && rect.height > 0 &&
                rect.right > 0 && rect.bottom > 0 &&
                rect.left < innerWidth && rect.top < innerHeight &&
                style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            };
            if (!element.isConnected || !rendered(element)) return null;
            const composedParent = (candidate: Element): HTMLElement | null => {
              if (candidate.assignedSlot !== null) return candidate.assignedSlot;
              if (candidate.parentElement !== null) return candidate.parentElement;
              const rootNode = candidate.getRootNode();
              return rootNode instanceof ShadowRoot ? rootNode.host as HTMLElement : null;
            };
            let group: HTMLElement | null = null;
            let scrollSurface: HTMLElement | null = null;
            let candidate = composedParent(element);
            for (let depth = 0; candidate !== null && depth < args.maximumAncestors; depth += 1) {
              if (candidate === document.body || candidate === document.documentElement) break;
              if (candidate.matches(args.semanticSurfaceSelector)) return candidate;
              const descendantOptions = candidate.querySelectorAll(args.optionSelector).length;
              if (group === null && descendantOptions > 1) group = candidate;
              const style = getComputedStyle(candidate);
              const scrollable = (
                /^(auto|hidden|overlay|scroll)$/u.test(style.overflowX) &&
                candidate.scrollWidth > candidate.clientWidth + 1
              ) || (
                /^(auto|hidden|overlay|scroll)$/u.test(style.overflowY) &&
                candidate.scrollHeight > candidate.clientHeight + 1
              );
              if (scrollSurface === null && scrollable) scrollSurface = candidate;
              const positioned = style.position === 'absolute' || style.position === 'fixed' ||
                style.position === 'sticky' ||
                (style.position === 'relative' && style.zIndex !== 'auto') ||
                candidate.hasAttribute('popover') ||
                candidate.matches('[aria-modal="true"], dialog[open]');
              if (positioned) {
                const options = [...candidate.querySelectorAll(args.optionSelector)]
                  .filter((option): option is HTMLElement => option instanceof HTMLElement && rendered(option));
                let partition: HTMLElement | null = null;
                if (options.length > 1) {
                  for (
                    let branch = composedParent(element);
                    branch !== null && branch !== candidate;
                    branch = composedParent(branch)
                  ) {
                    const branchOptionCount = branch.querySelectorAll(args.optionSelector).length;
                    if (branchOptionCount > 0 && branchOptionCount < options.length && rendered(branch)) {
                      partition = branch;
                    }
                  }
                }
                if (partition !== null) {
                  const partitionRect = partition.getBoundingClientRect();
                  const outsideOptions = options.filter((option) => !partition!.contains(option));
                  const minimumGap = outsideOptions.reduce((minimum, option) => {
                    const optionRect = option.getBoundingClientRect();
                    const horizontalGap = Math.max(
                      0,
                      partitionRect.left - optionRect.right,
                      optionRect.left - partitionRect.right,
                    );
                    const verticalGap = Math.max(
                      0,
                      partitionRect.top - optionRect.bottom,
                      optionRect.top - partitionRect.bottom,
                    );
                    return Math.min(minimum, Math.hypot(horizontalGap, verticalGap));
                  }, Number.POSITIVE_INFINITY);
                  if (minimumGap >= args.minimumPartitionGapPx) {
                    return scrollSurface !== null && partition.contains(scrollSurface)
                      ? scrollSurface
                      : partition;
                  }
                }
                return scrollSurface ?? group ?? candidate;
              }
              candidate = composedParent(candidate);
            }
            return null;
          }, {
            maximumAncestors: MAX_POPUP_ANCESTORS,
            minimumPartitionGapPx: MIN_POPUP_PARTITION_GAP_PX,
            optionSelector: CONTROL_POPUP_OPTION_SELECTOR,
            semanticSurfaceSelector: CONTROL_POPUP_SELECTOR,
          }),
          Math.max(1, remainingUntil(deadlineAt)),
          null,
        );
        root = rootHandle?.asElement() as ElementHandle<HTMLElement> | null;
        if (root === null) {
          await rootHandle?.dispose().catch(() => undefined);
          continue;
        }
        if (!await popupRendered(root, deadlineAt) || await containsSameSurface(surfaces, root, deadlineAt)) {
          await root.dispose().catch(() => undefined);
          root = null;
          continue;
        }
        surfaces.push({ locator: null, handle: root, surfaceProof: 'positioned_option_group' });
        root = null;
        if (surfaces.length > MAX_POPUP_SURFACES) {
          await disposeSurfaces(surfaces);
          return { kind: 'unbounded', surfaces: [] };
        }
      } finally {
        await option.dispose().catch(() => undefined);
        await root?.dispose().catch(() => undefined);
      }
    }
    return { kind: 'bounded', surfaces };
  } catch {
    await disposeSurfaces(surfaces);
    return { kind: 'unbounded', surfaces: [] };
  }
}

export async function renderedControlPopupSurfaceCount(
  frame: Frame,
  deadlineAt: number,
): Promise<number | null> {
  const discovery = await discoverControlPopupSurfaces(frame, deadlineAt);
  if (discovery.kind === 'unbounded') return null;
  try {
    let renderedCount = 0;
    for (const { handle } of discovery.surfaces) {
      const rendered = await popupRenderedState(handle, deadlineAt);
      if (rendered === null) return null;
      if (rendered) renderedCount += 1;
    }
    return renderedCount;
  } finally {
    await disposeSurfaces(discovery.surfaces);
  }
}

async function containsSameSurface(
  surfaces: DiscoveredPopupSurface[],
  target: ElementHandle<HTMLElement>,
  deadlineAt: number,
): Promise<boolean> {
  for (const surface of surfaces) {
    const same = await boundedValue(
      surface.handle.evaluate((candidate, intended) => candidate === intended, target),
      Math.max(1, remainingUntil(deadlineAt)),
      null,
    );
    if (same === true) return true;
  }
  return false;
}

export async function disposeSurfaces(surfaces: DiscoveredPopupSurface[]): Promise<void> {
  await Promise.allSettled(surfaces.map(({ handle }) => handle.dispose()));
}
