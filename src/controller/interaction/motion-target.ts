import { type BrowserMotionTarget, type ElementHandle, type Frame, inspectTargetState, type Locator, type Page, type SafeTargetState, Stage5BrowserError } from '../dependencies.js';
import { boundedValue, CLICK_REF_INCREMENTAL_SETTLE_MS, type ObservedSnapshot, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export interface PreparedMotionTarget {
  locator: Locator;
  handle: ElementHandle<HTMLElement | SVGElement>;
  state: SafeTargetState;
}

export const interactionMotionTargetOperations = {
  validateMotionTargetCapability(
    frame: Frame,
    target: BrowserMotionTarget,
  ): ObservedSnapshot | null {
    if (target.kind === 'role') return null;
    const observed = this.observedSnapshots.get(frame);
    if (
      observed === undefined ||
      observed.id !== target.snapshotId ||
      observed.documentVersion !== this.documentVersion(frame) ||
      !observed.refs.has(target.ref)
    ) {
      throw new Stage5BrowserError(
        'TARGET_NOT_FOUND',
        'The motion reference is not an exact capability from the latest snapshot.',
        {
          recoverable: true,
          details: {
            reason: 'stale_or_unknown_motion_reference',
            actionDispatched: false,
            suggestedAction: 'Take one fresh semantic snapshot and use only an exact returned ref.',
          },
        },
      );
    }
    return observed;
  },

  async prepareMotionTarget(
    page: Page,
    frame: Frame,
    target: BrowserMotionTarget,
    observed: ObservedSnapshot | null,
    pointerRequired: boolean,
    deadlineAt: number,
  ): Promise<PreparedMotionTarget> {
    let locator: Locator;
    let handle: ElementHandle<HTMLElement | SVGElement> | null = null;
    if (target.kind === 'ref') {
      if (observed === null) {
        throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The motion reference capability was not retained.', {
          recoverable: true,
          details: { reason: 'motion_reference_not_retained', actionDispatched: false },
        });
      }
      const resolved = await this.resolveObservedReferenceAfterActivation(
        frame,
        observed,
        target.ref,
        deadlineAt,
      );
      if (resolved.kind !== 'resolved') {
        throw new Stage5BrowserError(
          resolved.kind === 'ambiguous' ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND',
          'The exact motion target could not be uniquely retained after page preparation.',
          {
            recoverable: true,
            details: {
              reason: `motion_reference_${resolved.kind}`,
              actionDispatched: false,
              suggestedAction: 'Take one fresh semantic snapshot. Stage5 Browser confirmed that no motion input was dispatched.',
            },
          },
        );
      }
      locator = resolved.locator;
      handle = resolved.handle;
    } else {
      locator = frame.getByRole(target.role, { name: target.name, exact: target.exact });
      const count = await boundedValue(
        locator.count(),
        Math.max(1, remainingUntil(deadlineAt)),
        -1,
      );
      if (count !== 1) {
        throw new Stage5BrowserError(
          count > 1 ? 'AMBIGUOUS_TARGET' : count === 0 ? 'TARGET_NOT_FOUND' : 'OPERATION_FAILED',
          count > 1
            ? 'Multiple elements matched the exact motion target.'
            : count === 0
              ? 'No element matched the exact motion target.'
              : 'Motion target resolution exceeded its bounded deadline.',
          {
            recoverable: true,
            details: {
              reason: count > 1 ? 'ambiguous_motion_target' : count === 0 ? 'motion_target_missing' : 'motion_target_resolution_timeout',
              actionDispatched: false,
              suggestedAction: 'Inspect the current semantic state and bind one exact target before dispatch.',
            },
          },
        );
      }
      handle = await boundedValue(
        locator.elementHandle() as Promise<ElementHandle<HTMLElement | SVGElement> | null>,
        Math.max(1, remainingUntil(deadlineAt)),
        null,
      );
      if (handle === null) {
        throw new Stage5BrowserError('TARGET_NOT_FOUND', 'The exact motion target detached before dispatch.', {
          recoverable: true,
          details: { reason: 'motion_target_detached', actionDispatched: false },
        });
      }
    }

    let state = await boundedValue(
      inspectTargetState(handle),
      Math.max(1, remainingUntil(deadlineAt)),
      null,
    );
    if (state !== null && state.visible && !state.inViewport) {
      await boundedValue(
        handle.evaluate((element) => {
          if (!element.isConnected) return false;
          element.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
          return true;
        }),
        Math.max(1, remainingUntil(deadlineAt)),
        false,
      );
      const settleMs = Math.min(CLICK_REF_INCREMENTAL_SETTLE_MS, remainingUntil(deadlineAt));
      if (settleMs > 0) await page.waitForTimeout(settleMs);
      state = await boundedValue(
        inspectTargetState(handle),
        Math.max(1, remainingUntil(deadlineAt)),
        null,
      );
    }
    const actionable = state !== null && state.visible && state.inViewport && state.enabled &&
      (!pointerRequired || state.receivesPointerEvents === true);
    if (!actionable || state === null) {
      await handle.dispose().catch(() => undefined);
      throw new Stage5BrowserError('OPERATION_FAILED', 'The exact motion target is not safely actionable.', {
        recoverable: true,
        details: {
          reason: state === null
            ? 'motion_target_detached'
            : !state.visible || !state.inViewport
              ? 'motion_target_not_visible'
              : !state.enabled
                ? 'motion_target_not_enabled'
                : 'motion_target_pointer_intercepted',
          actionDispatched: false,
          targetState: state,
          suggestedAction: 'Inspect the target state once. Stage5 Browser confirmed that no motion input was dispatched.',
        },
      });
    }
    return { locator, handle, state };
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type InteractionMotionTargetOperations = typeof interactionMotionTargetOperations;
