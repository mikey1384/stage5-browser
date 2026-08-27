import { remainingUntil } from '../model.js';
import type { ControlPopupAssociation } from './popup-association.js';
import { disposePopupSurfaces, inspectPopupSurfaceSetRendering } from './popup-set.js';

const CONTROL_POPUP_STABILIZATION_POLL_MS = 50;

type ResolvedControlPopup = Extract<ControlPopupAssociation, { kind: 'resolved' }>;

export interface StabilizedControlPopup {
  attempts: number;
  firstAssociation: ControlPopupAssociation | null;
  lastAssociation: ControlPopupAssociation | null;
  resolved: ResolvedControlPopup | null;
}

export async function waitForRenderedControlPopup(
  observe: () => Promise<ControlPopupAssociation>,
  deadlineAt: number,
): Promise<StabilizedControlPopup> {
  let attempts = 0;
  let firstAssociation: ControlPopupAssociation | null = null;
  let lastAssociation: ControlPopupAssociation | null = null;
  for (;;) {
    const associated = await observe();
    attempts += 1;
    firstAssociation ??= associated;
    lastAssociation = associated;
    if (associated.kind === 'resolved') {
      const rendering = await inspectPopupSurfaceSetRendering(associated.surfaces, deadlineAt);
      if (rendering?.allRendered === true) {
        return { attempts, firstAssociation, lastAssociation: associated, resolved: associated };
      }
      await disposePopupSurfaces(associated.surfaces);
    }
    if (remainingUntil(deadlineAt) <= 0) {
      return { attempts, firstAssociation, lastAssociation, resolved: null };
    }
    await new Promise((resolve) => setTimeout(
      resolve,
      Math.min(CONTROL_POPUP_STABILIZATION_POLL_MS, remainingUntil(deadlineAt)),
    ));
  }
}
