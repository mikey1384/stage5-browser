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
        page: {
          url: 'https://private.example/secret?token=never-store',
          title: 'Private account title',
        },
        selectedName: 'Private choice name',
        selected: false,
        interactionUsed: 'searchable_keyboard',
        suppliedValue: 'Never persist this form value',
        dispatch: { actionDispatched: true, clickDispatched: true },
        postcondition: {
          passed: true,
          checks: [
            {
              kind: 'url',
              passed: true,
              expected: 'private URL',
              observed: 'private URL',
            },
          ],
        },
        evidence: {
          selectionEffectObserved: true,
          selectedRepresentationObserved: false,
          selectedState: false,
          popupClosed: false,
          reconciliation: {
            targetResolution: 'rebound_exact',
            attempts: 2,
            durationMs: 117,
            terminalProof: 'selected_state',
            privateOptionName: 'Never persist this reconciliation value',
          },
          searchableCommit: {
            queryActionDispatched: true,
            activeOptionProof: 'aria_activedescendant',
            commitActionDispatched: true,
            selectionProof: 'selected_state',
          },
        },
      },
      workerRuntime: null,
      workerTelemetry: {
        actionPhases: [
          {
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
              pointerContactRecovery: false,
              completedInViewport: true,
              reachStrategy: 'pointer_viewport',
            },
            terminalOutcome: 'succeeded',
            completedAtMs: startedAtMs + 100,
          },
        ],
      },
    });
    const journal = new ExecutionTelemetryJournal(temporaryRoot);
    await journal.append(trace);

    const listed = await journal.list('operation-telemetry-fixture', 10);
    expect(listed.traces[0]).toMatchObject({
      schemaVersion: 2,
      host: {
        version: expect.any(String),
        behaviorVersion: expect.any(Number),
        toolCatalogVersion: expect.any(Number),
        toolCount: expect.any(Number),
      },
      manager: 'form_manager',
      agentId: 'youtube-agent',
      phaseSystem: 'action_phases',
      dispatchBoundary: 'element_input',
      replayPolicy: 'never_after_possible_dispatch',
      actions: [
        {
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
            pointerContactRecovery: false,
            completedInViewport: true,
            reachStrategy: 'pointer_viewport',
          },
        },
      ],
      conclusion: {
        actionDispatched: true,
        clickDispatched: true,
        postconditionPassed: true,
        checks: [{ kind: 'url', passed: true, observed: 'redacted_string' }],
        selectionDesiredState: false,
        selectionObservedState: false,
        selectionEffectObserved: true,
        selectedRepresentationObserved: false,
        popupClosed: false,
        selectionReconciliation: {
          targetResolution: 'rebound_exact',
          attempts: 2,
          durationMs: 117,
          terminalProof: 'selected_state',
        },
        selectionInteraction: 'searchable_keyboard',
        searchableSelection: {
          activeOptionProof: 'aria_activedescendant',
          queryActionDispatched: true,
          commitActionDispatched: true,
          selectionProof: 'selected_state',
        },
      },
      privacy: {
        urls: 'omitted',
        selectors: 'omitted',
        names: 'omitted',
        values: 'omitted',
        pageContent: 'omitted',
      },
    });
    expect(listed.traces[0]?.actions[0]?.phases.map(({ phase }) => phase)).toEqual([
      'observe',
      'plan',
      'preflight',
      'prepare',
      'dispatch',
      'reconcile',
      'finalize',
    ]);
    const persisted = await readFile(path.join(temporaryRoot, 'execution-telemetry.jsonl'), 'utf8');
    expect(persisted).not.toContain('private.example');
    expect(persisted).not.toContain('Private account title');
    expect(persisted).not.toContain('Private choice name');
    expect(persisted).not.toContain('Never persist this form value');
    expect(persisted).not.toContain('never-store');
    expect(persisted).not.toContain('Never persist this reconciliation value');

    const summary = await journal.list(null, 10, {
      agentId: 'youtube-agent',
      command: 'selectOption',
      outcome: 'succeeded',
      detail: 'summary',
    });
    expect(summary).toMatchObject({
      agentId: 'youtube-agent',
      command: 'selectOption',
      outcome: 'succeeded',
      detail: 'summary',
      traces: [{
        operationId: 'operation-telemetry-fixture',
        actions: [{ phaseMs: { dispatch: 10, reconcile: 40 } }],
        conclusion: {
          selectionReconciliation: {
            targetResolution: 'rebound_exact',
            terminalProof: 'selected_state',
          },
        },
      }],
    });
    expect(summary.traces[0]).not.toHaveProperty('host');
    expect(summary.traces[0]?.actions[0]).not.toHaveProperty('phases');
  });

  it('records framework field rebinding categorically without field labels or values', () => {
    const trace = buildExecutionTrace({
      operationId: 'operation-form-rebind-fixture',
      agentId: 'finance-agent',
      command: 'applyFormPlan',
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(40).toISOString(),
      durationMs: 40,
      outcome: 'succeeded',
      error: null,
      result: {
        fieldRebinding: { attempted: true, reboundSteps: 1, failed: false },
        completedSteps: [{
          fieldId: 'field-opaque',
          privateLabel: 'Private ZIP label',
          suppliedValue: 'Never retain this ZIP value',
          fieldResolution: {
            resolution: 'rebound_exact',
            basis: 'stable_role_name_kind',
            rebindAttempts: 1,
          },
          actionDispatched: true,
        }],
      },
      workerRuntime: null,
      workerTelemetry: null,
    });

    expect(trace.conclusion.formFieldRebinding)
      .toEqual({ attempted: true, reboundSteps: 1, failed: false });
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain('Private ZIP label');
    expect(serialized).not.toContain('Never retain this ZIP value');
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
            {
              kind: 'selection_representation',
              passed: false,
              expected: true,
              observed: false,
            },
            { kind: 'selected', passed: false, expected: true, observed: null },
            {
              kind: 'popup_closed',
              passed: true,
              expected: true,
              observed: true,
            },
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
      activationTransport: null,
      postconditionPassed: null,
      checks: [
        { kind: 'selection_representation', passed: false, observed: false },
        { kind: 'selected', passed: false, observed: null },
        { kind: 'popup_closed', passed: true, observed: true },
      ],
      selectionDesiredState: null,
      selectionObservedState: null,
      selectionEffectObserved: null,
      selectedRepresentationObserved: null,
      popupClosed: null,
      popupAssociationProof: null,
      popupSurfaceProof: null,
      renderedPopupCount: null,
      popupOwnership: null,
      controlRecovery: null,
      controlRevealInteraction: null,
      selectionReconciliation: null,
      selectionInteraction: null,
      searchableSelection: null,
      formFieldRebinding: null,
      profileOwnership: null,
      handoffRelease: null,
      nativeReattach: null,
      targetState: null,
    });
  });

  it('retains categorical profile-lock ownership without process or application identity', () => {
    const trace = buildExecutionTrace({
      operationId: 'operation-profile-lock-fixture',
      agentId: 'twinkle-developer',
      command: 'start',
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(4).toISOString(),
      durationMs: 4,
      outcome: 'failed',
      error: {
        code: 'BROWSER_NOT_READY',
        message: 'Fixture profile remains locked.',
        recoverable: true,
        details: {
          reason: 'profile_locked',
          profileOwner: {
            classification: 'abandoned',
            ownershipProven: false,
            expectedApplication: 'Private application name',
            ownerWorkerRunning: false,
            heartbeat: 'stale',
            browserProcess: 'unavailable',
            controlMode: 'playwright',
            phase: 'owned_active',
            processId: 42424,
            profilePath: '/private/profile/path',
          },
        },
      },
      result: null,
      workerRuntime: null,
      workerTelemetry: null,
    });

    expect(trace.conclusion.profileOwnership).toEqual({
      classification: 'abandoned',
      ownership: 'not_proven',
      lockOwnerProcess: null,
      applicationIdentity: null,
      loopbackControl: null,
      recovery: null,
      ownerWorkerRunning: false,
      heartbeat: 'stale',
      browserProcess: 'unavailable',
      controlMode: 'playwright',
      phase: 'owned_active',
    });
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain('Private application name');
    expect(serialized).not.toContain('/private/profile/path');
    expect(serialized).not.toContain('42424');
  });

  it('retains only categorical private-handoff release proprioception', () => {
    const trace = buildExecutionTrace({
      operationId: 'operation-handoff-release-fixture',
      agentId: 'finance-agent',
      command: 'requestLoginHandoff',
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(25).toISOString(),
      durationMs: 25,
      outcome: 'succeeded',
      error: null,
      result: {
        state: 'awaiting_user',
        handoffRelease: {
          strategy: 'native_same_process',
          phase: 'human_input',
          closeRequestCompleted: true,
          processReused: true,
          ownershipRetained: true,
          privateUrl: 'https://private.example/never-retain',
          fieldValue: 'never retain this value',
        },
      },
      workerRuntime: null,
      workerTelemetry: null,
    });

    expect(trace.conclusion.handoffRelease).toEqual({
      strategy: 'native_same_process',
      phase: 'human_input',
      closeRequestCompleted: true,
      processReused: true,
      ownershipRetained: true,
    });
    expect(JSON.stringify(trace)).not.toContain('private.example');
    expect(JSON.stringify(trace)).not.toContain('never retain this value');

    const pending = buildExecutionTrace({
      operationId: 'operation-handoff-release-pending-fixture',
      agentId: 'finance-agent',
      command: 'requestLoginHandoff',
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(30_000).toISOString(),
      durationMs: 30_000,
      outcome: 'failed',
      error: {
        code: 'AUTH_HANDOFF_REQUIRED',
        message: 'Fixture release remains pending.',
        recoverable: true,
        details: {
          reason: 'handoff_release_pending',
          releaseStrategy: 'process_relaunch',
          phase: 'close_requested',
          closeRequestCompleted: true,
          ownershipRetained: true,
          profileLockFiles: ['never-retain-lock-name'],
        },
      },
      result: null,
      workerRuntime: null,
      workerTelemetry: null,
    });
    expect(pending.conclusion.handoffRelease).toEqual({
      strategy: 'process_relaunch',
      phase: 'close_requested',
      closeRequestCompleted: true,
      processReused: null,
      ownershipRetained: true,
    });
    expect(JSON.stringify(pending)).not.toContain('never-retain-lock-name');
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
            candidateCount: 5,
            exteriorCandidateCount: 2,
            overlappingCandidateCount: 3,
            surfaceCoveredCandidateCount: 2,
            decision: 'covered_siblings_excluded',
          },
          ownerCandidates: [
            {
              role: 'button',
              name: 'Private correct field',
              ownerCandidateId: 'private-capability-a',
            },
            {
              role: 'button',
              name: 'Private competing field',
              ownerCandidateId: 'private-capability-b',
            },
            { role: 'button', name: 'Private unavailable field' },
            {
              role: 'button',
              name: 'Private fourth field',
              ownerCandidateId: 'private-capability-c',
            },
            {
              role: 'button',
              name: 'Private fifth field',
              ownerCandidateId: 'private-capability-d',
            },
          ],
          controlRecovery: {
            requestedControlResolution: 'missing',
            popupOwnerDecision: 'required',
            activeCandidateCount: 5,
            exposedCandidateCount: 5,
            issuedCapabilityCount: 4,
            candidatesTruncated: false,
            requestedControlIsCandidate: false,
            agentJudgmentAvailable: true,
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
        candidateCount: 5,
        exteriorCandidateCount: 2,
        overlappingCandidateCount: 3,
        surfaceCoveredCandidateCount: 2,
        decision: 'covered_siblings_excluded',
      },
      controlRecovery: {
        requestedControlResolution: 'missing',
        popupOwnerDecision: 'required',
        activeCandidateCount: 5,
        exposedCandidateCount: 5,
        issuedCapabilityCount: 4,
        candidatesTruncated: false,
        requestedControlIsCandidate: false,
        agentJudgmentAvailable: true,
      },
    });
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain('Private correct field');
    expect(serialized).not.toContain('Private competing field');
    expect(serialized).not.toContain('private-capability');
  });

  it('records an agent judgment gate categorically while omitting candidate semantics', () => {
    const trace = buildExecutionTrace({
      operationId: 'operation-popup-agent-judgment',
      agentId: 'finance-agent',
      command: 'inspectControl',
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(10).toISOString(),
      durationMs: 10,
      outcome: 'succeeded',
      error: null,
      result: {
        inspection: {
          reveal: {
            revealInteraction: 'keyboard',
            associationProof: 'agent_declared',
            renderedPopupCount: 1,
            popupOwnership: {
              proofTier: 'spatial',
              candidateCount: 5,
              exteriorCandidateCount: 2,
              overlappingCandidateCount: 3,
              surfaceCoveredCandidateCount: 2,
              decision: 'tie_or_near',
            },
            controlRecovery: {
              requestedControlResolution: 'recovered_observed_owner',
              popupOwnerDecision: 'consumed',
              activeCandidateCount: 5,
              exposedCandidateCount: null,
              issuedCapabilityCount: null,
              candidatesTruncated: null,
              requestedControlIsCandidate: false,
              agentJudgmentAvailable: true,
            },
          },
          ownerCandidates: [{ name: 'Private candidate text', role: 'button' }],
        },
      },
      workerRuntime: { version: 'fixture', protocolVersion: 14 },
      workerTelemetry: null,
    });

    expect(trace.conclusion).toMatchObject({
      controlRevealInteraction: 'keyboard',
      popupAssociationProof: 'agent_declared',
      renderedPopupCount: 1,
      popupOwnership: { candidateCount: 5, decision: 'tie_or_near' },
      controlRecovery: {
        requestedControlResolution: 'recovered_observed_owner',
        popupOwnerDecision: 'consumed',
        activeCandidateCount: 5,
        exposedCandidateCount: null,
        issuedCapabilityCount: null,
        candidatesTruncated: null,
        requestedControlIsCandidate: false,
        agentJudgmentAvailable: true,
      },
    });
    expect(JSON.stringify(trace)).not.toContain('Private candidate text');
    expect(trace.privacy).toMatchObject({
      names: 'omitted',
      pageContent: 'omitted',
    });
  });

  it('retains the chosen control-reveal technique on a privacy-safe failure trace', () => {
    const trace = buildExecutionTrace({
      operationId: 'operation-keyboard-reveal-failure',
      agentId: 'finance-agent',
      command: 'inspectControl',
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(10).toISOString(),
      durationMs: 10,
      outcome: 'failed',
      error: {
        code: 'POSTCONDITION_FAILED',
        message: 'Fixture failure.',
        recoverable: true,
        details: {
          reason: 'control_popup_not_observed',
          actionDispatched: true,
          clickDispatched: false,
          dispatchEvidence: {
            keyDownOnTarget: true,
            keyUpOnTarget: true,
            pointerDownOnTarget: false,
          },
          revealInteraction: 'keyboard',
          popupOwnership: {
            proofTier: 'none',
            candidateCount: null,
            exteriorCandidateCount: null,
            overlappingCandidateCount: null,
            surfaceCoveredCandidateCount: null,
            decision: 'unbounded',
            targetFirstMiss: 'not_spatial',
          },
          privateLabel: 'Never retain this field label',
        },
      },
      result: null,
      workerRuntime: { version: 'fixture', protocolVersion: 18 },
      workerTelemetry: null,
    });

    expect(trace.conclusion).toMatchObject({
      actionDispatched: true,
      clickDispatched: false,
      activationTransport: 'keyboard',
      controlRevealInteraction: 'keyboard',
      popupOwnership: { decision: 'unbounded', targetFirstMiss: 'not_spatial' },
    });
    expect(JSON.stringify(trace)).not.toContain('Never retain this field label');
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
