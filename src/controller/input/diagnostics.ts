import { type Browser, type Page, type SafeTargetState, type SanitizedActionDiagnostic, type SanitizedClickDispatchEvidence, sanitizeUrlForJournal, Stage5BrowserError } from '../dependencies.js';
import type { BrowserControllerContext } from '../runtime.js';

export const inputDiagnosticsOperations = {
  failClickBeforeDispatch(
    page: Page,
    startedAt: string,
    targetState: SafeTargetState | null,
    diagnosticReason: SanitizedActionDiagnostic['reason'],
    reason: string,
    message: string,
    suggestedAction: string,
    code: 'AMBIGUOUS_TARGET' | 'OPERATION_FAILED' | 'TARGET_NOT_FOUND' = 'OPERATION_FAILED',
    action: SanitizedActionDiagnostic['action'] = 'click_by_ref',
    extraDetails: Readonly<Record<string, unknown>> | null = null,
  ): never {
    const diagnostic: SanitizedActionDiagnostic = {
      action,
      outcome: 'blocked',
      reason: diagnosticReason,
      actionDispatched: false,
      clickDispatched: false,
      targetState,
      pageUrl: sanitizeUrlForJournal(page.url()) ?? null,
      startedAt,
      occurredAt: new Date().toISOString(),
    };
    this.pageDiagnostics.recordAction(page, diagnostic);
    throw new Stage5BrowserError(code, message, {
      recoverable: true,
      details: {
        ...(extraDetails ?? {}),
        reason,
        actionOutcome: 'blocked',
        actionDispatched: false,
        clickDispatched: false,
        targetState,
        suggestedAction,
      },
    });
  },

  targetingFailureDiagnostic(
    action: SanitizedActionDiagnostic['action'],
    page: Page,
    reason: 'ambiguous_target' | 'target_missing',
  ): SanitizedActionDiagnostic {
    const occurredAt = new Date().toISOString();
    return {
      action,
      outcome: 'blocked',
      reason,
      actionDispatched: false,
      clickDispatched: false,
      targetState: null,
      pageUrl: sanitizeUrlForJournal(page.url()) ?? null,
      startedAt: occurredAt,
      occurredAt,
    };
  },

  successfulActionDiagnostic(
    action: SanitizedActionDiagnostic['action'],
    page: Page,
    targetState: SafeTargetState | null,
    startedAt: string,
    dispatchEvidence: SanitizedClickDispatchEvidence | null = null,
  ): SanitizedActionDiagnostic {
    return {
      action,
      outcome: 'succeeded',
      reason: null,
      actionDispatched: true,
      clickDispatched: true,
      targetState,
      ...(dispatchEvidence === null ? {} : { dispatchEvidence }),
      pageUrl: sanitizeUrlForJournal(page.url()) ?? null,
      startedAt,
      occurredAt: new Date().toISOString(),
    };
  },

  reconciledPartialEffectDiagnostic(
    action: SanitizedActionDiagnostic['action'],
    page: Page,
    targetState: SafeTargetState | null,
    startedAt: string,
    reconciled: {
      dispatchEvidence: SanitizedClickDispatchEvidence | null;
      actionDispatched: boolean | 'unknown';
      clickDispatched: boolean | 'unknown';
    },
  ): SanitizedActionDiagnostic {
    return {
      action,
      outcome: 'succeeded',
      reason: null,
      actionDispatched: reconciled.actionDispatched,
      clickDispatched: reconciled.clickDispatched,
      targetState,
      ...(reconciled.dispatchEvidence === null ? {} : { dispatchEvidence: reconciled.dispatchEvidence }),
      pageUrl: sanitizeUrlForJournal(page.url()) ?? null,
      startedAt,
      occurredAt: new Date().toISOString(),
    };
  },

  postconditionFailureDiagnostic(
    action: SanitizedActionDiagnostic['action'],
    page: Page,
    targetState: SafeTargetState | null,
    startedAt: string,
    dispatchEvidence: SanitizedClickDispatchEvidence | null = null,
  ): SanitizedActionDiagnostic {
    return {
      action,
      outcome: 'postcondition_failed',
      reason: 'postcondition_not_met',
      actionDispatched: true,
      clickDispatched: true,
      targetState,
      ...(dispatchEvidence === null ? {} : { dispatchEvidence }),
      pageUrl: sanitizeUrlForJournal(page.url()) ?? null,
      startedAt,
      occurredAt: new Date().toISOString(),
    };
  },

  scrollActionDiagnostic(
    page: Page,
    startedAt: string,
    actionDispatched: boolean | 'unknown',
    outcome: 'blocked' | 'failed' | 'succeeded',
    reason: SanitizedActionDiagnostic['reason'] = outcome === 'succeeded' ? null : 'unknown',
  ): SanitizedActionDiagnostic {
    return {
      action: 'scroll',
      outcome,
      reason,
      actionDispatched,
      clickDispatched: null,
      targetState: null,
      pageUrl: sanitizeUrlForJournal(page.url()) ?? null,
      startedAt,
      occurredAt: new Date().toISOString(),
    };
  },

  clickFailureError(
    diagnostic: SanitizedActionDiagnostic,
    cause: unknown,
  ): Stage5BrowserError {
    return new Stage5BrowserError(
      'OPERATION_FAILED',
      'The click did not complete. Sanitized actionability evidence is available from browser_diagnostics.',
      {
        recoverable: true,
        details: {
          reason: diagnostic.reason,
          actionDispatched: diagnostic.actionDispatched,
          clickDispatched: diagnostic.clickDispatched,
          actionOutcome: diagnostic.outcome,
          targetState: diagnostic.targetState,
          dispatchEvidence: diagnostic.dispatchEvidence ?? null,
          suggestedAction:
            diagnostic.actionDispatched === false && diagnostic.clickDispatched === false
              ? 'Take a fresh snapshot before another attempt; Stage5 Browser confirmed that no input was dispatched.'
              : 'Inspect authoritative state with a fresh snapshot. Do not retry or replay the opener because partial or ambiguous input may already have changed the page.',
        },
        cause,
      },
    );
  },

  async requireUniqueTarget(countPromise: Promise<number>, role: string, name: string): Promise<void> {
    const count = await countPromise;
    if (count === 0) {
      throw new Stage5BrowserError('TARGET_NOT_FOUND', 'No element matched the requested role and accessible name.', {
        details: { role, name },
      });
    }
    if (count > 1) {
      throw new Stage5BrowserError('AMBIGUOUS_TARGET', 'Multiple elements matched; Stage5 Browser will not choose one arbitrarily.', {
        details: { role, name, matchCount: count },
      });
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type InputDiagnosticsOperations = typeof inputDiagnosticsOperations;
