import { type ElementHandle, type Page, randomUUID } from '../dependencies.js';
import { type InstalledClickDispatchProbe, type RawClickDispatchEvidence } from '../model.js';
import { safeRawClickDispatchEvidence } from './click-dispatch-evidence.js';
import type { BrowserControllerContext } from '../runtime.js';

export const inputHitTestingOperations = {
  async freshExactHandleClickPosition(
    handle: ElementHandle<HTMLElement | SVGElement>,
  ): Promise<{ x: number; y: number } | null> {
    return (await this.freshExactHandleHitPoint(handle))?.element ?? null;
  },

  async freshExactHandleHitPoint(
    handle: ElementHandle<HTMLElement | SVGElement>,
  ): Promise<{
    page: { x: number; y: number };
    element: { x: number; y: number };
  } | null> {
    try {
      return await handle.evaluate((element) => {
        if (!element.isConnected) return null;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none'
          && style.visibility !== 'hidden' && style.opacity !== '0';
        const enabled = !('disabled' in element && Boolean((element as HTMLButtonElement).disabled))
          && element.getAttribute('aria-disabled') !== 'true';
        if (!visible || !enabled || rect.bottom <= 0 || rect.right <= 0 ||
          rect.top >= window.innerHeight || rect.left >= window.innerWidth) {
          return null;
        }
        let left = Math.max(0, rect.left);
        let right = Math.min(window.innerWidth, rect.right);
        let top = Math.max(0, rect.top);
        let bottom = Math.min(window.innerHeight, rect.bottom);
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
            left = Math.max(left, ancestorRect.left);
            right = Math.min(right, ancestorRect.right);
          }
          if (/(auto|clip|hidden|scroll)/u.test(ancestorStyle.overflowY)) {
            top = Math.max(top, ancestorRect.top);
            bottom = Math.min(bottom, ancestorRect.bottom);
          }
        }
        if (right <= left || bottom <= top) return null;
        const width = right - left;
        const height = bottom - top;
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
        for (const [xRatio, yRatio] of points) {
          const x = left + width * xRatio;
          const y = top + height * yRatio;
          const hit = document.elementFromPoint(x, y);
          if (!composedContains(hit)) continue;
          return {
            page: { x, y },
            element: { x: x - rect.left, y: y - rect.top },
          };
        }
        return null;
      });
    } catch {
      return null;
    }
  },

  async freshMainFrameTargetPoint(
    page: Page,
    handle: ElementHandle<HTMLElement | SVGElement>,
  ): Promise<{ x: number; y: number } | null> {
    try {
      if (await handle.ownerFrame() !== page.mainFrame()) {
        return null;
      }
      return (await this.freshExactHandleHitPoint(handle))?.page ?? null;
    } catch {
      return null;
    }
  },

  async installExactClickDispatchProbe(
    page: Page,
    handle: ElementHandle<HTMLElement | SVGElement>,
    lifetimeMs: number,
    requireViewport: boolean,
  ): Promise<InstalledClickDispatchProbe | null> {
    const token = randomUUID();
    try {
      if (!this.clickDispatchBindings.has(page)) {
        await page.exposeBinding(
          this.clickDispatchBindingName,
          (source, observedToken: unknown, observedEvidence: unknown) => {
            if (typeof observedToken !== 'string') return;
            const retained = this.externalClickDispatchObservations.get(observedToken);
            if (retained === undefined || source.page !== retained.page) return;
            const evidence = safeRawClickDispatchEvidence(observedEvidence);
            if (evidence !== null) retained.evidence = evidence;
          },
        );
        this.clickDispatchBindings.add(page);
      }
      this.externalClickDispatchObservations.set(token, { page, evidence: null });
      const controller = await handle.evaluateHandle((element, input) => {
        const { bindingName, boundedLifetimeMs, observationToken, viewportRequired } = input;
        const initialRect = element.getBoundingClientRect();
        const state: RawClickDispatchEvidence = {
          strategy: 'guarded_exact_handle',
          guardExpired: false,
          targetConnectedBefore: element.isConnected,
          targetConnectedAtFirstEvent: null,
          targetConnectedAfter: element.isConnected,
          geometryChangedBeforeFirstEvent: null,
          trustedEventObserved: false,
          keyDownOnTarget: false,
          keyUpOnTarget: false,
          pointerDownOnTarget: false,
          mouseDownOnTarget: false,
          pointerUpOnTarget: false,
          mouseUpOnTarget: false,
          clickOnTarget: false,
          misdirectedEventBlocked: false,
          targetStateChangeBlocked: false,
        };
        const eventTypes = ['keydown', 'keyup', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'] as const;
        let cleaned = false;
        let expirationTimer: number | null = null;

        const targetIsActionable = (): boolean => {
          if (!element.isConnected) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none'
            && style.visibility !== 'hidden' && style.opacity !== '0';
          const enabled = !('disabled' in element && Boolean((element as HTMLButtonElement).disabled))
            && element.getAttribute('aria-disabled') !== 'true';
          let left = Math.max(0, rect.left);
          let right = Math.min(window.innerWidth, rect.right);
          let top = Math.max(0, rect.top);
          let bottom = Math.min(window.innerHeight, rect.bottom);
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
              left = Math.max(left, ancestorRect.left);
              right = Math.min(right, ancestorRect.right);
            }
            if (/(auto|clip|hidden|scroll)/u.test(ancestorStyle.overflowY)) {
              top = Math.max(top, ancestorRect.top);
              bottom = Math.min(bottom, ancestorRect.bottom);
            }
          }
          return visible && enabled && (!viewportRequired || (right > left && bottom > top));
        };
        const block = (event: Event): void => {
          event.preventDefault();
          event.stopImmediatePropagation();
          event.stopPropagation();
        };
        const recordExactEvent = (eventType: typeof eventTypes[number]): void => {
          if (eventType === 'keydown') state.keyDownOnTarget = true;
          if (eventType === 'keyup') state.keyUpOnTarget = true;
          if (eventType === 'pointerdown') state.pointerDownOnTarget = true;
          if (eventType === 'mousedown') state.mouseDownOnTarget = true;
          if (eventType === 'pointerup') state.pointerUpOnTarget = true;
          if (eventType === 'mouseup') state.mouseUpOnTarget = true;
          if (eventType === 'click') state.clickOnTarget = true;
        };
        const snapshot = (): RawClickDispatchEvidence => ({
          ...state,
          targetConnectedAfter: element.isConnected,
        });
        const report = (): void => {
          const binding = (globalThis as unknown as Record<string, unknown>)[bindingName];
          if (typeof binding !== 'function') return;
          void (binding as (token: string, evidence: RawClickDispatchEvidence) => Promise<unknown>)(
            observationToken,
            snapshot(),
          ).catch(() => undefined);
        };
        const listener = (event: Event): void => {
          if (!event.isTrusted) return;
          const eventType = event.type as typeof eventTypes[number];
          state.trustedEventObserved = true;
          if (state.targetConnectedAtFirstEvent === null) {
            state.targetConnectedAtFirstEvent = element.isConnected;
            const currentRect = element.getBoundingClientRect();
            state.geometryChangedBeforeFirstEvent =
              Math.abs(currentRect.top - initialRect.top) > 1 ||
              Math.abs(currentRect.left - initialRect.left) > 1 ||
              Math.abs(currentRect.width - initialRect.width) > 1 ||
              Math.abs(currentRect.height - initialRect.height) > 1;
          }
          const exactTarget = event.composedPath().includes(element);
          if (!exactTarget) {
            state.misdirectedEventBlocked = true;
            block(event);
            report();
            return;
          }
          if (!targetIsActionable()) {
            state.targetStateChangeBlocked = true;
            block(event);
            report();
            return;
          }
          recordExactEvent(eventType);
          if (eventType === 'click') {
            cleanup();
          }
          report();
        };
        const cleanup = (): void => {
          if (cleaned) return;
          cleaned = true;
          if (expirationTimer !== null) window.clearTimeout(expirationTimer);
          eventTypes.forEach((eventType) => window.removeEventListener(eventType, listener, true));
        };
        eventTypes.forEach((eventType) => window.addEventListener(eventType, listener, true));
        expirationTimer = window.setTimeout(() => {
          state.guardExpired = true;
          cleanup();
          report();
        }, Math.max(1, boundedLifetimeMs));
        return {
          snapshot,
          finish: (): RawClickDispatchEvidence => {
            cleanup();
            return snapshot();
          },
        };
      }, {
        bindingName: this.clickDispatchBindingName,
        boundedLifetimeMs: lifetimeMs,
        observationToken: token,
        viewportRequired: requireViewport,
      });
      return { controller, token };
    } catch {
      this.externalClickDispatchObservations.delete(token);
      return null;
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type InputHitTestingOperations = typeof inputHitTestingOperations;
