import { parentPort } from 'node:worker_threads';

if (parentPort === null) {
  throw new Error('The hanging Lounge fixture must run in a worker thread.');
}

parentPort.on('message', () => {
  // Intentionally retain the request without replying. The client must enforce its own
  // bounded deadline and terminate this disposable fixture worker.
});
