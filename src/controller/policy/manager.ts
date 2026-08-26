import { BROWSER_ACTION_INTENTS, BROWSER_COMMAND_POLICY, type BrowserActionIntent, type BrowserActionPolicyMode, type BrowserActionPolicyStatus, type BrowserCommandName, REVIEW_SAFE_DECLARED_INTENTS, Stage5BrowserError } from '../dependencies.js';

const ALL_INTENTS: BrowserActionIntent[] = [...BROWSER_ACTION_INTENTS];

export class BrowserActionPolicyManager {
  constructor(private mode: BrowserActionPolicyMode = 'normal') {}

  restore(mode: BrowserActionPolicyMode): void {
    this.mode = mode;
  }

  setMode(mode: BrowserActionPolicyMode): BrowserActionPolicyStatus {
    this.mode = mode;
    return this.status();
  }

  status(): BrowserActionPolicyStatus {
    const reviewSafeIntents = ALL_INTENTS.filter((intent) => REVIEW_SAFE_DECLARED_INTENTS.has(intent));
    return {
      mode: this.mode,
      enforcement: 'deterministic_action_class_with_agent_declared_intent',
      reviewSafeIntents,
      reviewBlockedIntents: ALL_INTENTS.filter((intent) => !REVIEW_SAFE_DECLARED_INTENTS.has(intent)),
    };
  }

  authorize(command: BrowserCommandName, payload: unknown): void {
    if (this.mode === 'normal') return;
    const policyClass = BROWSER_COMMAND_POLICY[command];
    if (policyClass === 'allowed_in_review' || policyClass === 'policy_configuration') return;
    if (policyClass === 'declared_intent_in_review') {
      if (
        command === 'motion' &&
        typeof payload === 'object' && payload !== null &&
        'motion' in payload &&
        typeof payload.motion === 'object' && payload.motion !== null &&
        'kind' in payload.motion &&
        (payload.motion.kind === 'focus' || payload.motion.kind === 'hover')
      ) {
        return;
      }
      const intent = typeof payload === 'object' && payload !== null && 'intent' in payload
        ? payload.intent
        : 'unclassified';
      if (typeof intent === 'string' && REVIEW_SAFE_DECLARED_INTENTS.has(intent as BrowserActionIntent)) return;
      throw this.blocked(command, typeof intent === 'string' ? intent : 'unclassified');
    }
    throw this.blocked(command, 'command_class');
  }

  private blocked(command: BrowserCommandName, reason: string): Stage5BrowserError {
    return new Stage5BrowserError('OPERATION_FAILED', 'The optional application review policy blocked this browser action before dispatch.', {
      recoverable: true,
      details: {
        reason: 'review_policy_blocked',
        command,
        policyMode: this.mode,
        declaredIntent: reason,
        actionDispatched: false,
        responsible: 'agent',
        suggestedAction: 'Keep review mode for inspection, form edits, navigation, and local validation. Change policy mode only when the user-authorized workflow should proceed to persistence, terms, submission, external communication, account change, or a financial transaction.',
      },
    });
  }
}
