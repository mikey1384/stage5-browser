import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildExecutionTrace, ExecutionTelemetryJournal } from '../src/execution-telemetry.js';

describe('privacy-safe execution telemetry', () => {
  let temporaryRoot: string | null = null;

  afterEach(async () => {
    if (temporaryRoot !== null) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('persists manager phases and boolean outcomes without browser content or target semantics', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-telemetry-'));
    const startedAtMs = Date.now() - 100;
    const trace = buildExecutionTrace({
      operationId: 'operation-telemetry-fixture',
      agentId: 'youtube-agent',
      command: 'selectOption',
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(startedAtMs + 100).toISOString(),
      durationMs: 100,
      outcome: 'succeeded',
      error: null,
      result: {
        page: { url: 'https://private.example/secret?token=never-store', title: 'Private account title' },
        selectedName: 'Private choice name',
        suppliedValue: 'Never persist this form value',
        dispatch: { actionDispatched: true, clickDispatched: true },
        postcondition: {
          passed: true,
          checks: [{ kind: 'url', passed: true, expected: 'private URL', observed: 'private URL' }],
        },
        evidence: {
          selectionEffectObserved: true,
          selectedRepresentationObserved: true,
          popupClosed: false,
        },
      },
      workerRuntime: null,
      workerTelemetry: {
        actionPhases: [{
          action: 'select_option',
          startedAtMs,
          deadlineAtMs: startedAtMs + 5_000,
          transitions: [
            { phase: 'observe', enteredAtMs: startedAtMs, attempt: 1 },
            { phase: 'plan', enteredAtMs: startedAtMs + 10, attempt: 1 },
            { phase: 'preflight', enteredAtMs: startedAtMs + 20, attempt: 1 },
            { phase: 'prepare', enteredAtMs: startedAtMs + 30, attempt: 1 },
            { phase: 'dispatch', enteredAtMs: startedAtMs + 40, attempt: 1 },
            { phase: 'reconcile', enteredAtMs: startedAtMs + 50, attempt: 1 },
            { phase: 'finalize', enteredAtMs: startedAtMs + 90, attempt: 1 },
          ],
          dispatchState: 'dispatched',
          dispatchAttempts: 1,
          recovery: {
            reason: 'target_changed_before_input',
            authorizedAtMs: startedAtMs + 15,
            completedDispatchAttempts: 0,
          },
          viewportPreparation: {
            attempts: 2,
            movements: 2,
            horizontalMovement: true,
            verticalMovement: false,
            nestedSurfaceMovement: true,
            documentMovement: false,
            composedBoundaryTraversed: true,
            completedInViewport: true,
            reachStrategy: 'pointer_viewport',
          },
          terminalOutcome: 'succeeded',
          completedAtMs: startedAtMs + 100,
        }],
      },
    });
    const journal = new ExecutionTelemetryJournal(temporaryRoot);
    await journal.append(trace);

    const listed = await journal.list('operation-telemetry-fixture', 10);
    expect(listed.traces[0]).toMatchObject({
      manager: 'form_manager',
      agentId: 'youtube-agent',
      phaseSystem: 'action_phases',
      dispatchBoundary: 'element_input',
      replayPolicy: 'never_after_possible_dispatch',
      actions: [{
        action: 'select_option',
        dispatchState: 'dispatched',
        dispatchAttempts: 1,
        recoveryReason: 'target_changed_before_input',
        viewportPreparation: {
          attempts: 2,
          movements: 2,
          horizontalMovement: true,
          verticalMovement: false,
          nestedSurfaceMovement: true,
          documentMovement: false,
          composedBoundaryTraversed: true,
          completedInViewport: true,
          reachStrategy: 'pointer_viewport',
        },
      }],
      conclusion: {
        actionDispatched: true,
        clickDispatched: true,
        postconditionPassed: true,
        checks: [{ kind: 'url', passed: true, observed: 'redacted_string' }],
        selectionEffectObserved: true,
        selectedRepresentationObserved: true,
        popupClosed: false,
      },
      privacy: { urls: 'omitted', selectors: 'omitted', names: 'omitted', values: 'omitted', pageContent: 'omitted' },
    });
    expect(listed.traces[0]?.actions[0]?.phases.map(({ phase }) => phase)).toEqual([
      'observe', 'plan', 'preflight', 'prepare', 'dispatch', 'reconcile', 'finalize',
    ]);
    const persisted = await readFile(path.join(temporaryRoot, 'execution-telemetry.jsonl'), 'utf8');
    expect(persisted).not.toContain('private.example');
    expect(persisted).not.toContain('Private account title');
    expect(persisted).not.toContain('Private choice name');
    expect(persisted).not.toContain('Never persist this form value');
    expect(persisted).not.toContain('never-store');
  });

  it('retains canonical reconciliation checks after partial input fails closed', () => {
    const trace = buildExecutionTrace({
      operationId: 'operation-partial-selection-fixture',
      agentId: 'finance-agent',
      command: 'selectOptions',
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(25).toISOString(),
      durationMs: 25,
      outcome: 'failed',
      error: {
        code: 'OPERATION_FAILED',
        message: 'Selection stopped after possible partial input.',
        recoverable: true,
        details: {
          reason: 'detached',
          actionDispatched: true,
          clickDispatched: false,
          checks: [
            { kind: 'selection_representation', passed: false, expected: true, observed: false },
            { kind: 'selected', passed: false, expected: true, observed: null },
            { kind: 'popup_closed', passed: true, expected: true, observed: true },
          ],
        },
      },
      result: null,
      workerRuntime: { version: 'fixture', protocolVersion: 12 },
      workerTelemetry: null,
    });

    expect(trace.conclusion).toEqual({
      actionDispatched: true,
      clickDispatched: false,
      postconditionPassed: null,
      checks: [
        { kind: 'selection_representation', passed: false, observed: false },
        { kind: 'selected', passed: false, observed: null },
        { kind: 'popup_closed', passed: true, observed: true },
      ],
      selectionEffectObserved: null,
      selectedRepresentationObserved: null,
      popupClosed: null,
      popupAssociationProof: null,
      popupSurfaceProof: null,
      renderedPopupCount: null,
      popupOwnership: null,
      targetState: null,
    });
  });

  it('records categorical popup-owner ambiguity without control or option semantics', () => {
    const trace = buildExecutionTrace({
      operationId: 'operation-popup-position-fixture',
      agentId: 'finance-agent',
      command: 'inspectControl',
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(10).toISOString(),
      durationMs: 10,
      outcome: 'failed',
      error: {
        code: 'AMBIGUOUS_TARGET',
        message: 'Fixture popup ownership remained ambiguous.',
        recoverable: true,
        details: {
          reason: 'ambiguous_control_popup',
          actionDispatched: false,
          renderedPopupCount: 1,
          popupOwnership: {
            proofTier: 'spatial',
            candidateCount: 2,
            exteriorCandidateCount: 2,
            overlappingCandidateCount: 0,
            surfaceCoveredCandidateCount: 0,
            decision: 'tie_or_near',
          },
        },
      },
      result: null,
      workerRuntime: { version: 'fixture', protocolVersion: 12 },
      workerTelemetry: null,
    });

    expect(trace.conclusion).toMatchObject({
      actionDispatched: false,
      popupAssociationProof: null,
      popupSurfaceProof: null,
      renderedPopupCount: 1,
      popupOwnership: {
        proofTier: 'spatial',
        candidateCount: 2,
        exteriorCandidateCount: 2,
        overlappingCandidateCount: 0,
        surfaceCoveredCandidateCount: 0,
        decision: 'tie_or_near',
      },
    });
    expect(JSON.stringify(trace)).not.toContain('controlName');
    expect(JSON.stringify(trace)).not.toContain('optionName');
  });

  it('records categorical exact-target viewport evidence without geometry or semantics', () => {
    const trace = buildExecutionTrace({
      operationId: 'operation-viewport-proof-fixture',
      agentId: 'youtube-agent',
      command: 'clickByRole',
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(10).toISOString(),
      durationMs: 10,
      outcome: 'failed',
      error: {
        code: 'OPERATION_FAILED',
        message: 'Fixture failure.',
        recoverable: true,
        details: {
          reason: 'not_visible',
          targetState: {
            visible: true,
            enabled: true,
            inViewport: true,
            viewportEvidence: 'exact_hit_test_override',
            receivesPointerEvents: true,
            pointerHitPoint: 'alternate',
            tagName: 'a',
            role: 'link',
          },
        },
      },
      result: null,
      workerRuntime: { version: 'fixture', protocolVersion: 12 },
      workerTelemetry: null,
    });

    expect(trace.conclusion.targetState).toEqual({
      visible: true,
      enabled: true,
      inViewport: true,
      viewportEvidence: 'exact_hit_test_override',
      receivesPointerEvents: true,
      pointerHitPoint: 'alternate',
    });
    expect(JSON.stringify(trace)).not.toContain('tagName');
    expect(JSON.stringify(trace)).not.toContain('link');
  });
});
