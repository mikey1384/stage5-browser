import { BrowserController } from './browser-controller.js';
import { Stage5BrowserError, serializeUnknownError } from './errors.js';
import type {
  BrowserWorkerRequest,
  BrowserWorkerResponse,
} from './protocol.js';

let controller: BrowserController | undefined;
let commandTail: Promise<void> = Promise.resolve();
let shuttingDown = false;

function send(message: BrowserWorkerResponse): void {
  if (process.connected) {
    process.send?.(message);
  }
}

async function dispatch(request: BrowserWorkerRequest): Promise<unknown> {
  if (request.command === 'initialize') {
    controller = new BrowserController(request.payload.config, request.payload.browser);
    return { ready: true, workerPid: process.pid };
  }

  if (controller === undefined) {
    throw new Stage5BrowserError('BROWSER_NOT_READY', 'The browser worker has not been initialized.', {
      recoverable: true,
    });
  }

  switch (request.command) {
    case 'status':
      return controller.status();
    case 'start':
      return controller.start(request.payload);
    case 'availableBrowsers':
      return controller.availableBrowsers();
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
    case 'fillByRole':
      return controller.fillByRole(request.payload);
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
    await controller?.stop();
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
