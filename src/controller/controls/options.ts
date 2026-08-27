import { randomUUID } from 'node:crypto';

import { type ElementHandle, type Frame, type Locator } from '../dependencies.js';
import { boundedValue, CONTROL_INSPECTION_SCROLL_SETTLE_MS, CONTROL_OPTION_SELECTOR, MAX_CONTROL_INSPECTION_SCROLL_STEPS, MAX_CONTROL_POPUP_OPTION_CANDIDATES, type ObservedControlOption, type ObservedControlPopupSurface, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import { inspectControlOptionElement } from './option-state.js';

const OPTION_ROLES = new Set([
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'treeitem',
] as const);

export const controlOptionOperations = {
  async inspectControlDescriptor(
    handle: ElementHandle<HTMLElement>,
    deadlineAt: number,
  ): Promise<{
    kind: 'custom_popup' | 'native_select';
    expanded: boolean | null;
    multiple: boolean;
    disabled: boolean;
  } | null> {
    return boundedValue(
      handle.evaluate((element) => {
        if (!element.isConnected) return null;
        const nativeSelect = element instanceof HTMLSelectElement;
        const expanded = element.getAttribute('aria-expanded');
        return {
          kind: nativeSelect ? 'native_select' as const : 'custom_popup' as const,
          expanded: expanded === null ? null : expanded === 'true',
          multiple: nativeSelect
            ? element.multiple
            : element.getAttribute('aria-multiselectable') === 'true',
          disabled: nativeSelect
            ? element.disabled
            : element.getAttribute('aria-disabled') === 'true',
        };
      }),
      Math.max(1, remainingUntil(deadlineAt)),
      null,
    );
  },

  async collectNativeControlOptions(
    controlLocator: Locator,
    controlHandle: ElementHandle<HTMLElement>,
    maxOptions: number,
    deadlineAt: number,
  ): Promise<{ options: Map<string, ObservedControlOption>; complete: boolean }> {
    const optionLocator = controlLocator.locator('option');
    const total = await boundedValue(
      optionLocator.count(),
      Math.max(1, remainingUntil(deadlineAt)),
      -1,
    );
    const options = new Map<string, ObservedControlOption>();
    if (total < 0) return { options, complete: false };
    for (let index = 0; index < Math.min(total, maxOptions); index += 1) {
      const locator = optionLocator.nth(index);
      const handle = await boundedValue(
        locator.elementHandle() as Promise<ElementHandle<HTMLElement> | null>,
        Math.max(1, remainingUntil(deadlineAt)),
        null,
      );
      if (handle === null) continue;
      const state = await boundedValue(
        handle.evaluate((option) => {
          if (!(option instanceof HTMLOptionElement) || !option.isConnected) return null;
          return {
            name: option.label.trim() || option.textContent?.replace(/\s+/g, ' ').trim() || '',
            selected: option.selected,
            disabled: option.disabled,
          };
        }),
        Math.max(1, remainingUntil(deadlineAt)),
        null,
      );
      if (state === null || state.name.length === 0) {
        await handle.dispose().catch(() => undefined);
        continue;
      }
      const optionId = `option-${randomUUID()}`;
      options.set(optionId, {
        locator,
        handle,
        observation: { optionId, name: state.name.slice(0, 500), role: 'option', selected: state.selected, disabled: state.disabled },
      });
    }
    const connected = await boundedValue(
      controlHandle.evaluate((control) => control.isConnected),
      Math.max(1, remainingUntil(deadlineAt)),
      false,
    );
    return { options, complete: connected && total <= maxOptions };
  },

  async collectPopupControlOptions(
    frame: Frame,
    popupSurfaces: ObservedControlPopupSurface[],
    maxOptions: number,
    deadlineAt: number,
  ): Promise<{
    options: Map<string, ObservedControlOption>;
    complete: boolean;
    scrollSteps: number;
    boundaryReached: boolean;
    multipleSignal: boolean;
  }> {
    const options = new Map<string, ObservedControlOption>();
    const optionsBySemantic = new Map<string, ObservedControlOption[]>();
    let scrollSteps = 0;
    let boundaryReached = false;
    let candidateScanBounded = true;
    let multipleSignal = false;

    const capture = async (): Promise<boolean> => {
      const occurrences = new Map<string, number>();
      let scanned = 0;
      const inferredSurfaces = popupSurfaces.filter(({ locator }) => locator === null);
      const groups = [
        ...popupSurfaces
          .filter((surface) => surface.locator !== null)
          .map((surface) => ({
            locator: surface.locator!.locator(CONTROL_OPTION_SELECTOR),
            surfaces: [surface],
          })),
        ...(inferredSurfaces.length === 0 ? [] : [{
          locator: frame.locator(CONTROL_OPTION_SELECTOR),
          surfaces: inferredSurfaces,
        }]),
      ];
      for (const group of groups) {
        const { locator } = group;
        const count = await boundedValue(locator.count(), Math.max(1, remainingUntil(deadlineAt)), -1);
        if (count < 0 || scanned + count > MAX_CONTROL_POPUP_OPTION_CANDIDATES) {
          candidateScanBounded = false;
          return false;
        }
        scanned += count;
        for (let index = 0; index < count && options.size < maxOptions; index += 1) {
          const candidate = locator.nth(index);
          const handle = await boundedValue(
            candidate.elementHandle() as Promise<ElementHandle<HTMLElement> | null>,
            Math.max(1, remainingUntil(deadlineAt)),
            null,
          );
          if (handle === null) continue;
          const insidePopup = await boundedValue(
            handle.evaluate((option, popups) =>
              option.isConnected && popups.some((popup) =>
                popup.isConnected && (popup === option || popup.contains(option))),
            group.surfaces.map(({ handle: popup }) => popup)),
            Math.max(1, remainingUntil(deadlineAt)),
            false,
          );
          if (!insidePopup) {
            await handle.dispose().catch(() => undefined);
            continue;
          }
          const semantic = await this.controlOptionSemantic(handle, deadlineAt);
          if (semantic === null) {
            await handle.dispose().catch(() => undefined);
            continue;
          }
          const { multipleSignal: optionMultipleSignal, ...observation } = semantic;
          multipleSignal ||= optionMultipleSignal;
          const key = `${observation.role}\u0000${observation.name}`;
          const occurrence = occurrences.get(key) ?? 0;
          occurrences.set(key, occurrence + 1);
          const known = optionsBySemantic.get(key) ?? [];
          const existing = known[occurrence];
          if (existing !== undefined) {
            const connected = await boundedValue(
              existing.handle.evaluate((element) => element.isConnected),
              Math.max(1, remainingUntil(deadlineAt)),
              false,
            );
            if (connected) {
              await handle.dispose().catch(() => undefined);
              continue;
            }
            await existing.handle.dispose().catch(() => undefined);
            existing.handle = handle;
            existing.locator = candidate;
            existing.observation = { ...existing.observation, ...observation };
            continue;
          }
          const optionId = `option-${randomUUID()}`;
          const observed: ObservedControlOption = {
            locator: candidate,
            handle,
            observation: { optionId, ...observation },
          };
          options.set(optionId, observed);
          known.push(observed);
          optionsBySemantic.set(key, known);
        }
      }
      return true;
    };

    for (;;) {
      if (!await capture()) break;
      if (options.size >= maxOptions || scrollSteps >= MAX_CONTROL_INSPECTION_SCROLL_STEPS) break;
      let moved = false;
      let allAtBoundary = true;
      for (const { handle } of popupSurfaces) {
        const movement = await boundedValue(
          handle.evaluate((surface, optionSelector) => {
            if (!surface.isConnected) return null;
            const candidates = [surface, ...Array.from(surface.querySelectorAll<HTMLElement>('*'))]
              .filter((candidate) => {
                const style = getComputedStyle(candidate);
                const scrollable = /^(auto|hidden|overlay|scroll)$/u.test(style.overflowY) &&
                  candidate.scrollHeight > candidate.clientHeight + 1;
                return scrollable && candidate.querySelector(optionSelector) !== null;
              });
            for (const candidate of candidates) {
              const before = candidate.scrollTop;
              const maximum = Math.max(0, candidate.scrollHeight - candidate.clientHeight);
              if (before >= maximum - 1) continue;
              candidate.scrollTop = Math.min(maximum, before + Math.max(1, candidate.clientHeight * 0.75));
              if (Math.abs(candidate.scrollTop - before) > 0.5) {
                return { moved: true, boundary: candidate.scrollTop >= maximum - 1 };
              }
            }
            return { moved: false, boundary: true };
          }, CONTROL_OPTION_SELECTOR),
          Math.max(1, remainingUntil(deadlineAt)),
          null,
        );
        if (movement === null) {
          allAtBoundary = false;
          continue;
        }
        allAtBoundary &&= movement.boundary;
        if (movement.moved) {
          moved = true;
          boundaryReached = movement.boundary && popupSurfaces.length === 1;
          break;
        }
      }
      if (!moved) {
        boundaryReached = allAtBoundary;
        break;
      }
      scrollSteps += 1;
      const settle = Math.min(CONTROL_INSPECTION_SCROLL_SETTLE_MS, remainingUntil(deadlineAt));
      if (settle > 0) await new Promise((resolve) => setTimeout(resolve, settle));
      if (boundaryReached) {
        await capture();
        break;
      }
    }
    return {
      options,
      complete: candidateScanBounded && boundaryReached && options.size < maxOptions,
      scrollSteps,
      boundaryReached,
      multipleSignal,
    };
  },

  async controlOptionSemantic(
    handle: ElementHandle<HTMLElement>,
    deadlineAt: number,
  ): Promise<{
    name: string;
    role: 'menuitem' | 'menuitemcheckbox' | 'menuitemradio' | 'option' | 'radio' | 'treeitem';
    selected: boolean | null;
    disabled: boolean;
    multipleSignal: boolean;
  } | null> {
    const state = await boundedValue(
      handle.evaluate(inspectControlOptionElement),
      Math.max(1, remainingUntil(deadlineAt)),
      null,
    );
    if (state === null || state.name.length === 0 || !OPTION_ROLES.has(state.role as never)) return null;
    return {
      name: state.name.slice(0, 500),
      role: state.role as 'menuitem' | 'menuitemcheckbox' | 'menuitemradio' | 'option' | 'radio' | 'treeitem',
      selected: state.selected,
      disabled: state.disabled,
      multipleSignal: state.multipleSignal,
    };
  },

  async controlOptionSelectedState(locator: Locator): Promise<boolean | null> {
    try {
      return (await locator.evaluate(inspectControlOptionElement))?.selected ?? null;
    } catch {
      return null;
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type ControlOptionOperations = typeof controlOptionOperations;
