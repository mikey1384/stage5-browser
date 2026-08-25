import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';

import { BrowserController } from '../src/browser-controller.js';
import type { Stage5BrowserConfig } from '../src/config.js';
import type { SanitizedNativeWindowActivationEvidence } from '../src/page-diagnostics.js';

const runNativeSmoke = process.platform === 'darwin' &&
  process.env.STAGE5_BROWSER_NATIVE_WINDOW_SMOKE === '1';
const execFileAsync = promisify(execFile);

async function hideExactOwnedApplication(processId: number): Promise<void> {
  const script = String.raw`
ObjC.import('AppKit');
const application = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${processId});
if (!application) {
  throw new Error('temporary_owned_application_unavailable');
}
application.hide;
for (let attempt = 0; attempt < 20 && !application.hidden; attempt += 1) {
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.025));
}
if (!application.hidden) {
  throw new Error('temporary_owned_application_hide_failed');
}
`;
  await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script]);
}

describe.skipIf(!runNativeSmoke)('native window activation smoke', () => {
  let root: string | undefined;
  let controller: BrowserController | undefined;

  afterAll(async () => {
    await controller?.stop().catch(() => undefined);
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('restores and unhides the exact owned Chromium application before input', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'stage5-native-window-smoke-'));
    const config: Stage5BrowserConfig = {
      browser: 'chromium',
      browserExecutablePath: null,
      profilesDir: path.join(root, 'profiles'),
      profileDir: path.join(root, 'profile'),
      artifactsDir: path.join(root, 'artifacts'),
      headless: false,
      operationTimeoutMs: 5_000,
      navigationTimeoutMs: 5_000,
      readinessTimeoutMs: 2_000,
      workerStartupTimeoutMs: 10_000,
      workerShutdownGraceMs: 500,
    };
    controller = new BrowserController(config);
    await controller.start();
    const internals = controller as unknown as {
      activePage: Page | undefined;
      controlledBrowserProcessId: number | null;
      activateOwnedNativeWindow: (page: Page) => Promise<SanitizedNativeWindowActivationEvidence>;
    };
    const page = internals.activePage;
    const processId = internals.controlledBrowserProcessId;
    expect(page).toBeDefined();
    expect(processId).toEqual(expect.any(Number));
    if (page === undefined || processId === null) {
      throw new Error('The isolated Chromium smoke profile did not expose its owned page and process.');
    }
    await page.setContent('<!doctype html><html><body><h1>Stage5 native activation smoke</h1></body></html>');

    const session = await page.context().newCDPSession(page);
    const observedWindow = await session.send('Browser.getWindowForTarget') as { windowId: number };
    await session.send('Browser.setWindowBounds', {
      windowId: observedWindow.windowId,
      bounds: { windowState: 'minimized' },
    });
    await expect(session.send('Browser.getWindowForTarget')).resolves.toMatchObject({
      windowId: observedWindow.windowId,
      bounds: { windowState: 'minimized' },
    });
    const nativeWindow = await internals.activateOwnedNativeWindow(page);
    await page.bringToFront();
    const visibleDeadline = Date.now() + 2_000;
    while (await page.evaluate(() => document.visibilityState) !== 'visible') {
      if (Date.now() >= visibleDeadline) {
        throw new Error('The isolated Chromium application did not become visible.');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await session.detach();

    expect(nativeWindow).toMatchObject({
      required: true,
      attempted: true,
      ownedProcessAvailable: true,
      ownedProcessRunning: true,
      targetWindowResolved: true,
      windowStateBefore: 'minimized',
      normalizationAttempted: true,
      normalizationSucceeded: true,
      applicationActivationAttempted: true,
      applicationActivationSucceeded: expect.any(Boolean),
      applicationHiddenBefore: false,
      unhideAttempted: false,
      unhideSucceeded: null,
      activationRequestAccepted: true,
      applicationFrontmostAfter: expect.any(Boolean),
      applicationHiddenAfter: false,
      result: expect.stringMatching(/^(activated|application_activation_unverified)$/),
    });

    await hideExactOwnedApplication(processId);
    const unhiddenWindow = await internals.activateOwnedNativeWindow(page);
    await page.bringToFront();
    const unhiddenDeadline = Date.now() + 2_000;
    while (await page.evaluate(() => document.visibilityState) !== 'visible') {
      if (Date.now() >= unhiddenDeadline) {
        throw new Error('The temporary Chromium application did not become visible after activation.');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(unhiddenWindow).toMatchObject({
      required: true,
      attempted: true,
      ownedProcessAvailable: true,
      ownedProcessRunning: true,
      targetWindowResolved: true,
      applicationActivationAttempted: true,
      applicationActivationSucceeded: expect.any(Boolean),
      applicationHiddenBefore: true,
      unhideAttempted: true,
      unhideSucceeded: true,
      activationRequestAccepted: true,
      applicationFrontmostAfter: expect.any(Boolean),
      applicationHiddenAfter: false,
      result: expect.stringMatching(/^(activated|application_activation_unverified)$/),
    });
    await expect(controller.screenshot({ fullPage: false, timeoutMs: 5_000 })).resolves.toMatchObject({
      captureEvidence: { pageActivation: { visibilityAfter: 'visible' } },
    });
  }, 20_000);
});
