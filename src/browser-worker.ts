import { BrowserController } from './browser-controller.js';
import { Stage5BrowserError, serializeUnknownError } from './errors.js';
import type {
  BrowserWorkerRequest,
  BrowserWorkerResponse,
} from './protocol.js';
import {
  buildStampUrlFor,
  RuntimeArtifactMonitor,
  STAGE5_BROWSER_VERSION,
  WORKER_PROTOCOL_VERSION,
} from './runtime-info.js';

let controller: BrowserController | undefined;
let commandTail: Promise<void> = Promise.resolve();
let shuttingDown = false;
const runtimeMonitor = new RuntimeArtifactMonitor('worker', buildStampUrlFor(import.meta.url));

function send(message: BrowserWorkerResponse): void {
  if (process.connected) {
    process.send?.(message);
  }
}

async function dispatch(request: BrowserWorkerRequest): Promise<unknown> {
  if (request.command === 'initialize') {
    runtimeMonitor.assertCurrent();
    const workerRuntime = runtimeMonitor.inspect();
    if (
      request.payload.protocolVersion !== WORKER_PROTOCOL_VERSION ||
      (request.payload.mcpBuildFingerprint !== null &&
        request.payload.mcpBuildFingerprint !== workerRuntime.artifactFingerprint)
    ) {
      throw new Stage5BrowserError(
        'MCP_RESTART_REQUIRED',
        'The MCP server and browser worker loaded incompatible Stage5 Browser builds.',
        {
          details: {
            reason: 'worker_protocol_mismatch',
            expectedProtocolVersion: WORKER_PROTOCOL_VERSION,
            receivedProtocolVersion: request.payload.protocolVersion ?? null,
            mcpVersion: request.payload.mcpVersion ?? null,
            workerVersion: STAGE5_BROWSER_VERSION,
            expectedBuildFingerprint: request.payload.mcpBuildFingerprint ?? null,
            receivedBuildFingerprint: workerRuntime.artifactFingerprint,
            suggestedAction: 'Restart the MCP host so the MCP server and browser worker load the same build.',
          },
        },
      );
    }
    controller = new BrowserController(request.payload.config, request.payload.browser);
    return { ready: true, workerPid: process.pid, runtime: workerRuntime };
  }

  if (controller === undefined) {
    throw new Stage5BrowserError('BROWSER_NOT_READY', 'The browser worker has not been initialized.', {
      recoverable: true,
    });
  }

  const runtime = runtimeMonitor.inspect();
  if (runtime.restartRequired) {
    const authentication = await controller.authStatus();
    const humanBootstrapOwnsProfile =
      authentication.controlMode === 'human_bootstrap' && authentication.state === 'awaiting_user';
    if (!humanBootstrapOwnsProfile) {
      runtimeMonitor.assertCurrent();
    }
  }

  switch (request.command) {
    case 'status':
      return controller.status();
    case 'start':
      return controller.start(request.payload);
    case 'availableBrowsers':
      return controller.availableBrowsers();
    case 'diagnostics': {
      const status = await controller.status();
      return { browser: await controller.diagnostics(status), status, worker: runtimeMonitor.inspect() };
    }
    case 'switchBrowser':
      return controller.switchBrowser(request.payload);
    case 'stop':
      return controller.stop();
    case 'open':
      return controller.open(request.payload);
    case 'snapshot':
      return controller.snapshot(request.payload);
    case 'screenshot':
      return controller.screenshot(request.payload);
    case 'tabs':
      return controller.tabs();
    case 'selectTab':
      return controller.selectTab(request.payload);
    case 'frames':
      return controller.frames();
    case 'clickByRole':
      return controller.clickByRole(request.payload);
    case 'clickRef':
      return controller.clickRef(request.payload);
    case 'setInputFiles':
      return controller.setInputFiles(request.payload);
    case 'fillByRole':
      return controller.fillByRole(request.payload);
    case 'scroll':
      return controller.scroll(request.payload);
    case 'findText':
      return controller.findText(request.payload);
    case 'waitForUrl':
      return controller.waitForUrl(request.payload);
    case 'authStatus':
      return controller.authStatus();
    case 'requestLoginHandoff':
      return controller.requestLoginHandoff(request.payload);
    case 'resumeAfterLogin':
      return controller.resumeAfterLogin(request.payload);
    case 'testHang':
      if (process.env.STAGE5_BROWSER_TEST_MODE !== '1') {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The test-only command is disabled.');
      }
      return new Promise<never>(() => undefined);
    default:
      return assertNever(request);
  }
}

function assertNever(value: never): never {
  throw new Stage5BrowserError('OPERATION_FAILED', `Unsupported worker command: ${String(value)}`);
}

function isWorkerRequest(message: unknown): message is BrowserWorkerRequest {
  if (typeof message !== 'object' || message === null) {
    return false;
  }

  const candidate = message as Partial<BrowserWorkerRequest>;
  return (
    candidate.kind === 'request' &&
    typeof candidate.id === 'string' &&
    typeof candidate.command === 'string' &&
    typeof candidate.payload === 'object' &&
    candidate.payload !== null
  );
}

async function handleRequest(request: BrowserWorkerRequest): Promise<void> {
  try {
    const result = await dispatch(request);
    send({ kind: 'response', id: request.id, ok: true, result });
  } catch (error) {
    send({ kind: 'response', id: request.id, ok: false, error: serializeUnknownError(error) });
  }
}

process.on('message', (message: unknown) => {
  if (!isWorkerRequest(message) || shuttingDown) {
    return;
  }

  commandTail = commandTail.then(() => handleRequest(message)).catch(() => undefined);
});

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    await controller?.detachForWorkerShutdown();
  } catch {
    // The supervisor owns the hard process-tree deadline.
  } finally {
    process.disconnect?.();
  }
}

process.once('SIGTERM', () => {
  void shutdown();
});
process.once('SIGINT', () => {
  void shutdown();
});
process.once('disconnect', () => {
  void shutdown();
});
