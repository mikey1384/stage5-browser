import { spawn } from 'node:child_process';

let initialized = false;
let browser = 'chromium';
let humanAuthenticationInProgress = false;
const startedAt = new Date().toISOString();
const buildFingerprint = process.env.STAGE5_BROWSER_TEST_BUILD_FINGERPRINT ?? 'fake-worker';
const runtime = {
  component: 'worker',
  version: '0.4.2',
  protocolVersion: 3,
  processId: process.pid,
  startedAt,
  buildModifiedAt: startedAt,
  artifactFingerprint: buildFingerprint,
  currentArtifactFingerprint: buildFingerprint,
  currentVersion: '0.4.2',
  currentProtocolVersion: 3,
  currentToolCatalogVersion: 3,
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

process.on('message', (message) => {
  if (message?.kind !== 'request') {
    return;
  }

  if (message.command === 'initialize') {
    initialized = true;
    browser = message.payload.browser;
    respond(message.id, { ready: true, workerPid: process.pid, runtime });
    return;
  }

  if (!initialized) {
    return;
  }

  if (message.command === 'testHang') {
    return;
  }

  if (message.command === 'requestLoginHandoff') {
    humanAuthenticationInProgress = true;
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
    humanAuthenticationInProgress = false;
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
      state: 'stopped',
      workerPid: process.pid,
      browserConnected: false,
      pages: [],
      activePageIndex: null,
      lastKnownUrl: null,
      descendantPid: descendant.pid,
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
  setTimeout(() => process.exit(0), Number.isFinite(delay) ? Math.max(0, delay) : 0);
});
process.on('disconnect', () => process.exit(0));
