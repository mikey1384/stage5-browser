import { type Browser, type ElementHandle, type Frame, type Locator, type Page, privacyFingerprint, type SafeTargetState } from '../dependencies.js';
import { CLICK_REF_ELEMENT_CANDIDATES, CLICK_REF_OWNER_CANDIDATES, CLICK_REF_OWNER_SELECTOR, CLICK_REF_OWNER_TEXT_CHARACTERS, CLICK_REF_REBIND_SETTLE_MS, type ClickTargetSemanticIdentity, type ClickViewportMovement, type VirtualizedClickResolution } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const inputVirtualizationOperations = {
  async incrementalScrollTowardClickTarget(
    handle: ElementHandle<HTMLElement | SVGElement>,
  ): Promise<ClickViewportMovement | null> {
    try {
      return await handle.evaluate((element) => {
        let composedBoundaryTraversed = false;
        const composedParent = (candidate: Element): HTMLElement | null => {
          if (candidate.assignedSlot !== null) {
            composedBoundaryTraversed = true;
            return candidate.assignedSlot;
          }
          if (candidate.parentElement !== null) return candidate.parentElement;
          const root = candidate.getRootNode();
          if (root instanceof ShadowRoot) {
            composedBoundaryTraversed = true;
            return root.host as HTMLElement;
          }
          return null;
        };
        const clips = (overflow: string): boolean => /^(auto|clip|hidden|overlay|scroll)$/u.test(overflow);
        const scrolls = (overflow: string): boolean => /^(auto|hidden|overlay|scroll)$/u.test(overflow);
        const visibleSurfaceRect = (surface: HTMLElement): {
          left: number;
          right: number;
          top: number;
          bottom: number;
        } => {
          const rect = surface.getBoundingClientRect();
          let left = Math.max(0, rect.left);
          let right = Math.min(window.innerWidth, rect.right);
          let top = Math.max(0, rect.top);
          let bottom = Math.min(window.innerHeight, rect.bottom);
          const visited = new Set<Element>([surface]);
          for (
            let ancestor = composedParent(surface);
            ancestor !== null && !visited.has(ancestor);
            ancestor = composedParent(ancestor)
          ) {
            visited.add(ancestor);
            const style = getComputedStyle(ancestor);
            const ancestorRect = ancestor.getBoundingClientRect();
            if (clips(style.overflowX)) {
              left = Math.max(left, ancestorRect.left);
              right = Math.min(right, ancestorRect.right);
            }
            if (clips(style.overflowY)) {
              top = Math.max(top, ancestorRect.top);
              bottom = Math.min(bottom, ancestorRect.bottom);
            }
          }
          return { left, right, top, bottom };
        };
        const targetRect = element.getBoundingClientRect();
        const direction = (start: number, end: number, clipStart: number, clipEnd: number): -1 | 0 | 1 =>
          end <= clipStart ? -1 : start >= clipEnd ? 1 : 0;
        const boundedStep = (distance: number, visibleSpan: number): number =>
          Math.max(64, Math.min(distance, Math.max(64, Math.floor(visibleSpan * 0.72))));
        const noMovement = (): ClickViewportMovement => ({
          moved: false,
          horizontalMovement: false,
          verticalMovement: false,
          surface: null,
          composedBoundaryTraversed,
        });
        const moveSurface = (
          surface: HTMLElement,
          surfaceKind: 'document' | 'nested',
        ): ClickViewportMovement => {
          const style = getComputedStyle(surface);
          const visibleRect = visibleSurfaceRect(surface);
          if (visibleRect.right <= visibleRect.left || visibleRect.bottom <= visibleRect.top) return noMovement();
          const horizontalDirection = direction(
            targetRect.left,
            targetRect.right,
            visibleRect.left,
            visibleRect.right,
          );
          const verticalDirection = direction(
            targetRect.top,
            targetRect.bottom,
            visibleRect.top,
            visibleRect.bottom,
          );
          const canMoveHorizontally = horizontalDirection !== 0 &&
            (surfaceKind === 'document' || scrolls(style.overflowX)) &&
            surface.scrollWidth > surface.clientWidth + 1;
          const canMoveVertically = verticalDirection !== 0 &&
            (surfaceKind === 'document' || scrolls(style.overflowY)) &&
            surface.scrollHeight > surface.clientHeight + 1;
          if (!canMoveHorizontally && !canMoveVertically) return noMovement();

          const beforeLeft = surface.scrollLeft;
          const beforeTop = surface.scrollTop;
          const horizontalDistance = horizontalDirection > 0
            ? Math.max(64, targetRect.left - visibleRect.right)
            : Math.max(64, visibleRect.left - targetRect.right);
          const verticalDistance = verticalDirection > 0
            ? Math.max(64, targetRect.top - visibleRect.bottom)
            : Math.max(64, visibleRect.top - targetRect.bottom);
          const priorBehavior = surface.style.scrollBehavior;
          surface.style.scrollBehavior = 'auto';
          if (canMoveHorizontally) {
            surface.scrollLeft = beforeLeft + horizontalDirection * boundedStep(
              horizontalDistance,
              visibleRect.right - visibleRect.left,
            );
          }
          if (canMoveVertically) {
            surface.scrollTop = beforeTop + verticalDirection * boundedStep(
              verticalDistance,
              visibleRect.bottom - visibleRect.top,
            );
          }
          surface.style.scrollBehavior = priorBehavior;
          const horizontalMovement = Math.abs(surface.scrollLeft - beforeLeft) > 1;
          const verticalMovement = Math.abs(surface.scrollTop - beforeTop) > 1;
          const moved = horizontalMovement || verticalMovement;
          return {
            moved,
            horizontalMovement,
            verticalMovement,
            surface: moved ? surfaceKind : null,
            composedBoundaryTraversed,
          };
        };

        const visited = new Set<Element>();
        for (
          let ancestor = composedParent(element);
          ancestor !== null && !visited.has(ancestor);
          ancestor = composedParent(ancestor)
        ) {
          visited.add(ancestor);
          if (ancestor === document.body || ancestor === document.documentElement) continue;
          const movement = moveSurface(ancestor, 'nested');
          if (movement.moved) return movement;
        }

        const scrollingElement = document.scrollingElement;
        if (!(scrollingElement instanceof HTMLElement)) {
          return noMovement();
        }
        return moveSurface(scrollingElement, 'document');
      });
    } catch {
      return null;
    }
  },

  async waitForVirtualizedClickTarget(
    frame: Frame,
    originalLocator: Locator,
    identity: ClickTargetSemanticIdentity | null,
    preparationDeadline: number,
  ): Promise<VirtualizedClickResolution> {
    const deadline = Math.min(
      preparationDeadline,
      Date.now() + CLICK_REF_REBIND_SETTLE_MS,
    );
    let result: VirtualizedClickResolution = { kind: 'missing' };
    do {
      result = await this.resolveVirtualizedClickTarget(frame, originalLocator, identity);
      if (result.kind !== 'missing' || Date.now() >= deadline) {
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
    } while (Date.now() < deadline);
    return result;
  },

  async resolveVirtualizedClickTarget(
    frame: Frame,
    originalLocator: Locator,
    identity: ClickTargetSemanticIdentity | null,
  ): Promise<VirtualizedClickResolution> {
    try {
      const originalCount = await originalLocator.count();
      if (originalCount > 1) {
        return { kind: 'ambiguous' };
      }
      if (originalCount === 1) {
        const originalHandle = await originalLocator.elementHandle();
        if (originalHandle !== null) {
          const observed = await this.observeClickTargetIdentity(originalHandle);
          if (identity !== null && observed !== null && this.sameClickTargetIdentity(identity, observed)) {
            return { kind: 'resolved', locator: originalLocator, handle: originalHandle };
          }
          await originalHandle.dispose().catch(() => undefined);
        }
      }
      if (identity?.owner === null || identity?.owner === undefined || identity.name === '') {
        return { kind: 'missing' };
      }
      const ownerIdentity = identity.owner;

      const owners = frame.locator(CLICK_REF_OWNER_SELECTOR);
      const ownerCount = await owners.count();
      if (ownerCount > CLICK_REF_OWNER_CANDIDATES) {
        return { kind: 'ambiguous' };
      }
      const ownerCandidates = await owners.evaluateAll((candidates, args) =>
        candidates.map((owner) => {
          const normalize = (value: string | null | undefined): string =>
            (value ?? '').replaceAll(/\s+/g, ' ').trim();
          const explicitRole = normalize(owner.getAttribute('role')).split(' ')[0] ?? '';
          let nestingDepth = 0;
          for (let ancestor: Element | null = owner; ancestor !== null; ancestor = ancestor.parentElement) {
            if (ancestor.matches(args.ownerSelector)) nestingDepth += 1;
          }
          const tagName = owner.tagName.toLocaleLowerCase();
          return {
            text: (owner instanceof HTMLElement
              ? normalize(owner.innerText || owner.textContent)
              : normalize(owner.textContent)).slice(0, args.ownerTextCharacters),
            tagName,
            role: explicitRole === ''
              ? tagName === 'article' ? 'article'
                : tagName === 'tr' ? 'row'
                  : tagName === 'li' ? 'listitem'
                    : null
              : explicitRole.toLocaleLowerCase(),
            nestingDepth,
          };
        }), {
          ownerSelector: CLICK_REF_OWNER_SELECTOR,
          ownerTextCharacters: CLICK_REF_OWNER_TEXT_CHARACTERS,
        });
      const matchingOwnerIndexes: number[] = [];
      ownerCandidates.forEach((candidate, index) => {
        if (
          privacyFingerprint(candidate.text) === ownerIdentity.fingerprint &&
          candidate.tagName === ownerIdentity.tagName &&
          candidate.role === ownerIdentity.role &&
          candidate.nestingDepth === ownerIdentity.nestingDepth
        ) {
          matchingOwnerIndexes.push(index);
        }
      });
      if (matchingOwnerIndexes.length > 1) {
        return { kind: 'ambiguous' };
      }
      const ownerIndex = matchingOwnerIndexes[0];
      if (ownerIndex === undefined) {
        return { kind: 'missing' };
      }
      const owner = owners.nth(ownerIndex);
      const match = await owner.evaluate((ownerElement, expected) => {
        const normalize = (value: string | null | undefined): string =>
          (value ?? '').replaceAll(/\s+/g, ' ').trim();
        const semanticRole = (candidate: Element): string | null => {
          const explicit = normalize(candidate.getAttribute('role')).split(' ')[0] ?? '';
          if (explicit !== '') return explicit.toLocaleLowerCase();
          const tagName = candidate.tagName.toLocaleLowerCase();
          if (tagName === 'button') return 'button';
          if (tagName === 'a' && candidate.hasAttribute('href')) return 'link';
          if (tagName === 'article') return 'article';
          if (tagName === 'tr') return 'row';
          if (tagName === 'li') return 'listitem';
          if (tagName === 'img') return 'img';
          if (tagName === 'textarea') return 'textbox';
          if (tagName === 'select') return 'combobox';
          if (tagName === 'input') {
            const type = (candidate.getAttribute('type') ?? 'text').toLocaleLowerCase();
            if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
            if (type === 'checkbox') return 'checkbox';
            if (type === 'radio') return 'radio';
            if (type !== 'hidden') return 'textbox';
          }
          return null;
        };
        const renderedText = (candidate: Element): string =>
          candidate instanceof HTMLElement
            ? normalize(candidate.innerText || candidate.textContent)
            : normalize(candidate.textContent);
        const semanticName = (candidate: Element): string => {
          const ariaLabel = normalize(candidate.getAttribute('aria-label'));
          if (ariaLabel !== '') return ariaLabel.slice(0, 500);
          const labelledBy = normalize(candidate.getAttribute('aria-labelledby'));
          if (labelledBy !== '') {
            const labels = labelledBy.split(' ')
              .map((id) => document.getElementById(id))
              .filter((label): label is HTMLElement => label !== null)
              .map((label) => normalize(label.innerText || label.textContent))
              .filter((label) => label !== '')
              .join(' ');
            if (labels !== '') return labels.slice(0, 500);
          }
          const alt = normalize(candidate.getAttribute('alt'));
          if (alt !== '') return alt.slice(0, 500);
          const rendered = renderedText(candidate);
          if (rendered !== '') return rendered.slice(0, 500);
          const value = normalize(candidate.getAttribute('value'));
          if (value !== '') return value.slice(0, 500);
          const placeholder = normalize(candidate.getAttribute('placeholder'));
          if (placeholder !== '') return placeholder.slice(0, 500);
          return normalize(candidate.getAttribute('title')).slice(0, 500);
        };
        const descendants = Array.from(ownerElement.querySelectorAll('*'));
        if (descendants.length + 1 > expected.maximumCandidates) {
          return { tooMany: true, indexes: [] as number[] };
        }
        const candidates = [ownerElement, ...descendants];
        const indexes: number[] = [];
        candidates.forEach((candidate, index) => {
          if (
            candidate.tagName.toLocaleLowerCase() === expected.tagName &&
            semanticRole(candidate) === expected.role &&
            semanticName(candidate) === expected.name &&
            candidate.getAttribute('href') === expected.url
          ) {
            indexes.push(index);
          }
        });
        return { tooMany: false, indexes };
      }, {
        tagName: identity.tagName,
        role: identity.role,
        name: identity.name,
        url: identity.url,
        maximumCandidates: CLICK_REF_ELEMENT_CANDIDATES,
      });
      if (match.tooMany || match.indexes.length > 1) {
        return { kind: 'ambiguous' };
      }
      const targetIndex = match.indexes[0];
      if (targetIndex === undefined) {
        return { kind: 'missing' };
      }
      const reboundLocator = targetIndex === 0
        ? owner
        : owner.locator('*').nth(targetIndex - 1);
      const reboundHandle = await reboundLocator.elementHandle();
      if (reboundHandle === null) {
        return { kind: 'missing' };
      }
      const reboundIdentity = await this.observeClickTargetIdentity(reboundHandle);
      if (reboundIdentity === null || !this.sameClickTargetIdentity(identity, reboundIdentity)) {
        await reboundHandle.dispose().catch(() => undefined);
        return { kind: 'missing' };
      }
      return { kind: 'resolved', locator: reboundLocator, handle: reboundHandle };
    } catch {
      return { kind: 'missing' };
    }
  },

  sameClickTargetIdentity(
    expected: ClickTargetSemanticIdentity,
    observed: ClickTargetSemanticIdentity,
  ): boolean {
    if (
      expected.tagName !== observed.tagName ||
      expected.role !== observed.role ||
      expected.name !== observed.name ||
      expected.url !== observed.url
    ) {
      return false;
    }
    if (expected.owner === null || observed.owner === null) {
      return expected.owner === null && observed.owner === null;
    }
    return expected.owner.fingerprint === observed.owner.fingerprint &&
      expected.owner.tagName === observed.owner.tagName &&
      expected.owner.role === observed.owner.role &&
      expected.owner.nestingDepth === observed.owner.nestingDepth;
  },

  failVirtualizedClickRebind(
    page: Page,
    startedAt: string,
    result: 'ambiguous' | 'missing',
    priorTargetState: SafeTargetState,
  ): never {
    return this.failClickBeforeDispatch(
      page,
      startedAt,
      priorTargetState,
      result === 'ambiguous' ? 'ambiguous_target' : 'detached',
      result === 'ambiguous'
        ? 'virtualized_target_rebind_ambiguous'
        : 'virtualized_target_rebind_failed',
      result === 'ambiguous'
        ? 'The page virtualized the observed element and more than one replacement matched its article-scoped identity.'
        : 'The page virtualized the observed element and Stage5 Browser could not uniquely prove its replacement.',
      'Take one fresh semantic snapshot after the feed settles; Stage5 Browser did not dispatch the click.',
      result === 'ambiguous' ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND',
    );
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type InputVirtualizationOperations = typeof inputVirtualizationOperations;
