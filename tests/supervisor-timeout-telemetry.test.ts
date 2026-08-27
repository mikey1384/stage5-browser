import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BrowserSupervisor, SupervisedOperationError } from '../src/supervisor.js';
import { supervisorConfig } from './supervisor-fixture.js';

let supervisor: BrowserSupervisor | undefined;
let temporaryRoot: string | undefined;

afterEach(async () => {
  await supervisor?.close();
  supervisor = undefined;
  if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

describe('BrowserSupervisor timeout telemetry handoff', () => {
  it('retains in-flight phase and possible-dispatch evidence across worker replacement', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-timeout-telemetry-'));
    supervisor = new BrowserSupervisor(supervisorConfig(temporaryRoot), {
      workerUrl: new URL('./fixtures/fake-worker.mjs', import.meta.url),
      environment: {
        ...process.env,
        STAGE5_BROWSER_TEST_HANG_COMMAND: 'selectOption',
        STAGE5_BROWSER_TEST_MODE: '1',
      },
    });

    let caught: unknown;
    try {
      await supervisor.execute('selectOption', {
        inspectionId: null,
        optionId: null,
        control: null,
        option: null,
        frameId: null,
        timeoutMs: 1_000,
      }, 100);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: 'OPERATION_TIMEOUT', recovery: 'succeeded' });
    if (!(caught instanceof SupervisedOperationError)) throw new Error('Expected the supervised timeout error.');
    await expect(supervisor.executionTraces(caught.operationId, 1)).resolves.toMatchObject({
      traces: [{
        operationId: caught.operationId,
        command: 'selectOption',
        manager: 'form_manager',
        outcome: 'timed_out',
        actions: [{
          action: 'select_option',
          dispatchState: 'possibly_dispatched',
          dispatchAttempts: 1,
          terminalOutcome: null,
          phases: expect.arrayContaining([
            expect.objectContaining({ phase: 'dispatch', attempt: 1 }),
          ]),
        }],
        conclusion: { actionDispatched: 'unknown' },
      }],
    });
  });
});
