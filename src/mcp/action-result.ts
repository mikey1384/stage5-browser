import type { BrowserCommandName } from '../protocol.js';

export const COMPACT_ACTION_COMMANDS = [
  'applyFormPlan',
  'clickByRole',
  'clickRef',
  'closeTab',
  'fillByRole',
  'fillRef',
  'motion',
  'navigateHistory',
  'selectOption',
  'selectOptions',
  'setChecked',
] as const satisfies readonly BrowserCommandName[];

export type CompactActionCommand = (typeof COMPACT_ACTION_COMMANDS)[number];

export function compactSuccessfulActionResult(
  value: unknown,
  command: CompactActionCommand,
): unknown {
  if (!isRecord(value) || !isRecord(value.result) || typeof value.operationId !== 'string') return value;
  return compactRecord({
    operationId: value.operationId,
    result: compactCommandResult(command, value.result),
    ...(value.runtimeTransition === null || value.runtimeTransition === undefined
      ? {}
      : { runtimeTransition: value.runtimeTransition }),
  });
}

function compactCommandResult(
  command: CompactActionCommand,
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (command === 'clickByRole' || command === 'clickRef') return compactClick(result);
  if (command === 'fillByRole' || command === 'fillRef') return compactFill(result);
  if (command === 'selectOption') return compactSelection(result, false);
  if (command === 'selectOptions') return compactSelection(result, true);
  if (command === 'applyFormPlan') return compactFormPlan(result);
  if (command === 'setChecked') return compactChecked(result);
  if (command === 'motion') return compactMotion(result);
  if (command === 'navigateHistory') return compactHistory(result);
  return compactCloseTab(result);
}

function compactClick(result: Record<string, unknown>): Record<string, unknown> {
  const dispatch = isRecord(result.dispatch) ? result.dispatch : {};
  const postcondition = isRecord(result.postcondition) ? result.postcondition : null;
  return compactRecord({
    actionDispatched: dispatch.actionDispatched,
    clickDispatched: dispatch.clickDispatched,
    effectConfirmed: postcondition?.passed ?? null,
    currentUrl: pageUrl(result.page),
    newPageCount: result.newPageCount,
    newDownloadCount: result.newDownloadCount,
  });
}

function compactFill(result: Record<string, unknown>): Record<string, unknown> {
  const input = isRecord(result.input) ? result.input : {};
  return compactRecord({
    actionDispatched: input.actionDispatched,
    valueMatches: input.valueMatches,
    alreadySatisfied: input.valueMatchedBefore,
  });
}

function compactSelection(
  result: Record<string, unknown>,
  multiple: boolean,
): Record<string, unknown> {
  const currentState = isRecord(result.currentState) ? result.currentState : {};
  return compactRecord({
    selectionSucceeded: result.selectionSucceeded,
    interactionUsed: result.interactionUsed,
    actionDispatched: result.actionDispatched,
    ...(multiple ? { selectedNames: result.selectedNames } : {
      selectedName: result.selectedName,
      selected: result.selected,
    }),
    popupOpen: currentState.popupOpen,
    multiple: currentState.multiple,
    nextAction: result.nextAction,
  });
}

function compactFormPlan(result: Record<string, unknown>): Record<string, unknown> {
  const completedSteps = Array.isArray(result.completedSteps)
    ? result.completedSteps.flatMap((candidate) => {
        if (!isRecord(candidate)) return [];
        return [compactRecord({
          index: candidate.index,
          fieldId: candidate.fieldId,
          kind: candidate.kind,
          actionDispatched: candidate.actionDispatched,
          alreadySatisfied: candidate.alreadySatisfied,
          fieldResolution: candidate.fieldResolution,
        })];
      })
    : [];
  return compactRecord({
    actionDispatched: result.actionDispatched,
    completedSteps,
    fieldRebinding: result.fieldRebinding,
    requiresFreshSummary: result.requiresFreshSummary,
  });
}

function compactChecked(result: Record<string, unknown>): Record<string, unknown> {
  const after = isRecord(result.after) ? result.after : {};
  return compactRecord({
    actionDispatched: result.actionDispatched,
    checked: result.checked,
    alreadySatisfied: result.alreadySatisfied,
    selected: after.selected,
    valid: after.valid,
  });
}

function compactMotion(result: Record<string, unknown>): Record<string, unknown> {
  const dispatch = isRecord(result.dispatch) ? result.dispatch : {};
  const postcondition = isRecord(result.postcondition) ? result.postcondition : null;
  return compactRecord({
    motion: result.motion,
    actionDispatched: dispatch.actionDispatched,
    effectConfirmed: postcondition?.passed ?? null,
    newPageCount: result.newPageCount,
    newDownloadCount: result.newDownloadCount,
  });
}

function compactHistory(result: Record<string, unknown>): Record<string, unknown> {
  return compactRecord({
    action: result.action,
    actionDispatched: result.actionDispatched,
    moved: result.moved,
    finalUrl: result.finalUrl,
    warnings: result.warnings,
  });
}

function compactCloseTab(result: Record<string, unknown>): Record<string, unknown> {
  return compactRecord({
    actionDispatched: result.actionDispatched,
    closedTabId: result.closedTabId,
    wasSelected: result.wasSelected,
    selectedTabId: result.selectedTabId,
    remainingPageCount: Array.isArray(result.pages) ? result.pages.length : null,
  });
}

function pageUrl(value: unknown): unknown {
  return isRecord(value) ? value.url : undefined;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
