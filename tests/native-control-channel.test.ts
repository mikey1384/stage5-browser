import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  nativeControlEndpoint,
  nativeControlRecordPath,
  processIsRunning,
  readNativeControlRecord,
  removeNativeControlRecord,
  writeNativeControlRecord,
  type NativeControlRecord,
} from '../src/native-control-channel.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native browser control record', () => {
  it('persists only a private loopback endpoint and exact owned process metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stage5-native-record-'));
    temporaryRoots.push(root);
    const record: NativeControlRecord = {
      version: 1,
      kind: 'chromium_cdp',
      browser: 'brave',
      state: 'controlled',
      processId: process.pid,
      port: 29_123,
      createdAt: '2026-08-24T12:00:00.000Z',
      selectedTargetId: 'opaque-target-1',
    };

    await writeNativeControlRecord(root, record);
    await expect(readNativeControlRecord(root, 'brave')).resolves.toEqual(record);
    await expect(readNativeControlRecord(root, 'chrome')).resolves.toBeNull();
    expect(nativeControlEndpoint(record)).toBe('http://127.0.0.1:29123');
    expect(processIsRunning(process.pid)).toBe(true);
    if (process.platform !== 'win32') {
      expect((await stat(nativeControlRecordPath(root))).mode & 0o777).toBe(0o600);
    }

    await removeNativeControlRecord(root);
    await expect(readNativeControlRecord(root, 'brave')).resolves.toBeNull();
  });
});
