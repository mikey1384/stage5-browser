import type { FormFieldObservation } from '../dependencies.js';

export const FORM_FIELD_SELECTOR = [
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
].join(', ');

export function describeFormFieldElement(
  element: HTMLElement,
): Omit<FormFieldObservation, 'fieldId'> | null {
  const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim();
  const labelledBy = (element.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/u)
    .filter(Boolean)
    .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
    .join(' ');
  const labels = element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
    ? Array.from(element.labels ?? []).map((label) => label.textContent ?? '').join(' ')
    : '';
  const rawName = [
    element.getAttribute('aria-label') ?? '',
    labelledBy,
    labels,
    element.getAttribute('placeholder') ?? '',
    element.getAttribute('title') ?? '',
  ].map(normalize).find((value) => value.length > 0) ?? '';
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const visible = rect.width > 0 && rect.height > 0 &&
    style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  if (!visible) return null;

  const input = element instanceof HTMLInputElement ? element : null;
  const inputType = input?.type.toLocaleLowerCase() ?? null;
  const explicitRole = element.getAttribute('role')?.toLocaleLowerCase() ?? null;
  const role = explicitRole ?? (
    element instanceof HTMLSelectElement ? (element.multiple ? 'listbox' : 'combobox') :
      element instanceof HTMLTextAreaElement || element.isContentEditable ? 'textbox' :
        inputType === 'checkbox' ? 'checkbox' :
          inputType === 'radio' ? 'radio' :
            inputType === 'number' ? 'spinbutton' :
              inputType === 'search' ? 'searchbox' : 'textbox'
  );
  const kind = inputType === 'password' ? 'private' :
    inputType === 'file' ? 'file' :
      inputType === 'checkbox' ? 'checkbox' :
        inputType === 'radio' ? 'radio' :
          inputType === 'date' ? 'date' :
            element instanceof HTMLSelectElement ? 'native_select' :
              element instanceof HTMLTextAreaElement ? 'textarea' :
                element.isContentEditable ? 'contenteditable' :
                  explicitRole === 'combobox' || explicitRole === 'listbox' ? 'custom_control' : 'text';
  const disabled = ('disabled' in element && Boolean((element as HTMLInputElement).disabled)) ||
    element.getAttribute('aria-disabled') === 'true';
  const readOnly = ('readOnly' in element && Boolean((element as HTMLInputElement).readOnly)) ||
    element.getAttribute('aria-readonly') === 'true';
  const required = ('required' in element && Boolean((element as HTMLInputElement).required)) ||
    element.getAttribute('aria-required') === 'true';
  const selected = inputType === 'checkbox' || inputType === 'radio'
    ? input?.checked ?? null
    : element.getAttribute('aria-checked') === null
      ? null
      : element.getAttribute('aria-checked') === 'true';
  const valuePresence = kind === 'private' ? 'not_observed_private' :
    kind === 'checkbox' || kind === 'radio' || kind === 'custom_control' ? 'not_applicable' :
      element instanceof HTMLSelectElement ? (element.selectedIndex >= 0 ? 'present' : 'empty') :
        inputType === 'file' ? ((input?.files?.length ?? 0) > 0 ? 'present' : 'empty') :
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? (element.value.length > 0 ? 'present' : 'empty')
            : (element.textContent ?? '').trim().length > 0 ? 'present' : 'empty';
  const ariaInvalid = element.getAttribute('aria-invalid');
  const valid = ariaInvalid !== null ? ariaInvalid !== 'true' :
    'checkValidity' in element && typeof element.checkValidity === 'function'
      ? element.checkValidity()
      : null;
  const optionNames = element instanceof HTMLSelectElement
    ? Array.from(element.options).slice(0, 100)
      .map((option) => normalize(option.label || option.textContent || '')).filter(Boolean)
    : [];
  const selectedOptionNames = element instanceof HTMLSelectElement
    ? Array.from(element.selectedOptions).slice(0, 20)
      .map((option) => normalize(option.label || option.textContent || '')).filter(Boolean)
    : [];
  return {
    kind,
    role,
    name: rawName.length === 0 ? null : rawName.slice(0, 500),
    inputType,
    required,
    disabled,
    readOnly,
    multiple: element instanceof HTMLSelectElement
      ? element.multiple
      : element.getAttribute('aria-multiselectable') === 'true',
    optionNames,
    selectedOptionNames,
    optionsComplete: !(element instanceof HTMLSelectElement) || element.options.length <= 100,
    valuePresence,
    selected,
    valid,
  };
}
