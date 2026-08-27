import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { errorResult, textResult } from '../src/mcp/context.js';
import { MAX_MCP_RESULT_BYTES } from '../src/mcp/result-shaping.js';
import { SupervisedOperationError } from '../src/supervisor/model.js';

describe('bounded MCP result shaping', () => {
  it('puts a concise action outcome and current state before implementation evidence', () => {
    const result = textResult({
      result: {
        page: { index: 0 },
        evidence: { popupClosed: false, selectionEffectObserved: true },
        nextAction: 'select_more_or_dismiss_popup',
        currentState: { requestedSelected: true, popupOpen: true, multiple: true },
        actionDispatched: true,
        selectionSucceeded: true,
        outcome: 'succeeded',
      },
    });
    const text = result.content[0]?.text ?? '';
    expect(text.indexOf('"outcome"')).toBeLessThan(text.indexOf('"evidence"'));
    expect(text.indexOf('"selectionSucceeded"')).toBeLessThan(text.indexOf('"evidence"'));
    expect(text.indexOf('"currentState"')).toBeLessThan(text.indexOf('"evidence"'));
    expect(text.indexOf('"nextAction"')).toBeLessThan(text.indexOf('"evidence"'));
  });

  it('keeps action conclusions first and preserves both ends of oversized observations', () => {
    const title = `title-head-${'x'.repeat(50_000)}-title-tail`;
    const result = textResult({
      operationId: 'operation-bounded-success',
      result: {
        page: { index: 0, url: 'https://example.test/form', title, readyState: 'complete' },
        frame: { id: 'frame-1', parentId: null, name: '', url: 'https://example.test/form', isMainFrame: true },
        postcondition: { passed: true, checks: [{ kind: 'visible', passed: true, expected: true, observed: true }] },
        dispatch: { actionDispatched: true, clickDispatched: true },
        options: Array.from({ length: 200 }, (_, index) => ({ name: `Choice ${index}`, selected: false })),
      },
      recovery: 'not_needed',
      runtimeTransition: null,
    });

    const text = result.content[0]?.text ?? '';
    const structured = result.structuredContent as {
      delivery?: { truncated?: boolean; absenceInferenceAllowed?: boolean };
      result?: { dispatch?: unknown; postcondition?: unknown; page?: { title?: string } };
    };
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_MCP_RESULT_BYTES);
    expect(structured.delivery).toMatchObject({ truncated: true, absenceInferenceAllowed: false });
    expect(structured.result?.dispatch).toEqual({ actionDispatched: true, clickDispatched: true });
    expect(structured.result?.postcondition).toMatchObject({ passed: true });
    expect(structured.result?.page?.title).toContain('title-head-');
    expect(structured.result?.page?.title).toContain('-title-tail');
    expect(structured.result?.page?.title).toContain('absence cannot be inferred');
    expect(text.indexOf('"dispatch"')).toBeLessThan(text.indexOf('"page"'));
  });

  it('keeps operation identity and no-replay evidence in an oversized error envelope', () => {
    const result = errorResult(new SupervisedOperationError({
      code: 'POSTCONDITION_FAILED',
      message: 'The click was dispatched but its requested effect was not proven.',
      recoverable: true,
      details: {
        reason: 'click_postcondition_not_met',
        actionDispatched: true,
        clickDispatched: true,
        actionOutcome: 'click_dispatched_postcondition_failed',
        checks: [{ kind: 'selected', passed: false, expected: true, observed: null }],
        diagnostic: `diagnostic-head-${'y'.repeat(60_000)}-diagnostic-tail`,
        suggestedAction: 'Inspect authoritative state and do not replay the action.',
      },
    }, 'operation-bounded-error', 'not_needed'));

    const text = result.content[0]?.text ?? '';
    const structured = result.structuredContent as {
      operationId?: string;
      delivery?: { truncated?: boolean };
      error?: { details?: Record<string, unknown> };
    };
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_MCP_RESULT_BYTES);
    expect(structured.operationId).toBe('operation-bounded-error');
    expect(structured.delivery?.truncated).toBe(true);
    expect(structured.error?.details).toMatchObject({
      reason: 'click_postcondition_not_met',
      actionDispatched: true,
      clickDispatched: true,
      actionOutcome: 'click_dispatched_postcondition_failed',
    });
    expect(text.indexOf('"operationId"')).toBeLessThan(text.indexOf('"error"'));
    expect(text.indexOf('"actionDispatched"')).toBeLessThan(text.indexOf('"diagnostic"'));
  });
});
