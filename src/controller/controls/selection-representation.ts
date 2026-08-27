import { type ElementHandle } from '../dependencies.js';
import {
  boundedValue,
  type ObservedControlPopupSurface,
  remainingUntil,
} from '../model.js';

export interface ControlSelectionRepresentation {
  controlRepresentsOption: boolean;
  controlConnected: boolean;
  localExactRepresentationCount: number;
}

export interface AdaptiveControlSelectionRepresentations {
  scope: ElementHandle<HTMLElement>;
  representations: Map<string, ControlSelectionRepresentation> | null;
}

interface ControlRepresentationEvaluator {
  evaluate<Result>(
    pageFunction: (
      owner: HTMLElement,
      input: {
        control: HTMLElement;
        popups: HTMLElement[];
        requestedNames: string[];
      },
    ) => Result,
    input: {
      control: ElementHandle<HTMLElement>;
      popups: ElementHandle<HTMLElement>[];
      requestedNames: string[];
    },
  ): Promise<Result>;
}

export async function resolveControlSelectionRepresentationScope(
  control: ElementHandle<HTMLElement>,
  popupSurfaces: readonly ObservedControlPopupSurface[],
  deadlineAt: number,
  includeSameNamedCompositeFields = false,
): Promise<ElementHandle<HTMLElement> | null> {
  const pendingScope = control
    .evaluateHandle(
      (element, input) => {
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
          input.popups.some(
            (popup) => candidate === popup || popup.contains(candidate),
          );
        const semanticName = (candidate: Element): string => {
          const labelledBy = (candidate.getAttribute('aria-labelledby') ?? '')
            .split(/\s+/)
            .filter(Boolean)
            .map(
              (id) =>
                candidate.ownerDocument.getElementById(id)?.textContent ?? '',
            )
            .join(' ');
          const labels =
            candidate instanceof HTMLButtonElement ||
            candidate instanceof HTMLInputElement ||
            candidate instanceof HTMLSelectElement ||
            candidate instanceof HTMLTextAreaElement
              ? Array.from(candidate.labels ?? [])
                  .map((label) => label.textContent ?? '')
                  .join(' ')
              : '';
          return normalize(
            candidate.getAttribute('aria-label') ||
              labelledBy ||
              labels ||
              candidate.textContent ||
              candidate.getAttribute('title'),
          );
        };
        const controlName = semanticName(element);
        const competingFields = (candidate: HTMLElement): Element[] =>
          Array.from(candidate.querySelectorAll(fieldSelector)).filter(
            (field) =>
              field !== element &&
              !element.contains(field) &&
              !popupContains(field),
          );

        let owner = element;
        let candidate = element.parentElement;
        while (candidate !== null) {
          if (
            candidate === element.ownerDocument.body ||
            candidate === element.ownerDocument.documentElement
          )
            break;
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
      },
      {
        popups: popupSurfaces.map(({ handle }) => handle),
        includeSameNamedCompositeFields,
      },
    )
    .then((handle) => handle.asElement() as ElementHandle<HTMLElement> | null);
  const scope = await boundedValue(
    pendingScope,
    Math.max(1, remainingUntil(deadlineAt)),
    null,
  );
  if (scope === null) {
    void pendingScope
      .then((lateScope) => lateScope?.dispose())
      .catch(() => undefined);
  }
  return scope;
}

export async function observeControlSelectionRepresentation(
  control: ElementHandle<HTMLElement>,
  owner: ElementHandle<HTMLElement>,
  popupSurfaces: readonly ObservedControlPopupSurface[],
  optionName: string,
  deadlineAt: number,
): Promise<ControlSelectionRepresentation | null> {
  const representations = await observeControlSelectionRepresentations(
    control,
    owner,
    popupSurfaces,
    [optionName],
    deadlineAt,
  );
  return representations?.get(optionName) ?? null;
}

export async function observeControlSelectionRepresentationsInAdaptiveScope(
  control: ElementHandle<HTMLElement>,
  popupSurfaces: readonly ObservedControlPopupSurface[],
  optionNames: string[],
  deadlineAt: number,
  initialScope?: ElementHandle<HTMLElement>,
): Promise<AdaptiveControlSelectionRepresentations | null> {
  const ownsInitialScope = initialScope === undefined;
  const scope =
    initialScope ??
    (await resolveControlSelectionRepresentationScope(
      control,
      popupSurfaces,
      deadlineAt,
    ));
  if (scope === null) return null;
  const representations = await observeControlSelectionRepresentations(
    control,
    scope,
    popupSurfaces,
    optionNames,
    deadlineAt,
  );
  if (
    representations === null ||
    optionNames.length === 0 ||
    [...representations.values()].some(controlSelectionRepresentationSelected)
  ) {
    return { scope, representations };
  }

  const expandedScope = await resolveControlSelectionRepresentationScope(
    control,
    popupSurfaces,
    deadlineAt,
    true,
  );
  if (expandedScope === null) return { scope, representations };
  const expandedRepresentations = await observeControlSelectionRepresentations(
    control,
    expandedScope,
    popupSurfaces,
    optionNames,
    deadlineAt,
  );
  if (
    expandedRepresentations !== null &&
    [...expandedRepresentations.values()].some(
      controlSelectionRepresentationSelected,
    )
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
  popupSurfaces: readonly ObservedControlPopupSurface[],
  optionNames: string[],
  deadlineAt: number,
): Promise<Map<string, ControlSelectionRepresentation> | null> {
  if (optionNames.length === 0) return new Map();
  const evaluator = owner as unknown as ControlRepresentationEvaluator;
  const observed = await boundedValue(
    evaluator.evaluate(
      (scope, input) => {
        const normalize = (value: string | null | undefined): string =>
          (value ?? '').replaceAll(/\s+/gu, ' ').trim().toLocaleLowerCase();
        const {
          control: element,
          popups: popupElements,
          requestedNames,
        } = input;
        if (!scope.isConnected) return null;
        const controlConnected =
          element.isConnected && (scope === element || scope.contains(element));
        const requests = requestedNames.map((original) => ({
          original,
          normalized: normalize(original),
        }));
        const frequencies = new Map<string, number>();
        for (const { normalized } of requests) {
          if (normalized.length > 0)
            frequencies.set(normalized, (frequencies.get(normalized) ?? 0) + 1);
        }
        const uniqueRequests = requests.filter(
          ({ normalized }) =>
            normalized.length > 0 && frequencies.get(normalized) === 1,
        );
        const requested = uniqueRequests.map(({ normalized }) => normalized);
        const sources = controlConnected
          ? [
              element.getAttribute('aria-valuetext'),
              element instanceof HTMLInputElement ||
              element instanceof HTMLTextAreaElement
                ? element.value
                : null,
              element instanceof HTMLSelectElement
                ? Array.from(element.selectedOptions)
                    .map((option) => option.label || option.textContent || '')
                    .join(' ')
                : null,
            ]
              .map(normalize)
              .filter(Boolean)
          : [];
        const rendered = (candidate: Element): boolean => {
          const rect = candidate.getBoundingClientRect();
          const style = getComputedStyle(candidate);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0'
          );
        };
        const outsidePopup = (candidate: Element): boolean =>
          popupElements.every(
            (popup) => candidate !== popup && !popup.contains(candidate),
          ) &&
          candidate.closest(
            '[role="listbox"], [role="menu"], [role="tree"]',
          ) === null;
        const matchingRequest = (candidateName: string): string | null => {
          if (candidateName.length === 0) return null;
          const matches = requested.filter(
            (requestedName) =>
              requestedName === candidateName ||
              requestedName.startsWith(`${candidateName} `),
          );
          return matches.length === 1 ? matches[0]! : null;
        };
        const candidateRequest = (candidate: Element): string | null => {
          const labelledBy = (candidate.getAttribute('aria-labelledby') ?? '')
            .split(/\s+/)
            .filter(Boolean)
            .map(
              (id) =>
                candidate.ownerDocument.getElementById(id)?.textContent ?? '',
            )
            .join(' ');
          const names = new Set(
            [
              candidate.textContent,
              candidate.getAttribute('aria-label'),
              labelledBy,
              candidate.getAttribute('title'),
            ]
              .map(normalize)
              .filter(Boolean),
          );
          const matches = new Set(
            [...names]
              .map(matchingRequest)
              .filter((match): match is string => match !== null),
          );
          return matches.size === 1 ? [...matches][0]! : null;
        };
        const renderedLeafRequest = (candidate: Element): string | null => {
          const name = candidateRequest(candidate);
          if (name === null) return null;
          if (!rendered(candidate) || !outsidePopup(candidate)) return null;
          return Array.from(candidate.children).some(
            (child) =>
              rendered(child) &&
              outsidePopup(child) &&
              candidateRequest(child) === name,
          )
            ? null
            : name;
        };
        const representations = new Map(
          uniqueRequests.map(({ normalized }) => [
            normalized,
            {
              controlRepresentsOption: false,
              controlConnected,
              localExactRepresentationCount: 0,
            },
          ]),
        );
        for (const source of [
          ...sources,
          ...(controlConnected ? [normalize(element.textContent)] : []),
        ]) {
          const name = matchingRequest(source);
          if (name !== null)
            representations.get(name)!.controlRepresentsOption = true;
        }
        for (const candidate of Array.from(scope.querySelectorAll('*'))) {
          const name = renderedLeafRequest(candidate);
          if (name === null) continue;
          const representation = representations.get(name);
          if (representation === undefined) continue;
          if (controlConnected && element.contains(candidate)) {
            representation.controlRepresentsOption = true;
          } else {
            representation.localExactRepresentationCount += 1;
          }
        }
        return uniqueRequests.map(
          ({ original, normalized }) =>
            [original, representations.get(normalized)!] as const,
        );
      },
      {
        control,
        popups: popupSurfaces.map(({ handle }) => handle),
        requestedNames: optionNames,
      },
    ),
    Math.max(1, remainingUntil(deadlineAt)),
    null,
  );
  return observed === null ? null : new Map(observed);
}

export function controlSelectionRepresentationSelected(
  representation: ControlSelectionRepresentation,
): boolean {
  return (
    representation.controlRepresentsOption ||
    representation.localExactRepresentationCount > 0
  );
}
