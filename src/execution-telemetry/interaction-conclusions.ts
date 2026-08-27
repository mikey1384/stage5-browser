import type { ExecutionTraceConclusion } from '../execution-telemetry-dependencies.js';
import { boundedNullableInteger, isRecord, valuesForKey } from './value-readers.js';

const CONTROL_REVEAL_INTERACTIONS = new Set<NonNullable<ExecutionTraceConclusion['controlRevealInteraction']>>([
  'keyboard',
  'pointer',
]);

const SELECTION_INTERACTIONS = new Set<NonNullable<ExecutionTraceConclusion['selectionInteraction']>>([
  'observed_option',
  'searchable_keyboard',
]);
const ACTIVE_OPTION_PROOFS = new Set<NonNullable<NonNullable<ExecutionTraceConclusion['searchableSelection']>['activeOptionProof']>>([
  'aria_activedescendant',
  'focused_linked_option',
]);
const SELECTION_PROOFS = new Set<NonNullable<NonNullable<ExecutionTraceConclusion['searchableSelection']>['selectionProof']>>([
  'selected_state',
  'unresolved',
  'value_and_popup_closed',
]);

export function activationTransportConclusion(
  value: unknown,
): ExecutionTraceConclusion['activationTransport'] {
  const keyboard = [...valuesForKey(value, 'keyDownOnTarget'), ...valuesForKey(value, 'keyUpOnTarget')].includes(true);
  const pointer = [
    ...valuesForKey(value, 'pointerDownOnTarget'),
    ...valuesForKey(value, 'mouseDownOnTarget'),
    ...valuesForKey(value, 'pointerUpOnTarget'),
    ...valuesForKey(value, 'mouseUpOnTarget'),
  ].includes(true);
  return keyboard && pointer ? 'mixed' : keyboard ? 'keyboard' : pointer ? 'pointer' : null;
}

export function controlRevealInteractionConclusion(
  value: unknown,
): ExecutionTraceConclusion['controlRevealInteraction'] {
  const candidates = [
    ...valuesForKey(value, 'revealInteraction'),
    ...valuesForKey(value, 'interactionUsed'),
  ];
  const observed = new Set(candidates.filter(
    (candidate): candidate is NonNullable<ExecutionTraceConclusion['controlRevealInteraction']> =>
      typeof candidate === 'string' &&
      CONTROL_REVEAL_INTERACTIONS.has(candidate as NonNullable<ExecutionTraceConclusion['controlRevealInteraction']>),
  ));
  return observed.size === 1 ? [...observed][0]! : null;
}

export function selectionInteractionConclusion(
  value: unknown,
): ExecutionTraceConclusion['selectionInteraction'] {
  const observed = new Set(valuesForKey(value, 'interactionUsed').filter(
    (candidate): candidate is NonNullable<ExecutionTraceConclusion['selectionInteraction']> =>
      typeof candidate === 'string' &&
      SELECTION_INTERACTIONS.has(candidate as NonNullable<ExecutionTraceConclusion['selectionInteraction']>),
  ));
  return observed.size === 1 ? [...observed][0]! : null;
}

export function searchableSelectionConclusion(
  value: unknown,
): ExecutionTraceConclusion['searchableSelection'] {
  const candidates = [
    ...valuesForKey(value, 'searchableCommit'),
    ...valuesForKey(value, 'searchableSelection'),
  ].filter(isRecord);
  const observed = candidates.flatMap((candidate) => {
    const activeOptionProof = candidate.activeOptionProof === null ? null :
      typeof candidate.activeOptionProof === 'string' &&
        ACTIVE_OPTION_PROOFS.has(candidate.activeOptionProof as NonNullable<NonNullable<ExecutionTraceConclusion['searchableSelection']>['activeOptionProof']>)
        ? candidate.activeOptionProof as NonNullable<NonNullable<ExecutionTraceConclusion['searchableSelection']>['activeOptionProof']>
        : undefined;
    const queryActionDispatched = dispatchValue(candidate.queryActionDispatched);
    const commitActionDispatched = dispatchValue(candidate.commitActionDispatched);
    const selectionProof = candidate.selectionProof === undefined ? null :
      typeof candidate.selectionProof === 'string' &&
        SELECTION_PROOFS.has(candidate.selectionProof as NonNullable<NonNullable<ExecutionTraceConclusion['searchableSelection']>['selectionProof']>)
        ? candidate.selectionProof as NonNullable<NonNullable<ExecutionTraceConclusion['searchableSelection']>['selectionProof']>
        : undefined;
    if (
      activeOptionProof === undefined || queryActionDispatched === undefined ||
      commitActionDispatched === undefined || selectionProof === undefined
    ) return [];
    return [{ activeOptionProof, queryActionDispatched, commitActionDispatched, selectionProof }];
  });
  const unique = new Map(observed.map((candidate) => [JSON.stringify(candidate), candidate]));
  return unique.size === 1 ? [...unique.values()][0]! : null;
}

export function formFieldRebindingConclusion(
  value: unknown,
): ExecutionTraceConclusion['formFieldRebinding'] {
  const observed = valuesForKey(value, 'fieldRebinding').flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.attempted !== 'boolean' || typeof candidate.failed !== 'boolean') return [];
    const reboundSteps = boundedNullableInteger(candidate.reboundSteps, 20);
    return reboundSteps === undefined || reboundSteps === null
      ? []
      : [{ attempted: candidate.attempted, reboundSteps, failed: candidate.failed }];
  });
  const unique = new Map(observed.map((candidate) => [JSON.stringify(candidate), candidate]));
  return unique.size === 1 ? [...unique.values()][0]! : null;
}

function dispatchValue(value: unknown): boolean | 'unknown' | null | undefined {
  return value === true || value === false || value === 'unknown' || value === null ? value : undefined;
}
