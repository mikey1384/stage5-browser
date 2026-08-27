export interface ControlOptionElementState {
  name: string;
  role: string;
  selected: boolean | null;
  disabled: boolean;
  multipleSignal: boolean;
}

/**
 * Reads explicit option state without depending on a particular component
 * framework. Keep this function self-contained because Playwright serializes it
 * into the page rather than executing it in Node.
 */
export function inspectControlOptionElement(element: HTMLElement): ControlOptionElementState | null {
  if (!element.isConnected) return null;
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return null;

  const role = (element.getAttribute('role') ?? '').toLocaleLowerCase();
  const labelledBy = (element.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
    .join(' ');
  const rawName = element.getAttribute('aria-label') || labelledBy ||
    (element instanceof HTMLOptionElement ? element.label : '') ||
    element.innerText || element.textContent || element.getAttribute('title') || '';

  type ExplicitState = { selected: boolean; multipleSignal: boolean };
  const explicitState = (candidate: Element): ExplicitState | null => {
    if (candidate instanceof HTMLOptionElement) {
      return { selected: candidate.selected, multipleSignal: false };
    }
    if (candidate instanceof HTMLInputElement &&
      (candidate.type.toLocaleLowerCase() === 'checkbox' || candidate.type.toLocaleLowerCase() === 'radio')) {
      return {
        selected: candidate.checked,
        multipleSignal: candidate.type.toLocaleLowerCase() === 'checkbox',
      };
    }

    const candidateRole = (candidate.getAttribute('role') ?? '').toLocaleLowerCase();
    const ariaSelected = candidate.getAttribute('aria-selected');
    if (ariaSelected === 'true' || ariaSelected === 'false') {
      return { selected: ariaSelected === 'true', multipleSignal: false };
    }
    const ariaChecked = candidate.getAttribute('aria-checked');
    if (ariaChecked === 'true' || ariaChecked === 'false') {
      return {
        selected: ariaChecked === 'true',
        multipleSignal: candidateRole !== 'radio' && candidateRole !== 'menuitemradio',
      };
    }
    const ariaPressed = candidate.getAttribute('aria-pressed');
    if (ariaPressed === 'true' || ariaPressed === 'false') {
      return { selected: ariaPressed === 'true', multipleSignal: false };
    }

    const booleanDataState = (
      name: 'data-selected' | 'data-checked' | 'data-pressed',
      multipleSignal: boolean,
    ): ExplicitState | null => {
      const value = candidate.getAttribute(name)?.trim().toLocaleLowerCase();
      if (value === undefined) return null;
      if (value === '' || value === 'true') return { selected: true, multipleSignal };
      if (value === 'false') return { selected: false, multipleSignal };
      return null;
    };
    const selectedData = booleanDataState('data-selected', false);
    if (selectedData !== null) return selectedData;
    const checkedData = booleanDataState('data-checked', true);
    if (checkedData !== null) return checkedData;
    const pressedData = booleanDataState('data-pressed', false);
    if (pressedData !== null) return pressedData;

    const dataState = candidate.getAttribute('data-state')?.trim().toLocaleLowerCase();
    if (dataState === 'checked' || dataState === 'unchecked') {
      return { selected: dataState === 'checked', multipleSignal: true };
    }
    if (dataState === 'selected' || dataState === 'unselected' || dataState === 'on' || dataState === 'off') {
      return {
        selected: dataState === 'selected' || dataState === 'on',
        multipleSignal: false,
      };
    }

    const headlessState = candidate.getAttribute('data-headlessui-state');
    if (headlessState !== null) {
      const tokens = new Set(headlessState.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean));
      if (tokens.has('checked')) return { selected: true, multipleSignal: true };
      if (tokens.has('selected')) return { selected: true, multipleSignal: false };
    }
    return null;
  };

  const stateSelector = [
    'input[type="checkbox"]',
    'input[type="radio"]',
    'option',
    '[aria-selected]',
    '[aria-checked]',
    '[aria-pressed]',
    '[data-state]',
    '[data-selected]',
    '[data-checked]',
    '[data-pressed]',
    '[data-headlessui-state]',
  ].join(',');
  const descendants = Array.from(element.querySelectorAll(stateSelector));
  const boundedDescendants = descendants.length <= 64 ? descendants : [];
  const states = [element, ...boundedDescendants]
    .map(explicitState)
    .filter((state): state is ExplicitState => state !== null);
  const selectedValues = new Set(states.map((state) => state.selected));

  return {
    role,
    name: rawName.replace(/\s+/g, ' ').trim(),
    selected: selectedValues.size === 1 ? states[0]!.selected : null,
    disabled: element.getAttribute('aria-disabled') === 'true' ||
      ('disabled' in element && Boolean((element as HTMLButtonElement).disabled)),
    multipleSignal: role === 'menuitemcheckbox' ||
      states.some((state) => state.multipleSignal),
  };
}
