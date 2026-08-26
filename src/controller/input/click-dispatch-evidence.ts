import { type RawClickDispatchEvidence } from '../model.js';

export function safeRawClickDispatchEvidence(value: unknown): RawClickDispatchEvidence | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<RawClickDispatchEvidence>;
  const booleanFields: Array<keyof RawClickDispatchEvidence> = [
    'guardExpired',
    'targetConnectedBefore',
    'targetConnectedAfter',
    'trustedEventObserved',
    'keyDownOnTarget',
    'keyUpOnTarget',
    'pointerDownOnTarget',
    'mouseDownOnTarget',
    'pointerUpOnTarget',
    'mouseUpOnTarget',
    'clickOnTarget',
    'misdirectedEventBlocked',
    'targetStateChangeBlocked',
  ];
  if (
    candidate.strategy !== 'guarded_exact_handle'
    || booleanFields.some((field) => typeof candidate[field] !== 'boolean')
    || (candidate.targetConnectedAtFirstEvent !== null
      && typeof candidate.targetConnectedAtFirstEvent !== 'boolean')
    || (candidate.geometryChangedBeforeFirstEvent !== null
      && typeof candidate.geometryChangedBeforeFirstEvent !== 'boolean')
  ) {
    return null;
  }
  return {
    strategy: 'guarded_exact_handle',
    guardExpired: candidate.guardExpired as boolean,
    targetConnectedBefore: candidate.targetConnectedBefore as boolean,
    targetConnectedAtFirstEvent: candidate.targetConnectedAtFirstEvent as boolean | null,
    targetConnectedAfter: candidate.targetConnectedAfter as boolean,
    geometryChangedBeforeFirstEvent: candidate.geometryChangedBeforeFirstEvent as boolean | null,
    trustedEventObserved: candidate.trustedEventObserved as boolean,
    keyDownOnTarget: candidate.keyDownOnTarget as boolean,
    keyUpOnTarget: candidate.keyUpOnTarget as boolean,
    pointerDownOnTarget: candidate.pointerDownOnTarget as boolean,
    mouseDownOnTarget: candidate.mouseDownOnTarget as boolean,
    pointerUpOnTarget: candidate.pointerUpOnTarget as boolean,
    mouseUpOnTarget: candidate.mouseUpOnTarget as boolean,
    clickOnTarget: candidate.clickOnTarget as boolean,
    misdirectedEventBlocked: candidate.misdirectedEventBlocked as boolean,
    targetStateChangeBlocked: candidate.targetStateChangeBlocked as boolean,
  };
}

export function mergeRawClickDispatchEvidence(
  inPage: RawClickDispatchEvidence | null,
  external: RawClickDispatchEvidence | null,
): RawClickDispatchEvidence | null {
  if (inPage === null) return external;
  if (external === null) return inPage;
  return {
    strategy: 'guarded_exact_handle',
    guardExpired: inPage.guardExpired || external.guardExpired,
    targetConnectedBefore: inPage.targetConnectedBefore && external.targetConnectedBefore,
    targetConnectedAtFirstEvent:
      external.targetConnectedAtFirstEvent ?? inPage.targetConnectedAtFirstEvent,
    targetConnectedAfter: inPage.targetConnectedAfter,
    geometryChangedBeforeFirstEvent:
      external.geometryChangedBeforeFirstEvent ?? inPage.geometryChangedBeforeFirstEvent,
    trustedEventObserved: inPage.trustedEventObserved || external.trustedEventObserved,
    keyDownOnTarget: inPage.keyDownOnTarget || external.keyDownOnTarget,
    keyUpOnTarget: inPage.keyUpOnTarget || external.keyUpOnTarget,
    pointerDownOnTarget: inPage.pointerDownOnTarget || external.pointerDownOnTarget,
    mouseDownOnTarget: inPage.mouseDownOnTarget || external.mouseDownOnTarget,
    pointerUpOnTarget: inPage.pointerUpOnTarget || external.pointerUpOnTarget,
    mouseUpOnTarget: inPage.mouseUpOnTarget || external.mouseUpOnTarget,
    clickOnTarget: inPage.clickOnTarget || external.clickOnTarget,
    misdirectedEventBlocked: inPage.misdirectedEventBlocked || external.misdirectedEventBlocked,
    targetStateChangeBlocked: inPage.targetStateChangeBlocked || external.targetStateChangeBlocked,
  };
}
