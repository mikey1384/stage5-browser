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
): Promise<ElementHandle<HTMLElement> | null> {
  const pendingScope = control.evaluateHandle((element, input) => {
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
      input !== null && (candidate === input || input.contains(candidate));
    const hasCompetingField = (candidate: HTMLElement): boolean =>
      Array.from(candidate.querySelectorAll(fieldSelector)).some((field) =>
        field !== element && !element.contains(field) && !popupContains(field));

    let owner = element;
    let candidate = element.parentElement;
    while (candidate !== null) {
      if (candidate === element.ownerDocument.body || candidate === element.ownerDocument.documentElement) break;
      if (hasCompetingField(candidate)) break;
      owner = candidate;
      candidate = candidate.parentElement;
    }
    return owner;
  }, popup).then((handle) => handle.asElement() as ElementHandle<HTMLElement> | null);
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
      const requested = new Set(uniqueRequests.map(({ normalized }) => normalized));
      const sources = new Set([
        element.getAttribute('aria-valuetext'),
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.value
          : null,
        element instanceof HTMLSelectElement
          ? Array.from(element.selectedOptions).map((option) => option.label || option.textContent || '').join(' ')
          : null,
      ].map(normalize).filter(Boolean));
      const rendered = (candidate: Element): boolean => {
        const rect = candidate.getBoundingClientRect();
        const style = getComputedStyle(candidate);
        return rect.width > 0 && rect.height > 0 &&
          style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };
      const outsidePopup = (candidate: Element): boolean =>
        (popupElement === null || (candidate !== popupElement && !popupElement.contains(candidate))) &&
        candidate.closest('[role="listbox"], [role="menu"], [role="tree"]') === null;
      const exactRenderedLeafName = (candidate: Element): string | null => {
        const name = normalize(candidate.textContent);
        if (!requested.has(name)) return null;
        if (!rendered(candidate) || !outsidePopup(candidate)) return null;
        return Array.from(candidate.children).some((child) =>
          rendered(child) && outsidePopup(child) && normalize(child.textContent) === name)
          ? null
          : name;
      };
      const representations = new Map(uniqueRequests.map(({ normalized }) => [normalized, {
        controlRepresentsOption: sources.has(normalized) || normalize(element.textContent) === normalized,
        localExactRepresentationCount: 0,
      }]));
      for (const candidate of Array.from(scope.querySelectorAll('*'))) {
        const name = exactRenderedLeafName(candidate);
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
  requireSelected: boolean;
  selectedState: (locator: Locator) => Promise<boolean | null>;
}): Promise<ControlSelectionReconciliation> {
  let selectedState: boolean | null = null;
  let popupClosed = false;
  let selectedRepresentationObserved = false;
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
    selectedRepresentationObserved = represented !== null && (
      (!input.before.controlRepresentsOption && represented.controlRepresentsOption) ||
      represented.localExactRepresentationCount > input.before.localExactRepresentationCount
    );
    const satisfied = selectedState === true || selectedRepresentationObserved ||
      (!input.requireSelected && popupClosed);
    const checks = [
      {
        kind: 'selection_representation' as const,
        passed: selectedRepresentationObserved,
        expected: true,
        observed: selectedRepresentationObserved,
      },
      {
        kind: 'selected' as const,
        passed: selectedState === true,
        expected: true,
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
        'The option received click input, but no authoritative selected representation was observed.',
        {
          recoverable: true,
          details: {
            reason: 'control_option_selection_not_observed',
            actionDispatched: true,
            clickDispatched: true,
            actionOutcome: 'click_dispatched_postcondition_failed',
            checks,
            suggestedAction: 'Inspect authoritative form state. Do not replay the selection unless one fresh observation proves the option remains unsatisfied and a new action is safe.',
          },
        },
      );
    }
    await input.page.waitForTimeout(Math.min(50, remainingUntil(input.deadlineAt)));
  }
}
