import { spawn } from 'node:child_process';

let initialized = false;
let browser = 'chromium';
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
    respond(message.id, { ready: true, workerPid: process.pid });
    return;
  }

  if (!initialized) {
    return;
  }

  if (message.command === 'testHang') {
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

process.on('SIGTERM', () => process.exit(0));
process.on('disconnect', () => process.exit(0));
