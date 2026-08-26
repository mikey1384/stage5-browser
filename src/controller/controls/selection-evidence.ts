import { type ElementHandle, type Locator, type Page, type PostconditionResult, Stage5BrowserError } from '../dependencies.js';
import { boundedValue, remainingUntil } from '../model.js';
import { popupRendered } from './rendering.js';

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

export async function observeControlSelectionRepresentation(
  control: Locator,
  optionName: string,
  deadlineAt: number,
): Promise<ControlSelectionRepresentation | null> {
  return boundedValue(
    control.evaluate((element, requestedName) => {
      const normalize = (value: string | null | undefined): string =>
        (value ?? '').replaceAll(/\s+/gu, ' ').trim().toLocaleLowerCase();
      const requested = normalize(requestedName);
      if (requested.length === 0) return null;
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
        candidate.closest('[role="listbox"], [role="menu"], [role="tree"]') === null;
      const exactRenderedLeaf = (candidate: Element): boolean => {
        if (!rendered(candidate) || !outsidePopup(candidate)) return false;
        if (normalize(candidate.textContent) !== requested) return false;
        return !Array.from(candidate.children).some((child) =>
          rendered(child) && outsidePopup(child) && normalize(child.textContent) === requested);
      };
      const controlExactRepresentationCount = Array.from(element.querySelectorAll('*'))
        .filter(exactRenderedLeaf).length;
      const controlRepresentsOption = sources.some((source) => source === requested) ||
        normalize(element.textContent) === requested ||
        controlExactRepresentationCount > 0;

      const semanticScope = element.closest('fieldset, [role="group"], label') ?? element.parentElement;
      if (
        semanticScope === null ||
        semanticScope === element.ownerDocument.body ||
        semanticScope === element.ownerDocument.documentElement
      ) {
        return { controlRepresentsOption, localExactRepresentationCount: 0 };
      }
      const descendants = Array.from(semanticScope.querySelectorAll('*'));
      if (descendants.length > 200) {
        return { controlRepresentsOption, localExactRepresentationCount: 0 };
      }
      const exactLeaf = (candidate: Element): boolean => {
        if (candidate === element || element.contains(candidate)) return false;
        return exactRenderedLeaf(candidate);
      };
      return {
        controlRepresentsOption,
        localExactRepresentationCount: descendants.filter(exactLeaf).length,
      };
    }, optionName),
    Math.max(1, remainingUntil(deadlineAt)),
    null,
  );
}

export async function reconcileCustomControlSelection(input: {
  before: ControlSelectionRepresentation;
  control: Locator;
  deadlineAt: number;
  option: Locator;
  optionName: string;
  page: Page;
  popup: ElementHandle<HTMLElement>;
  requireSelected: boolean;
  selectedState: (locator: Locator) => Promise<boolean | null>;
}): Promise<ControlSelectionReconciliation> {
  let selectedState: boolean | null = null;
  let popupClosed = false;
  let selectedRepresentationObserved = false;
  while (true) {
    selectedState = await input.selectedState(input.option);
    popupClosed = !await popupRendered(input.popup, input.deadlineAt);
    const represented = await observeControlSelectionRepresentation(
      input.control,
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
