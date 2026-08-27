import { type ElementHandle } from '../dependencies.js';
import { boundedValue, remainingUntil } from '../model.js';

export async function popupRendered(
  handle: ElementHandle<HTMLElement> | null,
  deadlineAt: number,
): Promise<boolean> {
  return await popupRenderedState(handle, deadlineAt) === true;
}

export async function popupRenderedState(
  handle: ElementHandle<HTMLElement> | null,
  deadlineAt: number,
): Promise<boolean | null> {
  if (handle === null) return false;
  return boundedValue(
    handle.evaluate((surface) => {
      if (!surface.isConnected) return false;
      const rect = surface.getBoundingClientRect();
      const style = getComputedStyle(surface);
      return rect.width > 0 && rect.height > 0
        && rect.right > 0 && rect.bottom > 0
        && rect.left < innerWidth && rect.top < innerHeight
        && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }),
    Math.max(1, remainingUntil(deadlineAt)),
    null,
  );
}
