import { type Frame } from '../dependencies.js';
import {
  boundedValue,
  type ClickTargetSemanticIdentity,
  type ObservedReferenceCapability,
  type ObservedReferenceResolution,
  type ObservedSnapshot,
  remainingUntil,
} from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const inputReferenceCapabilityOperations = {
  async retainObservedReferenceCapability(
    frame: Frame,
    observed: ObservedSnapshot,
    ref: string,
    actionDeadlineAt: number,
  ): Promise<ObservedReferenceCapability | null> {
    const locator = frame.locator(`aria-ref=${ref}`);
    const count = await boundedValue(
      locator.count(),
      Math.max(1, remainingUntil(actionDeadlineAt)),
      -1,
    );
    if (count !== 1) return null;
    const handle = await boundedValue(
      locator.elementHandle(),
      Math.max(1, remainingUntil(actionDeadlineAt)),
      null,
    );
    if (handle === null) return null;
    const insideScope = await boundedValue(
      observed.scopeHandle.evaluate(
        (root, target) => root.isConnected && target.isConnected && (root === target || root.contains(target)),
        handle,
      ),
      Math.max(1, remainingUntil(actionDeadlineAt)),
      false,
    );
    const identity = insideScope
      ? await boundedValue(
        this.observeClickTargetIdentity(handle),
        Math.max(1, remainingUntil(actionDeadlineAt)),
        null,
      )
      : null;
    if (identity === null) {
      await handle.dispose().catch(() => undefined);
      return null;
    }
    return { locator, handle, identity };
  },

  async resolveRetainedReferenceCapability(
    observed: ObservedSnapshot,
    capability: ObservedReferenceCapability | null,
    actionDeadlineAt: number,
  ): Promise<ObservedReferenceResolution | null> {
    if (capability === null) return null;
    const insideScope = await boundedValue(
      observed.scopeHandle.evaluate(
        (root, target) => root.isConnected && target.isConnected && (root === target || root.contains(target)),
        capability.handle,
      ),
      Math.max(1, remainingUntil(actionDeadlineAt)),
      false,
    );
    const identity = insideScope
      ? await boundedValue(
        this.observeClickTargetIdentity(capability.handle),
        Math.max(1, remainingUntil(actionDeadlineAt)),
        null,
      )
      : null;
    if (identity !== null && this.sameObservedElementIdentity(capability.identity, identity)) {
      return { kind: 'resolved', locator: capability.locator, handle: capability.handle };
    }
    await capability.handle.dispose().catch(() => undefined);
    return null;
  },

  async resolveObservedReferenceCapabilityAfterActivation(
    frame: Frame,
    observed: ObservedSnapshot,
    ref: string,
    capability: ObservedReferenceCapability | null,
    actionDeadlineAt: number,
  ): Promise<ObservedReferenceResolution> {
    const retained = await this.resolveRetainedReferenceCapability(
      observed,
      capability,
      actionDeadlineAt,
    );
    if (retained !== null) return retained;
    if (capability !== null) {
      const scoped = await this.waitForVirtualizedClickTarget(
        frame,
        capability.locator,
        capability.identity,
        actionDeadlineAt,
      );
      if (scoped.kind === 'resolved') return scoped;
      if (scoped.kind === 'ambiguous') return { kind: 'ambiguous' };
    }
    return this.resolveObservedReferenceAfterActivation(
      frame,
      observed,
      ref,
      actionDeadlineAt,
    );
  },

  sameObservedElementIdentity(
    expected: ClickTargetSemanticIdentity,
    observed: ClickTargetSemanticIdentity,
  ): boolean {
    return expected.tagName === observed.tagName &&
      expected.role === observed.role &&
      expected.name === observed.name &&
      expected.url === observed.url;
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type InputReferenceCapabilityOperations = typeof inputReferenceCapabilityOperations;
