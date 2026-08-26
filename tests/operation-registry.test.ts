import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Stage5BrowserError } from '../src/errors.js';
import { OperationRegistry } from '../src/operations/registry.js';

let temporaryRoot: string | undefined;

afterEach(async () => {
  if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

describe('OperationRegistry', () => {
  it('binds one reservation to one command and retains a terminal result only in memory', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-operation-registry-'));
    const registry = new OperationRegistry(temporaryRoot);
    const reservation = registry.reserve('clickRef');
    const operation = registry.begin('clickRef', reservation.operationId);
    registry.transition(operation.operationId, 'worker_preflight');
    registry.transition(operation.operationId, 'worker_request_sent');
    registry.transition(operation.operationId, 'worker_result_received');
    const result = { postcondition: { passed: true }, privateTransientResult: 'not-durable' };
    registry.succeed(operation.operationId, result, 'not_needed');
    const timing = registry.timing(operation.operationId);
    await registry.persist({
      operationId: operation.operationId,
      command: operation.command,
      startedAt: operation.startedAt,
      durationMs: 12,
      outcome: 'succeeded',
      recovery: 'not_needed',
      currentUrl: 'https://example.com/path?private=query#fragment',
      timing: { ...timing, terminalAtMs: timing.terminalAtMs! },
    });
    await registry.markResponseCreated(operation.operationId);

    await expect(registry.status(operation.operationId, false)).resolves.toMatchObject({
      terminal: true,
      outcome: 'succeeded',
      resultAvailable: true,
      source: 'memory',
      timing: {
        persistedAtMs: expect.any(Number),
        responseCreatedAtMs: expect.any(Number),
      },
    });
    expect(await registry.status(operation.operationId, false)).not.toHaveProperty('result');
    await expect(registry.status(operation.operationId, true)).resolves.toMatchObject({ result });

    const journal = await readFile(path.join(temporaryRoot, 'operations.jsonl'), 'utf8');
    expect(journal).toContain('https://example.com/path');
    expect(journal).not.toContain('private=query');
    expect(journal).not.toContain('fragment');
    expect(journal).not.toContain('not-durable');

    const restarted = new OperationRegistry(temporaryRoot);
    await expect(restarted.status(operation.operationId, false)).resolves.toMatchObject({
      source: 'durable',
      terminal: true,
      timing: {
        persistedAtMs: expect.any(Number),
        responseCreatedAtMs: expect.any(Number),
      },
    });
  });

  it('recovers only sanitized terminal metadata after a host restart', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-operation-durable-'));
    const first = new OperationRegistry(temporaryRoot);
    const operation = first.begin('fillByRole');
    first.fail(operation.operationId, {
      code: 'OPERATION_TIMEOUT',
      message: 'Transient detail',
      recoverable: true,
      details: { privateTransientDetail: 'excluded' },
    }, 'succeeded');
    const timing = first.timing(operation.operationId);
    await first.persist({
      operationId: operation.operationId,
      command: operation.command,
      startedAt: operation.startedAt,
      durationMs: 1_000,
      outcome: 'timed_out',
      recovery: 'succeeded',
      errorCode: 'OPERATION_TIMEOUT',
      timing: { ...timing, terminalAtMs: timing.terminalAtMs! },
    });

    const restarted = new OperationRegistry(temporaryRoot);
    await expect(restarted.status(operation.operationId, true)).resolves.toMatchObject({
      source: 'durable',
      terminal: true,
      outcome: 'timed_out',
      recovery: 'succeeded',
      resultAvailable: false,
      error: { code: 'OPERATION_TIMEOUT' },
    });
    expect(JSON.stringify(await restarted.status(operation.operationId, true)))
      .not.toContain('privateTransientDetail');
  });

  it('rejects reuse and command changes before any operation begins', () => {
    const registry = new OperationRegistry('/tmp/stage5-operation-registry-unused');
    const reservation = registry.reserve('clickByRole');
    expect(() => registry.begin('clickRef', reservation.operationId))
      .toThrow(Stage5BrowserError);
    registry.begin('clickByRole', reservation.operationId);
    expect(() => registry.begin('clickByRole', reservation.operationId))
      .toThrow(Stage5BrowserError);
  });
});
