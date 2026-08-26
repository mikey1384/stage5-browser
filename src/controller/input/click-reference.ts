import { type Browser, type ClickPostcondition, type ElementHandle, type Frame, inspectTargetState, type Locator, type Page, type SanitizedPageActivationEvidence } from '../dependencies.js';
import { boundedValue, CLICK_REF_ELEMENT_CANDIDATES, CLICK_REF_INCREMENTAL_SCROLL_STEPS, CLICK_REF_INCREMENTAL_SETTLE_MS, CLICK_REF_REBIND_SETTLE_MS, CLICK_REF_VIEWPORT_PREPARATION_TIMEOUT_MS, type ObservedReferenceResolution, type ObservedReferenceSemantic, type ObservedSnapshot, POPUP_OPTION_ROLES, type PreparedObservedClickTarget, remainingUntil } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';
import type { ViewportPreparationTelemetry } from '../../protocol/telemetry.js';

export const inputClickReferenceOperations = {
  async preferredObservedClickActivation(
    handle: ElementHandle<HTMLElement | SVGElement>,
    actionDeadlineAt: number,
    postcondition: ClickPostcondition | null,
  ): Promise<PreparedObservedClickTarget['activation']> {
    // A native button's keyboard semantics may act on a framework-managed
    // active option before the exact observed button receives a click. Keep
    // keyboard activation as a guarded, postconditioned recovery primitive;
    // ordinary exact-target contact uses the pointer like every other target.
    if (postcondition === null) return 'pointer';
    const useKeyboard = await boundedValue(
      handle.evaluate((element) => element instanceof HTMLButtonElement),
      Math.max(1, remainingUntil(actionDeadlineAt)),
      false,
    );
    if (!useKeyboard) return 'pointer';
    const expectedRole = postcondition?.expectedVisible?.role.toLocaleLowerCase() ?? null;
    const optionExpected = expectedRole !== null && POPUP_OPTION_ROLES.has(expectedRole);
    return optionExpected ? 'keyboard_space' : 'keyboard_enter';
  },

  async resolveObservedReferenceAfterActivation(
    frame: Frame,
    observed: ObservedSnapshot,
    ref: string,
    actionDeadlineAt: number,
  ): Promise<ObservedReferenceResolution> {
    const scopeConnected = await boundedValue(
      observed.scopeHandle.evaluate((root) => root.isConnected),
      Math.max(1, remainingUntil(actionDeadlineAt)),
      null,
    );
    if (scopeConnected === null) return { kind: 'timeout' };
    if (!scopeConnected) return { kind: 'scope_changed' };

    const exactLocator = frame.locator(`aria-ref=${ref}`);
    const exactCount = await boundedValue(
      exactLocator.count(),
      Math.max(1, remainingUntil(actionDeadlineAt)),
      -1,
    );
    if (exactCount < 0) return { kind: 'timeout' };
    if (exactCount > 1) return { kind: 'ambiguous' };

    const semantic = observed.refSemantics.get(ref);
    if (exactCount === 1) {
      const exactHandle = await boundedValue(
        exactLocator.elementHandle(),
        Math.max(1, remainingUntil(actionDeadlineAt)),
        null,
      );
      if (exactHandle !== null) {
        const insideScope = await boundedValue(
          observed.scopeHandle.evaluate(
            (root, target) => root.isConnected && target.isConnected && (root === target || root.contains(target)),
            exactHandle,
          ),
          Math.max(1, remainingUntil(actionDeadlineAt)),
          null,
        );
        if (insideScope === null) {
          await exactHandle.dispose().catch(() => undefined);
          return { kind: 'timeout' };
        }
        if (insideScope) {
          if (semantic === undefined) {
            return { kind: 'resolved', locator: exactLocator, handle: exactHandle };
          }
          const identity = await boundedValue(
            this.semanticForExactReference(exactLocator, actionDeadlineAt),
            Math.max(1, remainingUntil(actionDeadlineAt)),
            null,
          );
          if (identity !== null && this.sameObservedReferenceSemantic(semantic, identity)) {
            return { kind: 'resolved', locator: exactLocator, handle: exactHandle };
          }
        }
        await exactHandle.dispose().catch(() => undefined);
      }
    }

    if (semantic === undefined) return { kind: 'missing' };
    const transitionDeadline = Math.min(
      actionDeadlineAt,
      Date.now() + CLICK_REF_REBIND_SETTLE_MS,
    );
    do {
      const resolved = await this.resolveUniqueSemanticReferenceInScope(
        frame,
        observed.scopeHandle,
        semantic,
        transitionDeadline,
      );
      if (resolved.kind !== 'missing' || Date.now() >= transitionDeadline) {
        return resolved;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, transitionDeadline - Date.now())));
    } while (Date.now() < transitionDeadline);
    return { kind: 'missing' };
  },

  async resolveUniqueSemanticReferenceInScope(
    frame: Frame,
    scopeHandle: ElementHandle<HTMLElement>,
    semantic: ObservedReferenceSemantic,
    deadlineAt: number,
  ): Promise<ObservedReferenceResolution> {
    try {
      const locator = frame.getByRole(
        semantic.role as Parameters<Frame['getByRole']>[0],
        { name: semantic.name, exact: true },
      );
      const count = await boundedValue(
        locator.count(),
        Math.max(1, remainingUntil(deadlineAt)),
        -1,
      );
      if (count < 0) return { kind: 'timeout' };
      if (count > CLICK_REF_ELEMENT_CANDIDATES) return { kind: 'ambiguous' };

      let match: { locator: Locator; handle: ElementHandle<HTMLElement | SVGElement> } | null = null;
      for (let index = 0; index < count; index += 1) {
        if (remainingUntil(deadlineAt) <= 0) {
          await match?.handle.dispose().catch(() => undefined);
          return { kind: 'timeout' };
        }
        const candidateLocator = locator.nth(index);
        const handle = await boundedValue(
          candidateLocator.elementHandle(),
          Math.max(1, remainingUntil(deadlineAt)),
          null,
        );
        if (handle === null) continue;
        const insideScope = await boundedValue(
          scopeHandle.evaluate(
            (root, target) => root.isConnected && target.isConnected && (root === target || root.contains(target)),
            handle,
          ),
          Math.max(1, remainingUntil(deadlineAt)),
          null,
        );
        if (insideScope === null) {
          await handle.dispose().catch(() => undefined);
          await match?.handle.dispose().catch(() => undefined);
          return { kind: 'timeout' };
        }
        if (!insideScope) {
          await handle.dispose().catch(() => undefined);
          continue;
        }
        if (semantic.url !== null) {
          const candidateUrl = await boundedValue(
            handle.getAttribute('href'),
            Math.max(1, remainingUntil(deadlineAt)),
            null,
          );
          if (candidateUrl !== semantic.url) {
            await handle.dispose().catch(() => undefined);
            continue;
          }
        }
        if (match !== null) {
          await handle.dispose().catch(() => undefined);
          await match.handle.dispose().catch(() => undefined);
          return { kind: 'ambiguous' };
        }
        match = { locator: candidateLocator, handle };
      }
      return match === null ? { kind: 'missing' } : { kind: 'resolved', ...match };
    } catch {
      return { kind: 'missing' };
    }
  },

  async prepareObservedClickTarget(
    page: Page,
    frame: Frame,
    locator: Locator,
    startedAt: string,
    actionDeadlineAt: number,
    postcondition: ClickPostcondition | null,
    pageActivation: SanitizedPageActivationEvidence | null = null,
    retainedHandle: ElementHandle<HTMLElement | SVGElement> | null = null,
  ): Promise<PreparedObservedClickTarget> {
    let preparedLocator = locator;
    let handle = retainedHandle ?? await boundedValue(
      locator.elementHandle(),
      Math.max(1, remainingUntil(actionDeadlineAt)),
      null,
    );
    if (handle === null) {
      return this.failClickBeforeDispatch(
        page,
        startedAt,
        null,
        'detached',
        'reference_handle_missing',
        'The observed reference detached before viewport preparation began.',
        'Take one fresh semantic snapshot; Stage5 Browser did not dispatch the click.',
        'TARGET_NOT_FOUND',
      );
    }

    let targetState = await boundedValue(
      inspectTargetState(handle),
      Math.max(1, remainingUntil(actionDeadlineAt)),
      null,
    );
    if (targetState === null) {
      await handle.dispose().catch(() => undefined);
      return this.failClickBeforeDispatch(
        page,
        startedAt,
        null,
        'detached',
        'target_detached_before_scroll',
        'The observed element detached before Stage5 Browser could prepare it for a click.',
        'Take one fresh semantic snapshot; Stage5 Browser did not dispatch the click.',
        'TARGET_NOT_FOUND',
      );
    }

    const viewportPreparation: ViewportPreparationTelemetry = {
      attempts: 0,
      movements: 0,
      horizontalMovement: false,
      verticalMovement: false,
      nestedSurfaceMovement: false,
      documentMovement: false,
      composedBoundaryTraversed: false,
      completedInViewport: targetState.inViewport,
      reachStrategy: 'pointer_viewport',
    };

    const identity = targetState.inViewport
      ? null
      : await boundedValue(
        this.observeClickTargetIdentity(handle),
        Math.max(1, remainingUntil(actionDeadlineAt)),
        null,
      );
    const preparationDeadline = Math.min(
      actionDeadlineAt,
      Date.now() + CLICK_REF_VIEWPORT_PREPARATION_TIMEOUT_MS,
    );

    for (
      let step = 0;
      !targetState.inViewport &&
        step < CLICK_REF_INCREMENTAL_SCROLL_STEPS &&
        Date.now() < preparationDeadline;
      step += 1
    ) {
      viewportPreparation.attempts += 1;
      const movement = await boundedValue(
        this.incrementalScrollTowardClickTarget(handle),
        Math.max(1, remainingUntil(preparationDeadline)),
        null,
      );
      if (movement === null) {
        const rebound = await this.waitForVirtualizedClickTarget(
          frame,
          locator,
          identity,
          preparationDeadline,
        );
        if (rebound.kind !== 'resolved') {
          await handle.dispose().catch(() => undefined);
          return this.failVirtualizedClickRebind(page, startedAt, rebound.kind, targetState);
        }
        await handle.dispose().catch(() => undefined);
        handle = rebound.handle;
        preparedLocator = rebound.locator;
      } else {
        if (movement.moved) viewportPreparation.movements += 1;
        viewportPreparation.horizontalMovement ||= movement.horizontalMovement;
        viewportPreparation.verticalMovement ||= movement.verticalMovement;
        viewportPreparation.nestedSurfaceMovement ||= movement.surface === 'nested';
        viewportPreparation.documentMovement ||= movement.surface === 'document';
        viewportPreparation.composedBoundaryTraversed ||= movement.composedBoundaryTraversed;
      }

      const remaining = preparationDeadline - Date.now();
      if (remaining > 0) {
        await page.waitForTimeout(Math.min(CLICK_REF_INCREMENTAL_SETTLE_MS, remaining));
      }
      const priorTargetState = targetState;
      targetState = await boundedValue(
        inspectTargetState(handle),
        Math.max(1, remainingUntil(preparationDeadline)),
        null,
      );
      if (targetState === null) {
        const rebound = await this.waitForVirtualizedClickTarget(
          frame,
          locator,
          identity,
          preparationDeadline,
        );
        if (rebound.kind !== 'resolved') {
          await handle.dispose().catch(() => undefined);
          return this.failVirtualizedClickRebind(page, startedAt, rebound.kind, priorTargetState);
        }
        await handle.dispose().catch(() => undefined);
        handle = rebound.handle;
        preparedLocator = rebound.locator;
        targetState = await boundedValue(
          inspectTargetState(handle),
          Math.max(1, remainingUntil(preparationDeadline)),
          null,
        );
        if (targetState === null) {
          await handle.dispose().catch(() => undefined);
          return this.failClickBeforeDispatch(
            page,
            startedAt,
            null,
            'detached',
            'virtualized_target_detached_after_rebind',
            'The uniquely rebound element detached again before Stage5 Browser could click it.',
            'Take one fresh semantic snapshot; Stage5 Browser did not dispatch the click.',
            'TARGET_NOT_FOUND',
          );
        }
      }
      if (movement !== null && !movement.moved && !targetState.inViewport) {
        break;
      }
    }

    targetState = await boundedValue(
      inspectTargetState(handle),
      Math.max(1, remainingUntil(actionDeadlineAt)),
      null,
    );
    if (targetState === null) {
      await handle.dispose().catch(() => undefined);
      return this.failClickBeforeDispatch(
        page,
        startedAt,
        null,
        'detached',
        'target_detached_after_scroll',
        'The observed element detached before Stage5 Browser could safely click it.',
        'Take one fresh semantic snapshot; Stage5 Browser did not dispatch the click.',
        'TARGET_NOT_FOUND',
      );
    }
    viewportPreparation.completedInViewport = targetState.inViewport;
    const activation = await this.preferredObservedClickActivation(
      handle,
      actionDeadlineAt,
      postcondition,
    );
    const postconditionedKeyboardActivation = activation !== 'pointer' && postcondition !== null;
    viewportPreparation.reachStrategy = postconditionedKeyboardActivation
      ? 'postconditioned_keyboard'
      : 'pointer_viewport';
    const failure = !targetState.visible || (!targetState.inViewport && !postconditionedKeyboardActivation)
      ? { diagnostic: 'not_visible' as const, reason: 'target_not_actionable_in_viewport' }
      : !targetState.enabled
        ? { diagnostic: 'not_enabled' as const, reason: 'target_not_enabled_after_scroll' }
        : targetState.receivesPointerEvents === false && !postconditionedKeyboardActivation
          ? { diagnostic: 'pointer_intercepted' as const, reason: 'target_covered_after_scroll' }
          : null;
    if (failure !== null) {
      await handle.dispose().catch(() => undefined);
      return this.failClickBeforeDispatch(
        page,
        startedAt,
        targetState,
        failure.diagnostic,
        failure.reason,
        'The observed element was not safely actionable after viewport preparation.',
        'Take a fresh snapshot and resolve the reported visibility, enabled-state, or covering element before another click.',
        'OPERATION_FAILED',
        'click_by_ref',
        { viewportPreparation },
      );
    }
    return {
      locator: preparedLocator,
      handle,
      targetState,
      activation,
      pageActivation,
      viewportPreparation,
    };
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type InputClickReferenceOperations = typeof inputClickReferenceOperations;
