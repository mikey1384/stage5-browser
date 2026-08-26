import { randomUUID } from 'node:crypto';

import { type ElementHandle, type Frame, type Locator } from '../dependencies.js';
import { boundedValue, CONTROL_INSPECTION_SCROLL_SETTLE_MS, CONTROL_OPTION_SELECTOR, CONTROL_POPUP_SELECTOR, MAX_CONTROL_INSPECTION_SCROLL_STEPS, type ObservedControlOption, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

const OPTION_ROLES = new Set([
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'treeitem',
] as const);

interface PopupCandidate {
  locator: Locator;
  handle: ElementHandle<HTMLElement>;
  explicit: boolean;
  structurallyRelated: boolean;
  rendered: boolean;
}

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

  async associatedControlPopup(
    frame: Frame,
    controlHandle: ElementHandle<HTMLElement>,
    deadlineAt: number,
    allowUniqueRenderedAfterDispatch = false,
  ): Promise<{ locator: Locator; handle: ElementHandle<HTMLElement> } | null | 'ambiguous'> {
    const relation = await boundedValue(
      controlHandle.evaluate((control) => ({
        ids: [...(control.getAttribute('aria-controls') ?? '').split(/\s+/),
          ...(control.getAttribute('aria-owns') ?? '').split(/\s+/)].filter(Boolean),
        controlId: control.id,
        expanded: control.getAttribute('aria-expanded') === 'true',
        focused: control.ownerDocument.activeElement === control || control.contains(control.ownerDocument.activeElement),
      })),
      Math.max(1, remainingUntil(deadlineAt)),
      null,
    );
    if (relation === null) return null;

    const surfaces = frame.locator(CONTROL_POPUP_SELECTOR);
    const count = await boundedValue(
      surfaces.count(),
      Math.max(1, remainingUntil(deadlineAt)),
      -1,
    );
    if (count < 0 || count > 50) return count > 50 ? 'ambiguous' : null;
    const candidates: PopupCandidate[] = [];
    try {
      for (let index = 0; index < count; index += 1) {
        const locator = surfaces.nth(index);
        const handle = await boundedValue(
          locator.elementHandle() as Promise<ElementHandle<HTMLElement> | null>,
          Math.max(1, remainingUntil(deadlineAt)),
          null,
        );
        if (handle === null) continue;
        const state = await boundedValue(
          controlHandle.evaluate((control, surface) => {
            if (!control.isConnected || !surface.isConnected) return null;
            const rect = surface.getBoundingClientRect();
            const style = getComputedStyle(surface);
            const rendered = rect.width > 0 && rect.height > 0 &&
              rect.right > 0 && rect.bottom > 0 &&
              rect.left < innerWidth && rect.top < innerHeight &&
              style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            const labelledBy = (surface.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
            return {
              explicit: surface.id.length > 0 && [
                ...(control.getAttribute('aria-controls') ?? '').split(/\s+/),
                ...(control.getAttribute('aria-owns') ?? '').split(/\s+/),
              ].includes(surface.id),
              structurallyRelated: control === surface || control.contains(surface) ||
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
        candidates.push({ locator, handle, ...state });
      }

      const explicit = candidates.filter((candidate) => candidate.explicit);
      const structural = candidates.filter((candidate) => candidate.structurallyRelated && candidate.rendered);
      const rendered = candidates.filter((candidate) => candidate.rendered);
      const selected = explicit.length === 1
        ? explicit[0]
        : structural.length === 1
          ? structural[0]
          : (relation.expanded || relation.focused) && rendered.length === 1
            ? rendered[0]
            : allowUniqueRenderedAfterDispatch && rendered.length === 1
              ? rendered[0]
            : null;
      const ambiguous = explicit.length > 1 || structural.length > 1 ||
        ((relation.expanded || relation.focused) && rendered.length > 1);
      for (const candidate of candidates) {
        if (candidate !== selected) await candidate.handle.dispose().catch(() => undefined);
      }
      return selected ?? (ambiguous ? 'ambiguous' : null);
    } catch (error) {
      await Promise.allSettled(candidates.map(({ handle }) => handle.dispose()));
      throw error;
    }
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
    popupLocator: Locator,
    popupHandle: ElementHandle<HTMLElement>,
    maxOptions: number,
    deadlineAt: number,
  ): Promise<{
    options: Map<string, ObservedControlOption>;
    complete: boolean;
    scrollSteps: number;
    boundaryReached: boolean;
  }> {
    const options = new Map<string, ObservedControlOption>();
    const optionsBySemantic = new Map<string, ObservedControlOption[]>();
    let scrollSteps = 0;
    let boundaryReached = false;

    const capture = async (): Promise<void> => {
      const locator = popupLocator.locator(CONTROL_OPTION_SELECTOR);
      const count = await boundedValue(locator.count(), Math.max(1, remainingUntil(deadlineAt)), -1);
      if (count < 0) return;
      const occurrences = new Map<string, number>();
      for (let index = 0; index < count && options.size < maxOptions; index += 1) {
        const candidate = locator.nth(index);
        const handle = await boundedValue(
          candidate.elementHandle() as Promise<ElementHandle<HTMLElement> | null>,
          Math.max(1, remainingUntil(deadlineAt)),
          null,
        );
        if (handle === null) continue;
        const semantic = await this.controlOptionSemantic(candidate, handle, deadlineAt);
        if (semantic === null) {
          await handle.dispose().catch(() => undefined);
          continue;
        }
        const key = `${semantic.role}\u0000${semantic.name}`;
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
          existing.observation = { ...existing.observation, ...semantic };
          continue;
        }
        const optionId = `option-${randomUUID()}`;
        const observed: ObservedControlOption = {
          locator: candidate,
          handle,
          observation: { optionId, ...semantic },
        };
        options.set(optionId, observed);
        known.push(observed);
        optionsBySemantic.set(key, known);
      }
    };

    for (;;) {
      await capture();
      if (options.size >= maxOptions || scrollSteps >= MAX_CONTROL_INSPECTION_SCROLL_STEPS) break;
      const movement = await boundedValue(
        popupHandle.evaluate((surface) => {
          if (!surface.isConnected) return null;
          const before = surface.scrollTop;
          const maximum = Math.max(0, surface.scrollHeight - surface.clientHeight);
          if (before >= maximum - 1) return { moved: false, boundary: true };
          surface.scrollTop = Math.min(maximum, before + Math.max(1, surface.clientHeight * 0.75));
          return { moved: Math.abs(surface.scrollTop - before) > 0.5, boundary: surface.scrollTop >= maximum - 1 };
        }),
        Math.max(1, remainingUntil(deadlineAt)),
        null,
      );
      if (movement === null || !movement.moved) {
        boundaryReached = movement?.boundary === true;
        break;
      }
      scrollSteps += 1;
      boundaryReached = movement.boundary;
      const settle = Math.min(CONTROL_INSPECTION_SCROLL_SETTLE_MS, remainingUntil(deadlineAt));
      if (settle > 0) await new Promise((resolve) => setTimeout(resolve, settle));
      if (boundaryReached) {
        await capture();
        break;
      }
    }
    return {
      options,
      complete: boundaryReached && options.size < maxOptions,
      scrollSteps,
      boundaryReached,
    };
  },

  async controlOptionSemantic(
    locator: Locator,
    handle: ElementHandle<HTMLElement>,
    deadlineAt: number,
  ): Promise<{
    name: string;
    role: 'menuitem' | 'menuitemcheckbox' | 'menuitemradio' | 'option' | 'radio' | 'treeitem';
    selected: boolean | null;
    disabled: boolean;
  } | null> {
    const state = await boundedValue(
      handle.evaluate((element) => {
        if (!element.isConnected) return null;
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return null;
        const role = (element.getAttribute('role') ?? '').toLocaleLowerCase();
        const labelledBy = (element.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/).filter(Boolean)
          .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '').join(' ');
        const rawName = element.getAttribute('aria-label') || labelledBy ||
          (element instanceof HTMLOptionElement ? element.label : '') ||
          element.innerText || element.textContent || element.getAttribute('title') || '';
        const ariaSelected = element.getAttribute('aria-selected');
        const ariaChecked = element.getAttribute('aria-checked');
        return {
          role,
          name: rawName.replace(/\s+/g, ' ').trim(),
          selected: ariaSelected === null
            ? ariaChecked === null ? null : ariaChecked === 'true'
            : ariaSelected === 'true',
          disabled: element.getAttribute('aria-disabled') === 'true' ||
            ('disabled' in element && Boolean((element as HTMLButtonElement).disabled)),
        };
      }),
      Math.max(1, remainingUntil(deadlineAt)),
      null,
    );
    if (state === null || state.name.length === 0 || !OPTION_ROLES.has(state.role as never)) return null;
    return {
      name: state.name.slice(0, 500),
      role: state.role as 'menuitem' | 'menuitemcheckbox' | 'menuitemradio' | 'option' | 'radio' | 'treeitem',
      selected: state.selected,
      disabled: state.disabled,
    };
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type ControlOptionOperations = typeof controlOptionOperations;
