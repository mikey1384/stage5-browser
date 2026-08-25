import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  SUPPORTED_BROWSER_PRODUCTS,
  type BrowserProduct,
} from './browser-provider.js';

const CONTROL_RECORD_NAME = '.stage5-browser-control.json';

export interface NativeControlRecord {
  version: 1;
  kind: 'chromium_cdp';
  browser: BrowserProduct;
  state: 'awaiting_user' | 'controlled';
  processId: number;
  port: number;
  createdAt: string;
  /** Opaque CDP target identity used only to preserve exact tab selection across worker replacement. */
  selectedTargetId?: string | null;
}

export function nativeControlEndpoint(record: NativeControlRecord): string {
  return `http://127.0.0.1:${record.port}`;
}

export function nativeControlRecordPath(profileDir: string): string {
  return path.join(profileDir, CONTROL_RECORD_NAME);
}

function isNativeControlRecord(value: unknown): value is NativeControlRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<NativeControlRecord>;
  return candidate.version === 1
    && candidate.kind === 'chromium_cdp'
    && typeof candidate.browser === 'string'
    && (SUPPORTED_BROWSER_PRODUCTS as readonly string[]).includes(candidate.browser)
    && (candidate.state === 'awaiting_user' || candidate.state === 'controlled')
    && Number.isSafeInteger(candidate.processId)
    && (candidate.processId ?? 0) > 0
    && Number.isSafeInteger(candidate.port)
    && (candidate.port ?? 0) >= 1_024
    && (candidate.port ?? 0) <= 65_535
    && typeof candidate.createdAt === 'string'
    && (
      candidate.selectedTargetId === undefined ||
      candidate.selectedTargetId === null ||
      (typeof candidate.selectedTargetId === 'string' && candidate.selectedTargetId.length > 0 && candidate.selectedTargetId.length <= 256)
    );
}

export async function writeNativeControlRecord(
  profileDir: string,
  record: NativeControlRecord,
): Promise<void> {
  const destination = nativeControlRecordPath(profileDir);
  const temporary = path.join(profileDir, `.${CONTROL_RECORD_NAME}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  await chmod(destination, 0o600);
}

export async function readNativeControlRecord(
  profileDir: string,
  expectedBrowser: BrowserProduct,
): Promise<NativeControlRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(nativeControlRecordPath(profileDir), 'utf8'));
    return isNativeControlRecord(parsed) && parsed.browser === expectedBrowser ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

export async function removeNativeControlRecord(profileDir: string): Promise<void> {
  await rm(nativeControlRecordPath(profileDir), { force: true });
}

export function processIsRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
