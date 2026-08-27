import {
  type BrowserCommandInput,
  type BrowserCommandOutput,
  type ControlSelectionEvidence,
  type ElementHandle,
  type Frame,
  type Locator,
  type Page,
  type SearchableActiveOptionProof,
  Stage5BrowserError,
} from '../dependencies.js';
import { boundedValue, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import { completedSelectionSummary } from './selection-summary.js';

interface SearchableControlState {
  activeOptionProof: SearchableActiveOptionProof | null;
  focused: boolean;
  popupOpen: boolean | null;
  selectedExact: boolean;
  valueExact: boolean;
}

interface SearchableObservation {
  handle: ElementHandle<HTMLElement>;
  state: SearchableControlState;
}

function aggregateDispatch(
  query: boolean | 'unknown',
  commit: boolean | 'unknown',
): boolean | 'unknown' {
  if (query === 'unknown' || commit === 'unknown') return 'unknown';
  return query || commit;
}

function inspectSearchableControlState(
  element: HTMLElement,
  requestedName: string,
): SearchableControlState {
  const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim();
  const accessibleName = (candidate: Element): string => {
    const labelledBy = (candidate.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/u)
      .filter(Boolean)
      .map((id) => candidate.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ');
    return normalize(candidate.getAttribute('aria-label') ?? '') ||
      normalize(labelledBy) || normalize(candidate.textContent ?? '');
  };
  const rendered = (candidate: Element): boolean => {
    const rect = candidate.getBoundingClientRect();
    const style = getComputedStyle(candidate);
    return candidate.isConnected && rect.width > 0 && rect.height > 0 &&
      style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };
  const optionRoles = new Set(['menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'treeitem']);
  const exactOption = (candidate: Element | null): candidate is HTMLElement =>
    candidate instanceof HTMLElement && rendered(candidate) &&
    optionRoles.has(candidate.getAttribute('role') ?? '') &&
    candidate.getAttribute('aria-disabled') !== 'true' &&
    accessibleName(candidate) === requestedName;
  const linkedIds = [
    ...(element.getAttribute('aria-controls') ?? '').split(/\s+/u),
    ...(element.getAttribute('aria-owns') ?? '').split(/\s+/u),
  ].filter(Boolean);
  const linkedRoots = linkedIds
    .map((id) => element.ownerDocument.getElementById(id))
    .filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement);
  const withinLinkedSurface = (candidate: Element): boolean =>
    element.contains(candidate) || linkedRoots.some((root) => root === candidate || root.contains(candidate));
  const focusedElement = element.ownerDocument.activeElement;
  const focused = focusedElement === element || element.contains(focusedElement);
  const activeDescendantId = element.getAttribute('aria-activedescendant');
  const activeDescendant = activeDescendantId === null
    ? null
    : element.ownerDocument.getElementById(activeDescendantId);
  const activeOptionProof = focused && exactOption(activeDescendant)
    ? 'aria_activedescendant'
    : exactOption(focusedElement) && withinLinkedSurface(focusedElement)
      ? 'focused_linked_option'
      : null;
  const selectedCandidates = [element, ...linkedRoots]
    .flatMap((root) => Array.from(root.querySelectorAll(
      '[role="option"][aria-selected="true"], [role="menuitemcheckbox"][aria-checked="true"], ' +
      '[role="menuitemradio"][aria-checked="true"], [role="radio"][aria-checked="true"], ' +
      '[role="treeitem"][aria-selected="true"]',
    )));
  const selectedExact = selectedCandidates.some(exactOption);
  const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    ? element.value
    : element.getAttribute('aria-valuetext') ?? '';
  const expanded = element.getAttribute('aria-expanded');
  const popupOpen = expanded === 'true' ? true : expanded === 'false' ? false :
    linkedRoots.length > 0 ? linkedRoots.some(rendered) : null;
  return {
    activeOptionProof,
    focused,
    popupOpen,
    selectedExact,
    valueExact: normalize(value) === requestedName,
  };
}

async function observeSearchableControl(
  locator: Locator,
  requestedName: string,
  deadlineAt: number,
): Promise<SearchableObservation | null> {
  const count = await boundedValue(locator.count(), Math.max(1, remainingUntil(deadlineAt)), -1);
  if (count !== 1) return null;
  const handle = await boundedValue(
    locator.elementHandle() as Promise<ElementHandle<HTMLElement> | null>,
    Math.max(1, remainingUntil(deadlineAt)),
    null,
  );
  if (handle === null) return null;
  const state = await boundedValue(
    handle.evaluate(inspectSearchableControlState, requestedName),
    Math.max(1, remainingUntil(deadlineAt)),
    null,
  );
  if (state === null) {
    await handle.dispose().catch(() => undefined);
    return null;
  }
  return { handle, state };
}

async function waitForSearchableControl(
  page: Page,
  locator: Locator,
  requestedName: string,
  deadlineAt: number,
  accepted: (state: SearchableControlState) => boolean,
): Promise<SearchableObservation | null> {
  let last: SearchableObservation | null = null;
  while (Date.now() < deadlineAt) {
    await last?.handle.dispose().catch(() => undefined);
    last = await observeSearchableControl(locator, requestedName, deadlineAt);
    if (last !== null && accepted(last.state)) return last;
    const waitMs = Math.min(50, remainingUntil(deadlineAt));
    if (waitMs > 0) await page.waitForTimeout(waitMs);
  }
  return last;
}

export const searchableSelectionOperations = {
  async selectSearchableOptionIfEligible(
    input: BrowserCommandInput<'selectOption'>,
    page: Page,
    frame: Frame,
    deadlineAt: number,
  ): Promise<BrowserCommandOutput<'selectOption'> | null> {
    const interaction = input.interaction ?? 'auto';
    if (interaction === 'observed_option') return null;
    const control = input.control;
    const option = input.option;
    const forced = interaction === 'type_and_enter';
    if (
      control === null || option === null || input.selected === false ||
      !control.exact || !option.exact || !['combobox', 'searchbox'].includes(control.role)
    ) {
      if (!forced) return null;
      throw new Stage5BrowserError('OPERATION_FAILED', 'Search-and-commit requires one exact editable single-select control and option.', {
        recoverable: true,
        details: { reason: 'searchable_selection_not_eligible', actionDispatched: false },
      });
    }

    const locator = frame.getByRole(control.role, { name: control.name, exact: true });
    const eligibilityHandle = await this.resolveUniqueFillTarget(
      locator,
      control.role,
      control.name,
      remainingUntil(deadlineAt),
    );
    const eligible = await boundedValue(
      eligibilityHandle.evaluate((element) => {
        const inputElement = element instanceof HTMLInputElement ? element : null;
        const editable = inputElement !== null || element instanceof HTMLTextAreaElement || element.isContentEditable;
        const disabled = ('disabled' in element && Boolean((element as HTMLInputElement).disabled)) ||
          element.getAttribute('aria-disabled') === 'true';
        const readOnly = ('readOnly' in element && Boolean((element as HTMLInputElement).readOnly)) ||
          element.getAttribute('aria-readonly') === 'true';
        const multiple = element.getAttribute('aria-multiselectable') === 'true';
        return editable && !disabled && !readOnly && !multiple && inputElement?.type !== 'password';
      }),
      Math.max(1, remainingUntil(deadlineAt)),
      false,
    );
    await eligibilityHandle.dispose().catch(() => undefined);
    if (!eligible) {
      if (!forced) return null;
      throw new Stage5BrowserError('OPERATION_FAILED', 'The exact control is not an editable single-select search control.', {
        recoverable: true,
        details: { reason: 'searchable_selection_not_eligible', actionDispatched: false },
      });
    }

    const initial = await observeSearchableControl(locator, option.name, deadlineAt);
    const initialSelectionProof = initial?.state.selectedExact === true
      ? 'selected_state' as const
      : initial?.state.valueExact === true && initial.state.popupOpen === false
        ? 'value_and_popup_closed' as const
        : null;
    if (initial !== null && initialSelectionProof !== null) {
      const popupClosed = initial.state.popupOpen === null ? null : !initial.state.popupOpen;
      await initial.handle.dispose().catch(() => undefined);
      const evidence: ControlSelectionEvidence = {
        actionDispatched: false,
        inputEventObserved: false,
        changeEventObserved: false,
        selectionEffectObserved: true,
        selectedRepresentationObserved: true,
        selectedState: initial.state.selectedExact ? true : null,
        popupClosed,
        reconciliation: {
          targetResolution: 'retained_exact',
          attempts: 0,
          durationMs: 0,
          terminalProof: initialSelectionProof === 'selected_state'
            ? 'selected_state'
            : 'representation_change',
        },
        searchableCommit: {
          queryActionDispatched: false,
          activeOptionProof: null,
          commitActionDispatched: false,
          selectionProof: initialSelectionProof,
        },
      };
      return {
        ...completedSelectionSummary([evidence], false, true, 'searchable_keyboard'),
        page: await this.pageSummary(page, undefined, remainingUntil(deadlineAt)),
        frame: this.frameSummary(frame, page),
        inspectionId: null,
        optionId: null,
        selectedName: option.name,
        selected: true,
        kind: 'custom_popup',
        evidence,
      };
    }
    await initial?.handle.dispose().catch(() => undefined);

    const query = await this.fillByRole({
      role: control.role,
      name: control.name,
      exact: true,
      frameId: input.frameId,
      value: option.name,
      timeoutMs: Math.max(1, remainingUntil(deadlineAt)),
      ...(input.intent === undefined ? {} : { intent: input.intent }),
      dialogResponse: null,
    });
    const proofDeadlineAt = Math.min(deadlineAt, Date.now() + 1_000);
    const prepared = await waitForSearchableControl(
      page,
      locator,
      option.name,
      proofDeadlineAt,
      ({ activeOptionProof, focused }) => focused && activeOptionProof !== null,
    );
    if (prepared?.state.activeOptionProof === null || prepared === null) {
      await prepared?.handle.dispose().catch(() => undefined);
      throw new Stage5BrowserError('OPERATION_FAILED', 'The exact query was entered, but no exact active option was proven before Enter.', {
        recoverable: true,
        details: {
          reason: 'searchable_selection_active_option_unproven',
          actionDispatched: query.input.actionDispatched,
          searchableSelection: {
            interactionUsed: 'searchable_keyboard',
            queryActionDispatched: query.input.actionDispatched,
            activeOptionProof: null,
            commitActionDispatched: false,
          },
          suggestedAction: 'Inspect the focused control once. The query may already be present; do not type it again automatically.',
        },
      });
    }

    const activeOptionProof = prepared.state.activeOptionProof;
    let commitActionDispatched: boolean | 'unknown' = 'unknown';
    let commitError: unknown = null;
    try {
      const commit = await this.motion({
        motion: { kind: 'press', target: { kind: 'role', ...control }, key: 'Enter' },
        frameId: input.frameId,
        postcondition: null,
        timeoutMs: Math.max(1, remainingUntil(deadlineAt)),
        ...(input.intent === undefined ? {} : { intent: input.intent }),
        dialogResponse: null,
      });
      commitActionDispatched = commit.dispatch.actionDispatched;
    } catch (error) {
      commitError = error;
      const raw = error instanceof Stage5BrowserError ? error.details?.actionDispatched : null;
      commitActionDispatched = raw === true || raw === false || raw === 'unknown' ? raw : 'unknown';
    }

    const reconciliationStartedAt = Date.now();
    const reconciliationDeadlineAt = Math.min(deadlineAt, reconciliationStartedAt + 1_500);
    const observed = await waitForSearchableControl(
      page,
      locator,
      option.name,
      reconciliationDeadlineAt,
      ({ popupOpen, selectedExact, valueExact }) => selectedExact || (valueExact && popupOpen === false),
    );
    const sameControl = observed === null ? false : await prepared.handle
      .evaluate((before, after) => before === after, observed.handle)
      .catch(() => false);
    await prepared.handle.dispose().catch(() => undefined);
    const selectionProof = observed?.state.selectedExact === true
      ? 'selected_state' as const
      : observed?.state.valueExact === true && observed.state.popupOpen === false
        ? 'value_and_popup_closed' as const
        : null;
    if (selectionProof === null || observed === null) {
      await observed?.handle.dispose().catch(() => undefined);
      throw new Stage5BrowserError(
        commitError instanceof Stage5BrowserError ? commitError.code : 'OPERATION_FAILED',
        'Enter may have been dispatched, but the exact option selection was not proven.',
        {
          recoverable: true,
          details: {
            ...(commitError instanceof Stage5BrowserError ? commitError.details : {}),
            reason: 'searchable_selection_effect_unconfirmed',
            actionDispatched: aggregateDispatch(query.input.actionDispatched, commitActionDispatched),
            searchableSelection: {
              interactionUsed: 'searchable_keyboard',
              queryActionDispatched: query.input.actionDispatched,
              activeOptionProof,
              commitActionDispatched,
              selectionProof: 'unresolved',
            },
            suggestedAction: 'Inspect authoritative selected state. Do not press Enter or retype the query automatically.',
          },
          cause: commitError,
        },
      );
    }
    const popupClosed = observed.state.popupOpen === null ? null : !observed.state.popupOpen;
    await observed.handle.dispose().catch(() => undefined);
    const evidence: ControlSelectionEvidence = {
      actionDispatched: aggregateDispatch(query.input.actionDispatched, commitActionDispatched),
      inputEventObserved: query.input.inputEventObserved,
      changeEventObserved: query.input.changeEventObserved,
      selectionEffectObserved: true,
      selectedRepresentationObserved: true,
      selectedState: observed.state.selectedExact ? true : null,
      popupClosed,
      reconciliation: {
        targetResolution: sameControl ? 'retained_exact' : 'rebound_exact',
        attempts: 1,
        durationMs: Date.now() - reconciliationStartedAt,
        terminalProof: selectionProof === 'selected_state' ? 'selected_state' : 'representation_change',
      },
      searchableCommit: {
        queryActionDispatched: query.input.actionDispatched,
        activeOptionProof,
        commitActionDispatched,
        selectionProof,
      },
    };
    return {
      ...completedSelectionSummary([evidence], false, true, 'searchable_keyboard'),
      page: await this.pageSummary(page, undefined, remainingUntil(deadlineAt)),
      frame: this.frameSummary(frame, page),
      inspectionId: null,
      optionId: null,
      selectedName: option.name,
      selected: true,
      kind: 'custom_popup',
      evidence,
    };
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type SearchableSelectionOperations = typeof searchableSelectionOperations;
