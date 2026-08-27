import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';

let initialized = false;
let browser = 'chromium';
let humanAuthenticationInProgress = false;
let browserRunning = false;
let actionPolicyMode = 'normal';
let hangingRequest = null;
const testDocumentId = `test-document-${process.pid}`;
const testFormValues = new Map();
const startedAt = new Date().toISOString();
const buildFingerprint = process.env.STAGE5_BROWSER_TEST_BUILD_FINGERPRINT ?? 'fake-worker';
const runtime = {
  component: 'worker',
  version: '0.6.5',
  protocolVersion: 0,
  hostBehaviorVersion: 1,
  processId: process.pid,
  startedAt,
  buildModifiedAt: startedAt,
  artifactFingerprint: buildFingerprint,
  currentArtifactFingerprint: buildFingerprint,
  currentVersion: '0.6.5',
  currentProtocolVersion: 0,
  currentHostBehaviorVersion: 1,
  currentToolCatalogVersion: 5,
  compatibleUpdateAvailable: false,
  restartRequired: false,
  restartReason: null,
  suggestedAction: null,
};
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
  stdio: 'ignore',
});

function respond(id, result) {
  if (process.connected) {
    process.send({ kind: 'response', id, ok: true, result });
  }
}

function respondError(id, error) {
  if (process.connected) {
    process.send({ kind: 'response', id, ok: false, error });
  }
}

process.on('message', (message) => {
  if (message?.kind !== 'request') {
    return;
  }

  if (message.command === 'initialize') {
    initialized = true;
    browser = message.payload.browser;
    actionPolicyMode = message.payload.actionPolicyMode;
    runtime.protocolVersion = message.payload.protocolVersion;
    runtime.currentProtocolVersion = message.payload.protocolVersion;
    respond(message.id, { ready: true, workerPid: process.pid, runtime });
    return;
  }

  if (!initialized) {
    return;
  }

  if (message.command === 'testHang') {
    hangingRequest = { id: message.id, action: 'test_hang', startedAtMs: Date.now() };
    return;
  }

  if (
    message.command === process.env.STAGE5_BROWSER_TEST_HANG_COMMAND
    || (message.command === 'status' && process.env.STAGE5_BROWSER_TEST_HANG_STATUS === '1')
  ) {
    hangingRequest = {
      id: message.id,
      action: message.command === 'selectOption'
        ? 'select_option'
        : message.command === 'clickByRole'
          ? 'click_by_role'
          : message.command,
      startedAtMs: Date.now(),
    };
    return;
  }

  if (process.env.STAGE5_BROWSER_TEST_FORM_STATE === '1' && message.command === 'fillByRole') {
    testFormValues.set(message.payload.name, message.payload.value);
    respond(message.id, {
      page: { url: 'https://fixture.invalid/form' },
      frame: { frameId: 'main' },
      input: { actionDispatched: true, valueMatches: true },
    });
    return;
  }

  if (process.env.STAGE5_BROWSER_TEST_FORM_STATE === '1' && message.command === 'snapshot') {
    respond(message.id, {
      page: { url: 'https://fixture.invalid/form' },
      frame: { frameId: 'main' },
      snapshotId: 'test-snapshot',
      refCount: 0,
      fileInputCount: 0,
      fileInputs: [],
      scrollContainerCount: 0,
      scrollContainers: [],
      scope: 'document',
      visibleModalCount: 0,
      warnings: [],
      snapshot: JSON.stringify({ documentId: testDocumentId, values: Object.fromEntries(testFormValues) }),
    });
    return;
  }

  if (message.command === 'requestLoginHandoff') {
    humanAuthenticationInProgress = true;
    browserRunning = false;
    respond(message.id, {
      browser,
      browserConnected: false,
      state: 'awaiting_user',
      controlMode: 'human_bootstrap',
      authenticated: 'unknown',
      userActionRequired: true,
    });
    return;
  }

  if (message.command === 'resumeAfterLogin') {
    const disconnectMarker = process.env.STAGE5_BROWSER_TEST_DISCONNECT_ON_RESUME_PATH;
    if (disconnectMarker !== undefined && existsSync(disconnectMarker)) {
      unlinkSync(disconnectMarker);
      respondError(message.id, {
        code: 'WORKER_DISCONNECTED',
        message: 'The test worker observed a compatible artifact replacement.',
        recoverable: true,
      });
      return;
    }
    humanAuthenticationInProgress = false;
    browserRunning = true;
    respond(message.id, {
      browser,
      browserConnected: true,
      state: 'ready_for_agent_verification',
      controlMode: 'playwright',
      authenticated: 'unknown',
      userActionRequired: false,
    });
    return;
  }

  if (message.command === 'authStatus') {
    respond(message.id, {
      browser,
      browserConnected: !humanAuthenticationInProgress,
      state: humanAuthenticationInProgress ? 'awaiting_user' : 'profile_ready',
      controlMode: humanAuthenticationInProgress ? 'human_bootstrap' : 'playwright',
      authenticated: 'unknown',
    });
    return;
  }

  if (message.command === 'switchBrowser') {
    browser = message.payload.browser;
    browserRunning = true;
    respond(message.id, {
      browser,
      state: 'running',
      workerPid: process.pid,
      browserConnected: true,
      pages: [],
      activePageIndex: null,
      lastKnownUrl: 'about:blank',
    });
    return;
  }

  if (message.command === 'start') {
    if (message.payload.browser !== undefined) browser = message.payload.browser;
    browserRunning = true;
    respond(message.id, {
      browser,
      state: 'running',
      workerPid: process.pid,
      browserConnected: true,
      pages: [],
      activePageIndex: null,
      lastKnownUrl: 'about:blank',
    });
    return;
  }

  if (message.command === 'status') {
    respond(message.id, {
      browser,
      state: browserRunning ? 'running' : 'stopped',
      workerPid: process.pid,
      browserConnected: browserRunning,
      pages: [],
      activePageIndex: null,
      lastKnownUrl: null,
      descendantPid: descendant.pid,
    });
    return;
  }

  if (message.command === 'setPolicy') {
    actionPolicyMode = message.payload.mode;
    respond(message.id, {
      mode: actionPolicyMode,
      source: 'agent_declared_intent',
      deterministicEnforcement: 'structural_and_scope_only',
    });
    return;
  }

  if (message.command === 'policyStatus') {
    respond(message.id, {
      mode: actionPolicyMode,
      source: 'agent_declared_intent',
      deterministicEnforcement: 'structural_and_scope_only',
    });
    return;
  }

  if (message.command === 'diagnostics') {
    const status = {
      browser,
      state: 'stopped',
      workerPid: process.pid,
      browserConnected: false,
      pages: [],
      activePageIndex: null,
      lastKnownUrl: null,
    };
    respond(message.id, {
      browser: {
        browser,
        engine: browser === 'firefox' ? 'firefox' : browser === 'webkit' ? 'webkit' : 'chromium',
        availability: { browser, engine: 'chromium', available: true, source: 'bundled', reason: null },
        preflightSuggestedAction: null,
        profile: { path: '/tmp/fake', exists: false, writable: true, lockFiles: [], lockState: 'none' },
        lastLaunchFailure: null,
      },
      status,
      worker: runtime,
    });
    return;
  }

  if (message.command === 'stop') {
    browserRunning = false;
    respond(message.id, {
      browser,
      state: 'stopped',
      workerPid: process.pid,
      browserConnected: false,
      pages: [],
      activePageIndex: null,
      lastKnownUrl: null,
    });
  }
});

process.on('SIGTERM', () => {
  const delay = Number.parseInt(process.env.STAGE5_BROWSER_TEST_SHUTDOWN_DELAY_MS ?? '0', 10);
  if (hangingRequest !== null && process.connected) {
    const { id, action, startedAtMs } = hangingRequest;
    process.send({
      kind: 'response',
      id,
      ok: false,
      error: {
        code: 'WORKER_DISCONNECTED',
        message: 'The fake worker was stopped during an in-flight action.',
        recoverable: true,
      },
      telemetry: {
        actionPhases: [{
          action,
          startedAtMs,
          deadlineAtMs: startedAtMs + 60_000,
          transitions: [
            { phase: 'observe', enteredAtMs: startedAtMs, attempt: 1 },
            { phase: 'plan', enteredAtMs: startedAtMs + 1, attempt: 1 },
            { phase: 'preflight', enteredAtMs: startedAtMs + 2, attempt: 1 },
            { phase: 'prepare', enteredAtMs: startedAtMs + 3, attempt: 1 },
            { phase: 'dispatch', enteredAtMs: startedAtMs + 4, attempt: 1 },
          ],
          dispatchState: 'possibly_dispatched',
          dispatchAttempts: 1,
          recovery: null,
          viewportPreparation: null,
          terminalOutcome: null,
          completedAtMs: null,
        }],
      },
    });
  }
  setTimeout(
    () => process.exit(0),
    (Number.isFinite(delay) ? Math.max(0, delay) : 0) + (hangingRequest === null ? 0 : 20),
  );
});
process.on('disconnect', () => process.exit(0));
