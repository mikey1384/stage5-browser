import { describe, expect, it } from 'vitest';

import { buildExecutionTrace } from '../src/execution-telemetry.js';

describe('native reattach execution telemetry', () => {
  it('retains only bounded categorical target-discovery evidence', () => {
    const trace = buildExecutionTrace({
      operationId: 'operation-native-reattach-fixture',
      agentId: 'twinkle-developer',
      command: 'start',
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(750).toISOString(),
      durationMs: 750,
      outcome: 'failed',
      error: {
        code: 'BROWSER_NOT_READY',
        message: 'The exact selected native browser page is no longer available.',
        recoverable: true,
        details: {
          reason: 'selected_page_unavailable_after_reattach',
          actionDispatched: false,
          nativeReattach: {
            selectedTargetRecorded: true,
            initialPageCount: 6,
            finalPageCount: 6,
            selectedTargetInitiallyObserved: false,
            selectedTargetObserved: false,
            discoveryWaitAttempted: true,
            discoveryWaitMs: 750,
            resolution: 'unresolved',
            privateUrl: 'https://private.invalid/never-retain',
            selectedTargetId: 'never-retain-target-id',
            title: 'Never retain private page title',
          },
        },
      },
      result: null,
      workerRuntime: null,
      workerTelemetry: null,
    });

    expect(trace.conclusion.nativeReattach).toEqual({
      selectedTargetRecorded: true,
      initialPageCount: 6,
      finalPageCount: 6,
      selectedTargetInitiallyObserved: false,
      selectedTargetObserved: false,
      discoveryWaitAttempted: true,
      discoveryWaitMs: 750,
      resolution: 'unresolved',
    });
    expect(trace.conclusion.actionDispatched).toBe(false);
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain('private.invalid');
    expect(serialized).not.toContain('never-retain-target-id');
    expect(serialized).not.toContain('Never retain private page title');
  });
});
