import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import type { ElementHandle, Frame, Locator, Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserController } from "../../../src/browser-controller.js";
import {
  playwrightBrowserType,
  resolveBrowserLaunchTarget,
} from "../../../src/browser-provider.js";
import type { Stage5BrowserConfig } from "../../../src/config.js";
import { Stage5BrowserError } from "../../../src/errors.js";
import {
  inspectTargetState,
  PageDiagnosticBuffer,
  type SanitizedPageActivationEvidence,
} from "../../../src/page-diagnostics.js";
import { waitForProfileUnlock } from "../../../src/human-auth-bootstrap.js";
import type { OwnedBrowserWindowActivator } from "../../../src/native-window-activation.js";
import type { NativeControlRecord } from "../../../src/native-control-channel.js";
import {
  processIsRunning,
  readNativeControlRecord,
} from "../../../src/native-control-channel.js";
import {
  launchIdentityForTarget,
  controlledProfileArguments,
  type BrowserLaunchIdentity,
  type ProfileStorageInspection,
} from "../../../src/profile-binding.js";
import {
  processExecutablePath,
  processStartedAtToken,
  profilePathFingerprint,
  observeLaunchedBrowserProcess,
  snapshotOwnedDescendants,
  writeProfileOwnershipLease,
} from "../../../src/profile-ownership-lease.js";
import type { BrowserStatus } from "../../../src/protocol.js";
import {
  browserConfig,
  cleanBrowserControllerTestState,
  FakeHumanBrowserLauncher,
  listen,
  requestFakeLoginHandoff,
  storageInspection,
} from "../../browser-controller-fixture.js";

let server: Server | undefined;
let frameServer: Server | undefined;
let controller: BrowserController | undefined;
let temporaryRoot: string | undefined;
let humanLauncher: FakeHumanBrowserLauncher | undefined;

afterEach(async () => {
  await cleanBrowserControllerTestState({
    controller,
    frameServer,
    humanLauncher,
    server,
    temporaryRoot,
  });
  controller = undefined;
  frameServer = undefined;
  humanLauncher = undefined;
  server = undefined;
  temporaryRoot = undefined;
});

describe("BrowserController privacy-safe diagnostic persistence", () => {
  it("retains privacy-safe last-action evidence for the exact native target across worker replacement", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Retained diagnostics</title></head><body>
        <button id="opener" type="button" aria-selected="false"
          onclick="this.setAttribute('aria-selected', 'true')">Funding source</button>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-retained-action-"),
    );
    const config = browserConfig(temporaryRoot);
    controller = new BrowserController(config);
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    await controller.clickByRole({
      role: "button",
      name: "Funding source",
      exact: true,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: true,
        expectedVisible: null,
        timeoutMs: 1_000,
      },
      timeoutMs: 3_000,
    });

    const page = (controller as unknown as { activePage: Page }).activePage;
    const selectedTargetId = "opaque-retained-target";
    const documentId = "opaque-retained-document";
    const nativeRecord: NativeControlRecord = {
      version: 1,
      kind: "chromium_cdp",
      browser: "chromium",
      state: "controlled",
      processId: process.pid,
      port: 29_123,
      createdAt: "2026-08-25T12:00:00.000Z",
      selectedTargetId,
    };
    (
      controller as unknown as {
        nativeControlRecord: NativeControlRecord | null;
      }
    ).nativeControlRecord = nativeRecord;
    vi.spyOn(
      controller as unknown as {
        chromiumTargetId: (candidate: Page) => Promise<string | null>;
      },
      "chromiumTargetId",
    ).mockResolvedValue(selectedTargetId);
    vi.spyOn(
      controller as unknown as {
        chromiumDocumentId: (candidate: Page) => Promise<string | null>;
      },
      "chromiumDocumentId",
    ).mockResolvedValue(documentId);

    await controller.persistActionDiagnosticsForWorkerHandoff();
    const persisted = await readNativeControlRecord(
      config.profileDir,
      "chromium",
    );
    expect(persisted?.retainedAction).toMatchObject({
      selectedTargetId,
      documentId,
      diagnostic: {
        action: "click_by_role",
        outcome: "succeeded",
        actionDispatched: true,
        clickDispatched: true,
      },
    });
    expect(persisted?.selectedDocumentId).toBe(documentId);
    if (persisted?.retainedAction === undefined) {
      throw new Error(
        "The retained action fixture did not persist exact-target evidence.",
      );
    }

    (
      controller as unknown as { pageDiagnostics: PageDiagnosticBuffer }
    ).pageDiagnostics = new PageDiagnosticBuffer();
    (
      controller as unknown as {
        nativeControlRecord: NativeControlRecord | null;
      }
    ).nativeControlRecord = {
      ...persisted,
      retainedAction: {
        ...persisted.retainedAction,
        documentId: "different-document",
      },
    };
    await (
      controller as unknown as {
        restoreNativeActionAfterAttach: (candidate: Page) => Promise<void>;
      }
    ).restoreNativeActionAfterAttach(page);
    expect((await controller.diagnostics()).page?.lastAction).toBeNull();

    (
      controller as unknown as {
        nativeControlRecord: NativeControlRecord | null;
      }
    ).nativeControlRecord = persisted;
    await (
      controller as unknown as {
        restoreNativeActionAfterAttach: (candidate: Page) => Promise<void>;
      }
    ).restoreNativeActionAfterAttach(page);
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_role",
      outcome: "succeeded",
      actionDispatched: true,
      clickDispatched: true,
    });

    const lifecycleBefore = await controller.pageEvents({ afterSequence: null, limit: 50 });
    (
      controller as unknown as {
        nativeControlRecord: NativeControlRecord | null;
      }
    ).nativeControlRecord = {
      ...persisted,
      selectedDocumentId: "document-before-worker-gap",
    };
    await (
      controller as unknown as {
        recordNativeContinuityAfterAttach: (candidate: Page) => Promise<void>;
      }
    ).recordNativeContinuityAfterAttach(page);
    const lifecycleAfter = await controller.pageEvents({
      afterSequence: lifecycleBefore.cursor,
      limit: 50,
    });
    expect(lifecycleAfter.events).toEqual([
      expect.objectContaining({
        kind: "document_replaced",
        stateRisk: "all_unsaved_form_state_may_be_lost",
      }),
    ]);
  });
});
