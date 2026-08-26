import { BrowserController } from './browser-controller.js';
import { Stage5BrowserError, serializeUnknownError } from './errors.js';
import type {
  BrowserWorkerRequest,
  BrowserWorkerResponse,
} from './protocol.js';
import { browserCommandContract, dialogExpectationFromPayload } from './protocol.js';
import {
  buildStampUrlFor,
  negotiateWorkerInitialization,
  RuntimeArtifactMonitor,
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
  browserCommandContract(request.command);
  if (request.command === 'initialize') {
    runtimeMonitor.assertCurrent();
    const workerRuntime = runtimeMonitor.inspect();
    const initializedRuntime = negotiateWorkerInitialization(request.payload, workerRuntime);
    controller = new BrowserController(request.payload.config, request.payload.browser);
    controller.restoreActionPolicy(request.payload.actionPolicyMode);
    return { ready: true, workerPid: process.pid, runtime: initializedRuntime };
  }

  if (controller === undefined) {
    throw new Stage5BrowserError('BROWSER_NOT_READY', 'The browser worker has not been initialized.', {
      recoverable: true,
    });
  }
  const currentController = controller;

  const runtime = runtimeMonitor.inspect();
  if (runtime.restartRequired) {
    const authentication = await currentController.authStatus();
    const humanBootstrapOwnsProfile =
      authentication.controlMode === 'human_bootstrap' && authentication.state === 'awaiting_user';
    if (!humanBootstrapOwnsProfile) {
      runtimeMonitor.assertCurrent();
    }
  }

  currentController.authorizeBrowserCommand(request.command, request.payload);

  return currentController.withDialogHandling(
    request.command,
    dialogExpectationFromPayload(request.payload),
    async () => {
  switch (request.command) {
    case 'status':
      return currentController.status();
    case 'start':
      return currentController.start(request.payload);
    case 'availableBrowsers':
      return currentController.availableBrowsers();
    case 'diagnostics': {
      const status = await currentController.status();
      return { browser: await currentController.diagnostics(status), status, worker: runtimeMonitor.inspect() };
    }
    case 'pageEvents':
      return currentController.pageEvents(request.payload);
    case 'switchBrowser':
      return currentController.switchBrowser(request.payload);
    case 'stop':
      return currentController.stop();
    case 'open':
      return currentController.open(request.payload);
    case 'navigateHistory':
      return currentController.navigateHistory(request.payload);
    case 'snapshot':
      return currentController.snapshot(request.payload);
    case 'screenshot':
      return currentController.screenshot(request.payload);
    case 'tabs':
      return currentController.tabs();
    case 'selectTab':
      return currentController.selectTab(request.payload);
    case 'activateSelectedPage':
      return currentController.activateSelectedPage(request.payload);
    case 'closeTab':
      return currentController.closeTab(request.payload);
    case 'inspectTab':
      return currentController.inspectTab(request.payload);
    case 'frames':
      return currentController.frames();
    case 'clickByRole':
      return currentController.clickByRole(request.payload);
    case 'clickRef':
      return currentController.clickRef(request.payload);
    case 'setInputFiles':
      return currentController.setInputFiles(request.payload);
    case 'downloads':
      return currentController.downloads(request.payload);
    case 'waitForDownload':
      return currentController.waitForDownload(request.payload);
    case 'dialogStatus':
      return currentController.dialogStatus(request.payload);
    case 'fillByRole':
      return currentController.fillByRole(request.payload);
    case 'fillRef':
      return currentController.fillRef(request.payload);
    case 'inspectControl':
      return currentController.inspectControl(request.payload);
    case 'selectOption':
      return currentController.selectOption(request.payload);
    case 'selectOptions':
      return currentController.selectOptions(request.payload);
    case 'formSummary':
      return currentController.formSummary(request.payload);
    case 'applyFormPlan':
      return currentController.applyFormPlan(request.payload);
    case 'setChecked':
      return currentController.setChecked(request.payload);
    case 'motion':
      return currentController.motion(request.payload);
    case 'scroll':
      return currentController.scroll(request.payload);
    case 'findText':
      return currentController.findText(request.payload);
    case 'waitForUrl':
      return currentController.waitForUrl(request.payload);
    case 'authStatus':
      return currentController.authStatus();
    case 'privateFieldStatus':
      return currentController.privateFieldStatus();
    case 'requestPrivateFieldHandoff':
      return currentController.requestPrivateFieldHandoff(request.payload);
    case 'resumePrivateFieldHandoff':
      return currentController.resumePrivateFieldHandoff(request.payload);
    case 'policyStatus':
      return currentController.policyStatus();
    case 'setPolicy':
      return currentController.setPolicy(request.payload);
    case 'requestLoginHandoff':
      return currentController.requestLoginHandoff(request.payload);
    case 'resumeAfterLogin':
      return currentController.resumeAfterLogin(request.payload);
    case 'testHang':
      if (process.env.STAGE5_BROWSER_TEST_MODE !== '1') {
        throw new Stage5BrowserError('OPERATION_FAILED', 'The test-only command is disabled.');
      }
      return new Promise<never>(() => undefined);
    default:
      return assertNever(request);
  }
    },
  );
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
  controller?.drainActionPhaseTelemetry();
  try {
    const result = await dispatch(request);
    const telemetry = controller?.drainActionPhaseTelemetry();
    send({ kind: 'response', id: request.id, ok: true, result, ...(telemetry === undefined ? {} : { telemetry }) });
  } catch (error) {
    const telemetry = controller?.drainActionPhaseTelemetry();
    send({ kind: 'response', id: request.id, ok: false, error: serializeUnknownError(error), ...(telemetry === undefined ? {} : { telemetry }) });
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
