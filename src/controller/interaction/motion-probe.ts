import { type BrowserMotionDispatchEvidence, type ElementHandle, type JSHandle } from '../dependencies.js';
import type { BrowserControllerContext } from '../runtime.js';

interface MotionProbeController {
  finish: () => Omit<BrowserMotionDispatchEvidence, 'actionDispatched' | 'kind'>;
}

export const interactionMotionProbeOperations = {
  async installMotionProbe(
    source: ElementHandle<HTMLElement | SVGElement>,
    destination: ElementHandle<HTMLElement | SVGElement> | null,
  ): Promise<JSHandle<MotionProbeController> | null> {
    try {
      return await source.evaluateHandle((sourceElement, destinationElement) => {
        const state = {
          focusObserved: false,
          hoverObserved: false,
          keyDownObserved: false,
          keyUpObserved: false,
          pointerDownObserved: false,
          clickObserved: false,
          contextMenuObserved: false,
          doubleClickObserved: false,
          dragStartObserved: false,
          dropObserved: false,
        };
        const listeners: Array<{ target: EventTarget; type: string; listener: EventListener }> = [];
        const listen = (target: EventTarget, type: string, listener: EventListener): void => {
          target.addEventListener(type, listener, true);
          listeners.push({ target, type, listener });
        };
        const exact = (event: Event, element: Element): boolean => event.isTrusted && event.composedPath().includes(element);
        listen(document, 'focusin', (event) => { if (exact(event, sourceElement)) state.focusObserved = true; });
        listen(document, 'pointerover', (event) => { if (exact(event, sourceElement)) state.hoverObserved = true; });
        listen(document, 'mouseover', (event) => { if (exact(event, sourceElement)) state.hoverObserved = true; });
        listen(document, 'keydown', (event) => { if (exact(event, sourceElement)) state.keyDownObserved = true; });
        listen(document, 'keyup', (event) => { if (exact(event, sourceElement)) state.keyUpObserved = true; });
        listen(document, 'pointerdown', (event) => { if (exact(event, sourceElement)) state.pointerDownObserved = true; });
        listen(document, 'click', (event) => { if (exact(event, sourceElement)) state.clickObserved = true; });
        listen(document, 'contextmenu', (event) => { if (exact(event, sourceElement)) state.contextMenuObserved = true; });
        listen(document, 'dblclick', (event) => { if (exact(event, sourceElement)) state.doubleClickObserved = true; });
        listen(document, 'dragstart', (event) => { if (exact(event, sourceElement)) state.dragStartObserved = true; });
        if (destinationElement !== null) {
          listen(document, 'drop', (event) => { if (exact(event, destinationElement)) state.dropObserved = true; });
        }
        return {
          finish: () => {
            for (const retained of listeners) {
              retained.target.removeEventListener(retained.type, retained.listener, true);
            }
            return {
              ...state,
              focusObserved: state.focusObserved || document.activeElement === sourceElement || sourceElement.contains(document.activeElement),
              hoverObserved: state.hoverObserved || sourceElement.matches(':hover'),
            };
          },
        };
      }, destination);
    } catch {
      return null;
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type InteractionMotionProbeOperations = typeof interactionMotionProbeOperations;
