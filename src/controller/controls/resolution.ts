import { type BrowserCommandInput, type ElementHandle, type Frame, inspectTargetState, type Locator, Stage5BrowserError } from '../dependencies.js';
import { boundedValue, remainingUntil } from '../model.js';

export async function resolveUniqueControl(
  input: BrowserCommandInput<'inspectControl'>['control'],
  frame: Frame,
  deadlineAt: number,
): Promise<{ locator: Locator; handle: ElementHandle<HTMLElement> }> {
  const locator = frame.getByRole(input.role, { name: input.name, exact: input.exact });
  const count = await boundedValue(
    locator.count(),
    Math.max(1, remainingUntil(deadlineAt)),
    -1,
  );
  if (count !== 1) {
    throw new Stage5BrowserError(
      count > 1 ? 'AMBIGUOUS_TARGET' : count === 0 ? 'TARGET_NOT_FOUND' : 'OPERATION_FAILED',
      count > 1
        ? 'Multiple controls matched; Stage5 Browser will not choose one arbitrarily.'
        : count === 0
          ? 'No control matched the requested role and accessible name.'
          : 'Control resolution exceeded the bounded inspection deadline.',
      {
        recoverable: true,
        details: {
          reason: count > 1 ? 'ambiguous_control' : count === 0 ? 'control_not_found' : 'control_resolution_timeout',
          actionDispatched: false,
          matchCount: count > 0 ? count : undefined,
          suggestedAction: 'Take one fresh semantic snapshot and identify one exact control. Stage5 Browser confirmed that no control input was dispatched.',
        },
      },
    );
  }
  const handle = await boundedValue(
    locator.elementHandle() as Promise<ElementHandle<HTMLElement> | null>,
    Math.max(1, remainingUntil(deadlineAt)),
    null,
  );
  if (handle === null) {
    throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The exact control detached before inspection.', {
      recoverable: true,
      details: {
        reason: 'control_detached_before_inspection',
        actionDispatched: false,
        suggestedAction: 'Take one fresh semantic snapshot. Stage5 Browser confirmed that no control input was dispatched.',
      },
    });
  }
  const state = await boundedValue(
    inspectTargetState(handle),
    Math.max(1, remainingUntil(deadlineAt)),
    null,
  );
  if (state === null || !state.visible || !state.enabled) {
    await handle.dispose().catch(() => undefined);
    throw new Stage5BrowserError('OPERATION_FAILED', 'The exact control is not available for bounded option inspection.', {
      recoverable: true,
      details: {
        reason: state === null ? 'control_detached_before_inspection' : !state.visible ? 'control_not_visible' : 'control_not_enabled',
        actionDispatched: false,
        suggestedAction: 'Inspect the current page state and resolve the exact control state before continuing. No control input was dispatched.',
      },
    });
  }
  return { locator, handle };
}
