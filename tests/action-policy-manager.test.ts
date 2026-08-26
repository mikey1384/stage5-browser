import { describe, expect, it } from 'vitest';

import { Stage5BrowserError } from '../src/errors.js';
import { BrowserActionPolicyManager } from '../src/controller/policy/manager.js';

describe('BrowserActionPolicyManager', () => {
  it('uses agent-declared meaning in review mode without label or regex inference', () => {
    const manager = new BrowserActionPolicyManager('review_only');

    expect(() => manager.authorize('clickByRole', { intent: 'form_edit' })).not.toThrow();
    expect(() => manager.authorize('clickByRole', { intent: 'local_validation' })).not.toThrow();
    expect(() => manager.authorize('motion', { motion: { kind: 'hover' } })).not.toThrow();
    expect(() => manager.authorize('motion', { motion: { kind: 'press' }, intent: 'local_validation' })).not.toThrow();
    expect(() => manager.authorize('fillByRole', { intent: 'form_edit' })).not.toThrow();
    expect(() => manager.authorize('selectOption', { intent: 'form_edit' })).not.toThrow();
    expect(() => manager.authorize('setChecked', { intent: 'accept_terms' })).toThrowError(Stage5BrowserError);
    expect(() => manager.authorize('applyFormPlan', { intent: 'unclassified' })).toThrowError(Stage5BrowserError);

    for (const intent of ['accept_terms', 'account_change', 'external_communication', 'financial_transaction', 'persist_form', 'submit', 'unclassified'] as const) {
      expect(() => manager.authorize('clickByRole', { intent })).toThrowError(Stage5BrowserError);
    }
    try {
      manager.authorize('clickByRole', { intent: 'submit', name: 'This label is intentionally ignored' });
    } catch (error) {
      expect(error).toMatchObject<Partial<Stage5BrowserError>>({
        code: 'OPERATION_FAILED',
        details: { reason: 'review_policy_blocked', declaredIntent: 'submit', actionDispatched: false },
      });
    }
  });

  it('blocks structurally consequential command classes and returns to normal explicitly', () => {
    const manager = new BrowserActionPolicyManager();
    expect(manager.setMode('review_only').mode).toBe('review_only');
    expect(() => manager.authorize('setInputFiles', {})).toThrowError(Stage5BrowserError);
    expect(() => manager.authorize('closeTab', {})).toThrowError(Stage5BrowserError);
    expect(() => manager.authorize('formSummary', {})).not.toThrow();
    expect(() => manager.authorize('applyFormPlan', { intent: 'form_edit' })).not.toThrow();
    expect(manager.setMode('normal').mode).toBe('normal');
    expect(() => manager.authorize('setInputFiles', {})).not.toThrow();
  });
});
