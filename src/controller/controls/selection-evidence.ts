import { type ElementHandle, type Locator, type Page, type PostconditionResult, Stage5BrowserError } from '../dependencies.js';
import { boundedValue, remainingUntil } from '../model.js';
import { popupRenderedState } from './rendering.js';

export interface ControlSelectionRepresentation {
  controlRepresentsOption: boolean;
  localExactRepresentationCount: number;
}

export interface ControlSelectionReconciliation {
  postcondition: PostconditionResult;
  popupClosed: boolean;
  selectedRepresentationObserved: boolean;
  selectedState: boolean | null;
}

export interface AdaptiveControlSelectionRepresentations {
  scope: ElementHandle<HTMLElement>;
  representations: Map<string, ControlSelectionRepresentation> | null;
}

interface ControlRepresentationEvaluator {
  evaluate<Result>(
    pageFunction: (
      control: HTMLElement,
      input: { owner: HTMLElement; popup: HTMLElement | null; requestedNames: string[] },
    ) => Result,
    input: {
      owner: ElementHandle<HTMLElement>;
      popup: ElementHandle<HTMLElement> | null;
      requestedNames: string[];
    },
  ): Promise<Result>;
}

export async function resolveControlSelectionRepresentationScope(
  control: ElementHandle<HTMLElement>,
  popup: ElementHandle<HTMLElement> | null,
  deadlineAt: number,
  includeSameNamedCompositeFields = false,
): Promise<ElementHandle<HTMLElement> | null> {
  const pendingScope = control.evaluateHandle((element, input) => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? '').replaceAll(/\s+/gu, ' ').trim().toLocaleLowerCase();
    const fieldSelector = [
      'input:not([type="hidden"])',
      'textarea',
      'select',
      '[contenteditable="true"]',
      '[role="checkbox"]',
      '[role="combobox"]',
      '[role="listbox"]',
      '[role="radio"]',
      '[role="spinbutton"]',
      '[role="switch"]',
      '[aria-haspopup]',
    ].join(',');
    const popupContains = (candidate: Element): boolean =>
      input.popup !== null && (candidate === input.popup || input.popup.contains(candidate));
    const semanticName = (candidate: Element): string => {
      const labelledBy = (candidate.getAttribute('aria-labelledby') ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => candidate.ownerDocument.getElementById(id)?.textContent ?? '')
        .join(' ');
      const labels = candidate instanceof HTMLButtonElement ||
        candidate instanceof HTMLInputElement ||
        candidate instanceof HTMLSelectElement ||
        candidate instanceof HTMLTextAreaElement
        ? Array.from(candidate.labels ?? []).map((label) => label.textContent ?? '').join(' ')
        : '';
      return normalize(candidate.getAttribute('aria-label') || labelledBy || labels ||
        candidate.textContent || candidate.getAttribute('title'));
    };
    const controlName = semanticName(element);
    const competingFields = (candidate: HTMLElement): Element[] =>
      Array.from(candidate.querySelectorAll(fieldSelector)).filter((field) =>
        field !== element && !element.contains(field) && !popupContains(field));

    let owner = element;
    let candidate = element.parentElement;
    while (candidate !== null) {
      if (candidate === element.ownerDocument.body || candidate === element.ownerDocument.documentElement) break;
      const competing = competingFields(candidate);
      if (competing.length > 0) {
        if (
          input.includeSameNamedCompositeFields &&
          controlName.length > 0 &&
          competing.every((field) => semanticName(field) === controlName)
        ) {
          owner = candidate;
          candidate = candidate.parentElement;
          continue;
        }
        break;
      }
      owner = candidate;
      candidate = candidate.parentElement;
    }
    return owner;
  }, { popup, includeSameNamedCompositeFields }).then((handle) =>
    handle.asElement() as ElementHandle<HTMLElement> | null);
  const scope = await boundedValue(
    pendingScope,
    Math.max(1, remainingUntil(deadlineAt)),
    null,
  );
  if (scope === null) {
    void pendingScope.then((lateScope) => lateScope?.dispose()).catch(() => undefined);
  }
  return scope;
}

export async function observeControlSelectionRepresentation(
  control: ElementHandle<HTMLElement>,
  owner: ElementHandle<HTMLElement>,
  popup: ElementHandle<HTMLElement> | null,
  optionName: string,
  deadlineAt: number,
): Promise<ControlSelectionRepresentation | null> {
  const representations = await observeControlSelectionRepresentations(
    control,
    owner,
    popup,
    [optionName],
    deadlineAt,
  );
  return representations?.get(optionName) ?? null;
}

export async function observeControlSelectionRepresentationsInAdaptiveScope(
  control: ElementHandle<HTMLElement>,
  popup: ElementHandle<HTMLElement> | null,
  optionNames: string[],
  deadlineAt: number,
  initialScope?: ElementHandle<HTMLElement>,
): Promise<AdaptiveControlSelectionRepresentations | null> {
  const ownsInitialScope = initialScope === undefined;
  const scope = initialScope ?? await resolveControlSelectionRepresentationScope(
    control,
    popup,
    deadlineAt,
  );
  if (scope === null) return null;
  const representations = await observeControlSelectionRepresentations(
    control,
    scope,
    popup,
    optionNames,
    deadlineAt,
  );
  if (
    representations === null ||
    optionNames.length === 0 ||
    [...representations.values()].some(representationSelected)
  ) {
    return { scope, representations };
  }

  const expandedScope = await resolveControlSelectionRepresentationScope(
    control,
    popup,
    deadlineAt,
    true,
  );
  if (expandedScope === null) return { scope, representations };
  const expandedRepresentations = await observeControlSelectionRepresentations(
    control,
    expandedScope,
    popup,
    optionNames,
    deadlineAt,
  );
  if (
    expandedRepresentations !== null &&
    [...expandedRepresentations.values()].some(representationSelected)
  ) {
    if (ownsInitialScope) await scope.dispose().catch(() => undefined);
    return { scope: expandedScope, representations: expandedRepresentations };
  }
  await expandedScope.dispose().catch(() => undefined);
  return { scope, representations };
}

export async function observeControlSelectionRepresentations(
  control: ElementHandle<HTMLElement>,
  owner: ElementHandle<HTMLElement>,
  popup: ElementHandle<HTMLElement> | null,
  optionNames: string[],
  deadlineAt: number,
): Promise<Map<string, ControlSelectionRepresentation> | null> {
  if (optionNames.length === 0) return new Map();
  const evaluator = control as unknown as ControlRepresentationEvaluator;
  const observed = await boundedValue(
    evaluator.evaluate((element, input) => {
      const normalize = (value: string | null | undefined): string =>
        (value ?? '').replaceAll(/\s+/gu, ' ').trim().toLocaleLowerCase();
      const { owner: scope, popup: popupElement, requestedNames } = input;
      if (!scope.isConnected || !element.isConnected || (scope !== element && !scope.contains(element))) return null;
      const requests = requestedNames.map((original) => ({ original, normalized: normalize(original) }));
      const frequencies = new Map<string, number>();
      for (const { normalized } of requests) {
        if (normalized.length > 0) frequencies.set(normalized, (frequencies.get(normalized) ?? 0) + 1);
      }
      const uniqueRequests = requests.filter(({ normalized }) =>
        normalized.length > 0 && frequencies.get(normalized) === 1);
      const requested = uniqueRequests.map(({ normalized }) => normalized);
      const sources = [
        element.getAttribute('aria-valuetext'),
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.value
          : null,
        element instanceof HTMLSelectElement
          ? Array.from(element.selectedOptions).map((option) => option.label || option.textContent || '').join(' ')
          : null,
      ].map(normalize).filter(Boolean);
      const rendered = (candidate: Element): boolean => {
        const rect = candidate.getBoundingClientRect();
        const style = getComputedStyle(candidate);
        return rect.width > 0 && rect.height > 0 &&
          style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };
      const outsidePopup = (candidate: Element): boolean =>
        (popupElement === null || (candidate !== popupElement && !popupElement.contains(candidate))) &&
        candidate.closest('[role="listbox"], [role="menu"], [role="tree"]') === null;
      const matchingRequest = (candidateName: string): string | null => {
        if (candidateName.length === 0) return null;
        const matches = requested.filter((requestedName) =>
          requestedName === candidateName || requestedName.startsWith(`${candidateName} `));
        return matches.length === 1 ? matches[0]! : null;
      };
      const candidateRequest = (candidate: Element): string | null => {
        const labelledBy = (candidate.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => candidate.ownerDocument.getElementById(id)?.textContent ?? '')
          .join(' ');
        const names = new Set([
          candidate.textContent,
          candidate.getAttribute('aria-label'),
          labelledBy,
          candidate.getAttribute('title'),
        ].map(normalize).filter(Boolean));
        const matches = new Set([...names].map(matchingRequest).filter((match): match is string => match !== null));
        return matches.size === 1 ? [...matches][0]! : null;
      };
      const renderedLeafRequest = (candidate: Element): string | null => {
        const name = candidateRequest(candidate);
        if (name === null) return null;
        if (!rendered(candidate) || !outsidePopup(candidate)) return null;
        return Array.from(candidate.children).some((child) =>
          rendered(child) && outsidePopup(child) && candidateRequest(child) === name)
          ? null
          : name;
      };
      const representations = new Map(uniqueRequests.map(({ normalized }) => [normalized, {
        controlRepresentsOption: false,
        localExactRepresentationCount: 0,
      }]));
      for (const source of [...sources, normalize(element.textContent)]) {
        const name = matchingRequest(source);
        if (name !== null) representations.get(name)!.controlRepresentsOption = true;
      }
      for (const candidate of Array.from(scope.querySelectorAll('*'))) {
        const name = renderedLeafRequest(candidate);
        if (name === null) continue;
        const representation = representations.get(name);
        if (representation === undefined) continue;
        if (element.contains(candidate)) {
          representation.controlRepresentsOption = true;
        } else {
          representation.localExactRepresentationCount += 1;
        }
      }
      return uniqueRequests.map(({ original, normalized }) => [
        original,
        representations.get(normalized)!,
      ] as const);
    }, { owner, popup, requestedNames: optionNames }),
    Math.max(1, remainingUntil(deadlineAt)),
    null,
  );
  return observed === null ? null : new Map(observed);
}

export async function reconcileCustomControlSelection(input: {
  before: ControlSelectionRepresentation;
  control: ElementHandle<HTMLElement>;
  deadlineAt: number;
  option: Locator;
  optionName: string;
  owner: ElementHandle<HTMLElement>;
  page: Page;
  popup: ElementHandle<HTMLElement>;
  desiredSelected: boolean;
  requireSelected: boolean;
  selectedState: (locator: Locator) => Promise<boolean | null>;
}): Promise<ControlSelectionReconciliation> {
  let selectedState: boolean | null = null;
  let popupClosed = false;
  let selectedRepresentationObserved = false;
  const beforeRepresentationSelected = representationSelected(input.before);
  while (true) {
    selectedState = await boundedValue(
      input.selectedState(input.option),
      Math.max(1, remainingUntil(input.deadlineAt)),
      null,
    );
    if (await popupRenderedState(input.popup, input.deadlineAt) === false) popupClosed = true;
    const represented = await observeControlSelectionRepresentation(
      input.control,
      input.owner,
      input.popup,
      input.optionName,
      input.deadlineAt,
    );
    selectedRepresentationObserved = represented !== null && representationSelected(represented);
    const representationMatched = represented !== null &&
      beforeRepresentationSelected !== input.desiredSelected &&
      selectedRepresentationObserved === input.desiredSelected;
    const satisfied = selectedState === input.desiredSelected || representationMatched ||
      (input.desiredSelected && !input.requireSelected && popupClosed);
    const checks = [
      {
        kind: 'selection_representation' as const,
        passed: representationMatched,
        expected: input.desiredSelected,
        observed: selectedRepresentationObserved,
      },
      {
        kind: 'selected' as const,
        passed: selectedState === input.desiredSelected,
        expected: input.desiredSelected,
        observed: selectedState,
      },
      {
        kind: 'popup_closed' as const,
        passed: popupClosed,
        expected: true,
        observed: popupClosed,
      },
    ];
    if (satisfied) {
      return {
        postcondition: { passed: true, checks },
        popupClosed,
        selectedRepresentationObserved,
        selectedState,
      };
    }
    if (remainingUntil(input.deadlineAt) <= 0) {
      throw new Stage5BrowserError(
        'POSTCONDITION_FAILED',
        `The option received click input, but the requested ${input.desiredSelected ? 'selected' : 'unselected'} state was not observed.`,
        {
          recoverable: true,
          details: {
            reason: input.desiredSelected
              ? 'control_option_selection_not_observed'
              : 'control_option_deselection_not_observed',
            actionDispatched: true,
            clickDispatched: true,
            actionOutcome: 'click_dispatched_postcondition_failed',
            checks,
            suggestedAction: 'Inspect authoritative form state. Do not replay the option input unless one fresh observation proves the requested state remains unsatisfied and a new action is safe.',
          },
        },
      );
    }
    await input.page.waitForTimeout(Math.min(50, remainingUntil(input.deadlineAt)));
  }
}

function representationSelected(representation: ControlSelectionRepresentation): boolean {
  return representation.controlRepresentsOption || representation.localExactRepresentationCount > 0;
}
