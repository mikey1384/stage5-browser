import { type BrowserCommandInput, type BrowserCommandOutput, type SanitizedNativeWindowActivationEvidence, Stage5BrowserError } from '../dependencies.js';
import type { ObservedSnapshot } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const inputActionsOperations = {
  async clickByRole(
    input: BrowserCommandInput<'clickByRole'>,
  ): Promise<BrowserCommandOutput<'clickByRole'>> {
    return await this.executeClickAction({
      action: 'click_by_role',
      timeoutMs: input.timeoutMs,
      observe: async () => {
        const page = await this.ensureActivePage(this.requireContext());
        return { page, frame: this.resolveFrame(page, input.frameId) };
      },
      plan: ({ page, frame }) => {
        const locator = frame.getByRole(input.role, {
          name: input.name,
          exact: input.exact,
        });
        return {
          action: 'click_by_role',
          page,
          frame,
          postcondition: input.postcondition,
          prepare: (
            priorNativeActivation: SanitizedNativeWindowActivationEvidence | null,
            activationAttemptCount: number,
            actionStartedAt: string,
            actionDeadlineAt: number,
          ) => this.prepareRoleClickTarget(
            page,
            locator,
            actionStartedAt,
            actionDeadlineAt,
            input.role,
            input.name,
            input.postcondition,
            activationAttemptCount,
            priorNativeActivation ?? undefined,
          ),
          reconciliationLocator: () => locator,
          discardCapabilities: () => this.discardObservedSnapshot(frame),
        };
      },
      preflight: () => undefined,
    }) as BrowserCommandOutput<'clickByRole'>;
  },

  async clickRef(
    input: BrowserCommandInput<'clickRef'>,
  ): Promise<BrowserCommandOutput<'clickRef'>> {
    return await this.executeClickAction({
      action: 'click_by_ref',
      timeoutMs: input.timeoutMs,
      observe: async () => {
        const page = await this.ensureActivePage(this.requireContext());
        const frame = this.resolveFrame(page, input.frameId);
        return { page, frame, observed: this.observedSnapshots.get(frame) };
      },
      plan: ({ page, frame, observed }) => ({
        action: 'click_by_ref',
        page,
        frame,
        postcondition: input.postcondition,
        prepare: async (
          priorNativeActivation: SanitizedNativeWindowActivationEvidence | null,
          activationAttemptCount: number,
          actionStartedAt: string,
          actionDeadlineAt: number,
        ) => {
          const retained = observed as ObservedSnapshot;
          const capability = await this.retainObservedReferenceCapability(
            frame,
            retained,
            input.ref,
            actionDeadlineAt,
          );
          try {
            const pageActivation = await this.primeSelectedPageForTargetPreparation(
              page,
              actionDeadlineAt,
              actionStartedAt,
              'click_by_ref',
              activationAttemptCount,
              priorNativeActivation ?? undefined,
            );
            const resolution = await this.resolveObservedReferenceCapabilityAfterActivation(
              frame,
              retained,
              input.ref,
              capability,
              actionDeadlineAt,
            );
            if (resolution.kind !== 'resolved') {
              const ambiguous = resolution.kind === 'ambiguous';
              const timedOut = resolution.kind === 'timeout';
              const scopeChanged = resolution.kind === 'scope_changed';
              return this.failClickBeforeDispatch(
                page,
                actionStartedAt,
                null,
                ambiguous ? 'ambiguous_target' : timedOut ? 'timeout' : 'target_missing',
                ambiguous
                  ? 'reference_semantic_rebind_ambiguous'
                  : timedOut
                    ? 'reference_resolution_deadline_expired'
                    : scopeChanged
                      ? 'snapshot_scope_changed'
                      : 'reference_resolution_changed',
                ambiguous
                  ? 'More than one live element matched the fresh reference semantic inside its retained snapshot scope.'
                  : timedOut
                    ? 'The fresh reference could not be resolved before the shared click deadline.'
                    : scopeChanged
                      ? 'The retained snapshot scope changed before the fresh reference could be resolved.'
                      : 'The fresh reference no longer resolves and no unique semantic replacement exists inside its retained snapshot scope.',
                'Take one fresh semantic snapshot; Stage5 Browser confirmed that no input was dispatched.',
                ambiguous ? 'AMBIGUOUS_TARGET' : timedOut ? 'OPERATION_FAILED' : 'TARGET_NOT_FOUND',
              );
            }
            return this.prepareObservedClickTarget(
              page,
              frame,
              resolution.locator,
              actionStartedAt,
              actionDeadlineAt,
              input.postcondition,
              pageActivation,
              resolution.handle,
            );
          } catch (error) {
            await capability?.handle.dispose().catch(() => undefined);
            throw error;
          }
        },
        reconciliationLocator: (prepared) => prepared.locator,
        discardCapabilities: () => this.discardObservedSnapshot(frame),
      }),
      preflight: (plan) => {
        const observed = this.observedSnapshots.get(plan.frame);
        if (
          observed === undefined ||
          observed.id !== input.snapshotId ||
          observed.documentVersion !== this.documentVersion(plan.frame)
        ) {
          throw new Stage5BrowserError(
            'TARGET_NOT_FOUND',
            'The element reference does not belong to the latest snapshot of the current document.',
            {
              recoverable: true,
              details: {
                reason: 'stale_or_unknown_snapshot',
                actionDispatched: false,
                clickDispatched: false,
                snapshotId: input.snapshotId,
                frameId: input.frameId,
                suggestedAction: 'Take one fresh semantic snapshot; Stage5 Browser confirmed that no input was dispatched.',
              },
            },
          );
        }
        if (!observed.refs.has(input.ref)) {
          throw new Stage5BrowserError(
            'TARGET_NOT_FOUND',
            'The requested reference was not present in that snapshot.',
            {
              recoverable: true,
              details: {
                reason: 'reference_not_observed',
                actionDispatched: false,
                clickDispatched: false,
                ref: input.ref,
                snapshotId: input.snapshotId,
                suggestedAction: 'Take one fresh semantic snapshot; Stage5 Browser confirmed that no input was dispatched.',
              },
            },
          );
        }
      },
    }) as BrowserCommandOutput<'clickRef'>;
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type InputActionsOperations = typeof inputActionsOperations;
