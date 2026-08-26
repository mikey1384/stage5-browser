import { isMainThread, parentPort, workerData } from 'node:worker_threads';

import type { LoungeStoreRequest, LoungeStoreResponse } from './lounge-types.js';
import { LoungeStoreDatabase } from './lounge/store/runtime.js';
import { storeError } from './lounge/store/model.js';

export { LoungeStoreDatabase } from './lounge/store/runtime.js';

interface LoungeStoreWorkerData {
  stage5LoungeStoreWorker: true;
  databasePath: string;
  managerAgentIds: string[];
}

function isWorkerConfiguration(value: unknown): value is LoungeStoreWorkerData {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<LoungeStoreWorkerData>;
  return candidate.stage5LoungeStoreWorker === true
    && typeof candidate.databasePath === 'string'
    && candidate.databasePath.startsWith('/')
    && Array.isArray(candidate.managerAgentIds)
    && candidate.managerAgentIds.every((agentId) => typeof agentId === 'string');
}

function handleRequest(store: LoungeStoreDatabase, request: LoungeStoreRequest): unknown {
  switch (request.operation) {
    case 'join': return store.join(request.input);
    case 'heartbeat': return store.heartbeat(request.input);
    case 'send': return store.send(request.input);
    case 'claimInbox': return store.claimInbox(request.input);
    case 'ack': return store.ack(request.input);
    case 'status': return store.status(request.input);
    case 'notice': return store.notice(request.input);
    case 'pin': return store.pin(request.input);
    case 'history': return store.history(request.input);
    case 'closeSession': return store.closeSession(request.input);
    case 'close':
      store.close();
      return { closed: true };
  }
}

if (!isMainThread) {
  if (parentPort === null || !isWorkerConfiguration(workerData)) {
    throw new Error('Invalid Stage5 Lounge store worker configuration.');
  }
  const port = parentPort;
  const store = new LoungeStoreDatabase(workerData.databasePath, workerData.managerAgentIds);
  port.on('message', (request: LoungeStoreRequest) => {
    let response: LoungeStoreResponse;
    try {
      response = { id: request.id, ok: true, result: handleRequest(store, request) };
    } catch (error) {
      response = { id: request.id, ok: false, error: storeError(error) };
    }
    port.postMessage(response);
    if (request.operation === 'close') port.close();
  });
}
