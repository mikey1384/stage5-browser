import { type Browser, type ElementHandle, type Frame, type Locator, type Page, privacyFingerprint, type SafeTargetState } from '../dependencies.js';
import { CLICK_REF_ELEMENT_CANDIDATES, CLICK_REF_OWNER_CANDIDATES, CLICK_REF_OWNER_SELECTOR, CLICK_REF_OWNER_TEXT_CHARACTERS, CLICK_REF_REBIND_SETTLE_MS, type ClickTargetSemanticIdentity, type VirtualizedClickResolution } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const inputVirtualizationOperations = {
  async incrementalScrollTowardClickTarget(
    handle: ElementHandle<HTMLElement | SVGElement>,
  ): Promise<{ moved: boolean; targetInViewport: boolean } | null> {
    try {
      return await handle.evaluate((element) => {
        const viewportIntersects = (rect: DOMRect): boolean =>
          rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
        const targetRect = element.getBoundingClientRect();
        const targetDirection = targetRect.bottom <= 0 ? -1 : targetRect.top >= window.innerHeight ? 1 : 0;
        const moveSurface = (
          surface: HTMLElement,
          direction: number,
          distance: number,
          visibleHeight: number,
        ): boolean => {
          const before = surface.scrollTop;
          const maximum = Math.max(0, surface.scrollHeight - surface.clientHeight);
          const available = direction > 0 ? maximum - before : before;
          if (available <= 1) return false;
          const step = Math.min(
            available,
            Math.max(64, Math.min(distance, Math.max(64, Math.floor(visibleHeight * 0.72)))),
          );
          const priorBehavior = surface.style.scrollBehavior;
          surface.style.scrollBehavior = 'auto';
          surface.scrollTop = before + direction * step;
          surface.style.scrollBehavior = priorBehavior;
          return Math.abs(surface.scrollTop - before) > 1;
        };

        for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
          if (ancestor === document.body || ancestor === document.documentElement) continue;
          const style = getComputedStyle(ancestor);
          if (!/(auto|hidden|scroll|overlay)/u.test(style.overflowY)) continue;
          if (ancestor.scrollHeight <= ancestor.clientHeight + 1) continue;
          const surfaceRect = ancestor.getBoundingClientRect();
          if (!viewportIntersects(surfaceRect)) continue;
          const clipTop = Math.max(0, surfaceRect.top);
          const clipBottom = Math.min(window.innerHeight, surfaceRect.bottom);
          const direction = targetRect.bottom <= clipTop ? -1 : targetRect.top >= clipBottom ? 1 : 0;
          if (direction === 0) continue;
          const distance = direction > 0
            ? Math.max(64, targetRect.top - clipBottom)
            : Math.max(64, clipTop - targetRect.bottom);
          if (moveSurface(ancestor, direction, distance, Math.max(1, clipBottom - clipTop))) {
            const after = element.getBoundingClientRect();
            return { moved: true, targetInViewport: viewportIntersects(after) };
          }
        }

        // A descendant can geometrically intersect the browser window while
        // remaining fully clipped by a modal or nested scroll viewport. Only
        // fall back to document scrolling after every clipping ancestor has
        // had one bounded opportunity to reveal the exact target.
        if (targetDirection === 0) {
          return { moved: false, targetInViewport: false };
        }

        const scrollingElement = document.scrollingElement;
        if (!(scrollingElement instanceof HTMLElement)) {
          return { moved: false, targetInViewport: false };
        }
        const distance = targetDirection > 0
          ? Math.max(64, targetRect.top - window.innerHeight)
          : Math.max(64, -targetRect.bottom);
        const moved = moveSurface(
          scrollingElement,
          targetDirection,
          distance,
          Math.max(1, window.innerHeight),
        );
        const after = element.getBoundingClientRect();
        return { moved, targetInViewport: viewportIntersects(after) };
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
