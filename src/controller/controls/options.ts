import { randomUUID } from 'node:crypto';

import { type ControlPopupAssociationProof, type ControlPopupOwnershipEvidence, type ControlPopupSurfaceProof, type ElementHandle, type Frame, type Locator } from '../dependencies.js';
import { boundedValue, CONTROL_INSPECTION_SCROLL_SETTLE_MS, CONTROL_OPTION_SELECTOR, MAX_CONTROL_INSPECTION_SCROLL_STEPS, MAX_CONTROL_POPUP_OPTION_CANDIDATES, type ObservedControlOption, type ObservedControlPopupSurface, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import { inspectControlOptionElement } from './option-state.js';
import { resolveControlPopupOwner } from './popup-ownership.js';
import { discoverControlPopupSurfaces } from './popup-surfaces.js';

const OPTION_ROLES = new Set([
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'treeitem',
] as const);

interface PopupCandidate {
  locator: Locator | null;
  handle: ElementHandle<HTMLElement>;
  surfaceProof: ControlPopupSurfaceProof;
  explicit: boolean;
  structurallyRelated: boolean;
  rendered: boolean;
}

export interface ControlPopupAssociationPolicy {
  allowUniqueRenderedAfterDispatch?: boolean;
  requireRendered?: boolean;
}

export type ControlPopupAssociation =
  | {
      kind: 'resolved';
      surfaces: ObservedControlPopupSurface[];
      proof: ControlPopupAssociationProof;
      surfaceProof: ControlPopupSurfaceProof;
      renderedSurfaceCount: number;
      popupOwnership: ControlPopupOwnershipEvidence | null;
    }
  | { kind: 'ambiguous'; renderedSurfaceCount: number | null; popupOwnership: ControlPopupOwnershipEvidence | null }
  | { kind: 'missing'; renderedSurfaceCount: number | null; popupOwnership: ControlPopupOwnershipEvidence | null };

function weakestAssociationProof(
  proofs: Array<'structural' | 'focused' | 'expanded' | 'spatial'>,
): ControlPopupAssociationProof {
  if (proofs.includes('spatial')) return 'spatial';
  if (proofs.includes('expanded')) return 'expanded';
  if (proofs.includes('focused')) return 'focused';
  return 'structural';
}

async function outermostPopupCandidates(
  candidates: PopupCandidate[],
  deadlineAt: number,
): Promise<PopupCandidate[]> {
  const nested = new Set<PopupCandidate>();
  for (const candidate of candidates) {
    for (const possibleAncestor of candidates) {
      if (candidate === possibleAncestor) continue;
      const contained = await boundedValue(
        possibleAncestor.handle.evaluate((ancestor, descendant) =>
          ancestor.isConnected && descendant.isConnected && ancestor.contains(descendant), candidate.handle),
        Math.max(1, remainingUntil(deadlineAt)),
        null,
      );
      if (contained === true) {
        nested.add(candidate);
        break;
      }
    }
  }
  return candidates.filter((candidate) => !nested.has(candidate));
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
    policy: ControlPopupAssociationPolicy = {},
  ): Promise<ControlPopupAssociation> {
    const connected = await boundedValue(
      controlHandle.evaluate((control) => control.isConnected),
      Math.max(1, remainingUntil(deadlineAt)),
      false,
    );
    if (!connected) return { kind: 'missing', renderedSurfaceCount: null, popupOwnership: null };

    const discovery = await discoverControlPopupSurfaces(frame, deadlineAt);
    if (discovery.kind === 'unbounded') {
      return { kind: 'ambiguous', renderedSurfaceCount: null, popupOwnership: null };
    }
    const candidates: PopupCandidate[] = [];
    try {
      for (const surface of discovery.surfaces) {
        const { locator, handle, surfaceProof } = surface;
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
        candidates.push({ locator, handle, surfaceProof, ...state });
      }

      const explicit = candidates.filter((candidate) =>
        candidate.explicit && (!policy.requireRendered || candidate.rendered));
      const activeExplicit = explicit.some(({ rendered }) => rendered)
        ? explicit.filter(({ rendered }) => rendered)
        : explicit;
      const structural = candidates.filter((candidate) => candidate.structurallyRelated && candidate.rendered);
      const rendered = candidates.filter((candidate) => candidate.rendered);
      const selected = new Set<PopupCandidate>();
      let selectedProof: ControlPopupAssociationProof | null = activeExplicit.length > 0
        ? 'explicit'
        : structural.length > 0
          ? 'structural'
          : null;
      for (const candidate of activeExplicit.length > 0 ? activeExplicit : structural) selected.add(candidate);
      let ownershipAmbiguous = false;
      const ownershipDiagnostics: ControlPopupOwnershipEvidence[] = [];
      const ownerMatched: Array<{
        candidate: PopupCandidate;
        proof: 'structural' | 'focused' | 'expanded' | 'spatial';
      }> = [];
      for (const candidate of rendered) {
        const ownership = await resolveControlPopupOwner(
          frame,
          candidate.handle,
          controlHandle,
          deadlineAt,
        );
        ownershipDiagnostics.push(ownership.diagnostics);
        if (ownership.kind === 'resolved') {
          if (ownership.targetMatch) ownerMatched.push({ candidate, proof: ownership.proof });
          await ownership.owner.dispose().catch(() => undefined);
        } else if (ownership.kind === 'ambiguous' || ownership.kind === 'unbounded') {
          ownershipAmbiguous = true;
        }
      }
      if (selected.size === 0) {
        for (const { candidate } of ownerMatched) selected.add(candidate);
      }
      if (selectedProof === null && selected.size > 0 && ownerMatched.length > 0) {
        selectedProof = weakestAssociationProof(ownerMatched.map(({ proof }) => proof));
      }
      if (
        selected.size === 0 &&
        !ownershipAmbiguous &&
        policy.allowUniqueRenderedAfterDispatch === true &&
        rendered.length === 1
      ) {
        selected.add(rendered[0]!);
        selectedProof = 'post_dispatch_unique';
      }
      const selectedSurfaces = await outermostPopupCandidates([...selected], deadlineAt);
      const retained = new Set(selectedSurfaces);
      for (const candidate of candidates) {
        if (!retained.has(candidate)) await candidate.handle.dispose().catch(() => undefined);
      }
      const renderedSurfaceCount = rendered.length;
      const popupOwnership = rendered.length === 1 && ownershipDiagnostics.length === 1
        ? ownershipDiagnostics[0]!
        : null;
      return selectedSurfaces.length > 0 && selectedProof !== null
        ? {
            kind: 'resolved',
            surfaces: selectedSurfaces.map(({ locator, handle, surfaceProof }) => ({
              locator,
              handle,
              surfaceProof,
            })),
            proof: selectedProof,
            surfaceProof: selectedSurfaces[0]!.surfaceProof,
            renderedSurfaceCount,
            popupOwnership,
          }
        : {
            kind: ownershipAmbiguous ? 'ambiguous' : 'missing',
            renderedSurfaceCount,
            popupOwnership,
          };
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
