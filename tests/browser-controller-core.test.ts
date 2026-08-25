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

import { BrowserController } from "../src/browser-controller.js";
import {
  playwrightBrowserType,
  resolveBrowserLaunchTarget,
} from "../src/browser-provider.js";
import type { Stage5BrowserConfig } from "../src/config.js";
import { Stage5BrowserError } from "../src/errors.js";
import {
  inspectTargetState,
  PageDiagnosticBuffer,
  type SanitizedPageActivationEvidence,
} from "../src/page-diagnostics.js";
import { waitForProfileUnlock } from "../src/human-auth-bootstrap.js";
import type { OwnedBrowserWindowActivator } from "../src/native-window-activation.js";
import type { NativeControlRecord } from "../src/native-control-channel.js";
import {
  processIsRunning,
  readNativeControlRecord,
} from "../src/native-control-channel.js";
import {
  launchIdentityForTarget,
  controlledProfileArguments,
  type BrowserLaunchIdentity,
  type ProfileStorageInspection,
} from "../src/profile-binding.js";
import {
  processExecutablePath,
  processStartedAtToken,
  profilePathFingerprint,
  observeLaunchedBrowserProcess,
  snapshotOwnedDescendants,
  writeProfileOwnershipLease,
} from "../src/profile-ownership-lease.js";
import type { BrowserStatus } from "../src/protocol.js";
import {
  browserConfig,
  cleanBrowserControllerTestState,
  FakeHumanBrowserLauncher,
  listen,
  requestFakeLoginHandoff,
  storageInspection,
} from "./browser-controller-fixture.js";

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

describe("BrowserController core lifecycle", () => {
  it("does not implicitly launch a stopped browser while taking a semantic snapshot", async () => {
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-stopped-snapshot-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));

    await expect(controller.status()).resolves.toMatchObject({
      browser: "chromium",
      state: "stopped",
      browserConnected: false,
      pages: [],
      launchIdentity: null,
    });
    await expect(
      controller.snapshot({
        depth: 8,
        boxes: false,
        frameId: null,
        timeoutMs: 2_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "BROWSER_NOT_READY",
      details: {
        reason: "browser_stopped",
        browser: "chromium",
        actionDispatched: false,
      },
    });
    await expect(controller.status()).resolves.toMatchObject({
      browser: "chromium",
      state: "stopped",
      browserConnected: false,
      pages: [],
      launchIdentity: null,
    });
  });

  it("navigates, snapshots, fills unique targets, and rejects ambiguous targets", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html><head><title>Stage5 Browser fixture</title></head>
        <body>
          <h1>Translator tools fixture</h1>
          <label for="query">Search videos</label><input id="query" />
          <button type="button">Duplicate</button><button type="button">Duplicate</button>
        </body></html>`);
    });
    const port = await listen(server);

    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-controller-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));

    const opened = await controller.open({
      url: `http://127.0.0.1:${port}/watch/example`,
      newTab: false,
      timeoutMs: 5_000,
    });
    expect(opened.responseStatus).toBe(200);
    expect(opened.page.title).toBe("Stage5 Browser fixture");
    expect((await controller.status()).launchIdentity).toMatchObject({
      browser: "chromium",
      engine: "chromium",
      profile: {
        userDataDir: path.join(temporaryRoot, "profile"),
        profileDirectory: "Default",
      },
    });

    const snapshot = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(snapshot.snapshot).toContain("Translator tools fixture");
    await controller.fillByRole({
      role: "textbox",
      name: "Search videos",
      exact: true,
      frameId: null,
      value: "hello",
      timeoutMs: 5_000,
    });

    await expect(
      controller.clickByRole({
        role: "button",
        name: "Duplicate",
        exact: true,
        frameId: null,
        postcondition: null,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "AMBIGUOUS_TARGET",
    });

    const screenshot = await controller.screenshot({
      fullPage: false,
      timeoutMs: 5_000,
    });
    expect((await stat(screenshot.path)).mode & 0o777).toBe(0o600);
    expect(screenshot.dataBase64.length).toBeGreaterThan(100);
    expect(screenshot.captureEvidence).toMatchObject({
      artifactClassification: "contentful",
      semanticContentPresent: true,
      retryUsed: false,
      pageActivation: {
        controllerSelected: true,
        bringToFrontAttempted: false,
        bringToFrontSucceeded: false,
        visibilityAfter: "visible",
      },
    });
    expect(screenshot.captureEvidence.pngBytes).toBeGreaterThan(100);

    const available = await controller.availableBrowsers();
    for (const browser of ["chromium", "firefox", "webkit"] as const) {
      expect(
        available.browsers.find((entry) => entry.browser === browser)
          ?.available,
      ).toBe(true);
    }
    expect(
      available.browsers.find((entry) => entry.browser === "chromium"),
    ).toMatchObject({
      installed: true,
      profileState: "owned_active",
      startable: true,
      recoverable: false,
    });
    expect(
      available.browsers.find((entry) => entry.browser === "firefox"),
    ).toMatchObject({
      installed: true,
      profileState: "startable",
      startable: true,
    });
    const competingController = new BrowserController(
      browserConfig(temporaryRoot),
    );
    expect(
      (await competingController.availableBrowsers()).browsers.find(
        (entry) => entry.browser === "chromium",
      ),
    ).toMatchObject({
      available: false,
      installed: true,
      profileState: "busy_other_stage5_session",
      startable: false,
      recoverable: false,
    });

    await expect(
      controller.start({ browser: "firefox" }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "OPERATION_FAILED",
      details: {
        currentBrowser: "chromium",
        requestedBrowser: "firefox",
        reason: "browser_already_running",
      },
    });
    expect((await controller.status()).browser).toBe("chromium");

    for (const browser of ["firefox", "webkit"] as const) {
      const switched = await controller.switchBrowser({ browser });
      expect(switched).toMatchObject({
        browser,
        state: "running",
        browserConnected: true,
      });
      const reopened = await controller.open({
        url: `http://127.0.0.1:${port}/watch/${browser}`,
        newTab: false,
        timeoutMs: 5_000,
      });
      expect(reopened.responseStatus).toBe(200);
      expect(reopened.page.title).toBe("Stage5 Browser fixture");
    }
  });

  it("fills an unnamed snapshot-bound contenteditable with privacy-safe evidence", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Unnamed composer</title></head><body>
        <div role="dialog" aria-modal="true" aria-label="Create post">
          <span>What's on your mind?</span>
          <div id="editor" role="textbox" contenteditable="true" tabindex="0" autofocus><p><br></p></div>
          <button type="button">Post</button>
        </div>
        <script>
          document.querySelector('#editor').addEventListener('focus', () => {
            document.querySelector('span').setAttribute('data-editor-focused', 'true');
          });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-fill-ref-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/compose`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({
      depth: 6,
      boxes: false,
      frameId: null,
      timeoutMs: 2_000,
    });
    expect(observed.scope).toBe("modal");
    const editorRef = observed.snapshot.match(
      /textbox[^\n]*\[ref=([^\]]+)\]/,
    )?.[1];
    expect(editorRef).toBeDefined();
    if (editorRef === undefined)
      throw new Error("Unnamed composer fixture did not expose a textbox ref.");

    const page = (controller as unknown as { activePage: Page }).activePage;
    const retainedEditor = (
      controller as unknown as {
        observedSnapshots: Map<
          Frame,
          {
            textEditors: Map<string, { handle: ElementHandle<HTMLElement> }>;
          }
        >;
      }
    ).observedSnapshots
      .get(page.mainFrame())
      ?.textEditors.get(editorRef)?.handle;
    expect(retainedEditor).toBeDefined();
    if (retainedEditor === undefined)
      throw new Error("Snapshot did not retain the exact editor handle.");
    const stabilityGatedScroll = vi
      .spyOn(retainedEditor, "scrollIntoViewIfNeeded")
      .mockRejectedValue(
        new Error(
          "A visible editor must not enter Playwright stability-gated scrolling.",
        ),
      );
    const snapshotRoot = vi
      .spyOn(
        controller as unknown as {
          snapshotRoot: (...args: unknown[]) => Promise<unknown>;
        },
        "snapshotRoot",
      )
      .mockRejectedValue(
        new Error("fill_ref must not rediscover the live snapshot root"),
      );
    const frameLocator = vi.spyOn(page.mainFrame(), "locator");

    const draft =
      "새로운 영상의 핵심 내용을 정리했습니다.\n\nhttps://example.com/watch?v=stage5";
    const filled = await controller.fillRef({
      snapshotId: observed.snapshotId,
      ref: editorRef,
      frameId: null,
      value: draft,
      timeoutMs: 3_000,
    });
    expect(filled.input).toMatchObject({
      actionDispatched: true,
      inputEventObserved: true,
      valueMatchedBefore: false,
      valueMatches: true,
      targetConnectedAfter: true,
      targetKind: "contenteditable",
    });
    expect(JSON.stringify(filled)).not.toContain(draft);
    expect(snapshotRoot).not.toHaveBeenCalled();
    expect(stabilityGatedScroll).not.toHaveBeenCalled();
    expect(
      frameLocator.mock.calls.some(
        ([selector]) =>
          typeof selector === "string" && selector.startsWith("aria-ref="),
      ),
    ).toBe(false);
    await expect(page.locator("#editor p").allTextContents()).resolves.toEqual([
      "새로운 영상의 핵심 내용을 정리했습니다.",
      "",
      "https://example.com/watch?v=stage5",
    ]);
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "fill_ref",
      outcome: "succeeded",
      reason: null,
      actionDispatched: true,
      clickDispatched: null,
      fillPhase: "completed",
      fillPreparationStep: "completed",
      inputEvidence: {
        inputEventObserved: true,
        valueMatches: true,
        targetKind: "contenteditable",
      },
    });
    await expect(
      controller.fillRef({
        snapshotId: observed.snapshotId,
        ref: editorRef,
        frameId: null,
        value: "must not replay",
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "TARGET_NOT_FOUND",
      details: { reason: "stale_or_unknown_snapshot", actionDispatched: false },
    });
  });

  it("treats an exact contenteditable value transition as dispatched when page listeners hide input events", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Event-suppressing composer</title></head><body>
        <div role="dialog" aria-modal="true" aria-label="Create post">
          <div id="editor" role="textbox" contenteditable="true" tabindex="0"><p><br></p></div>
          <output id="preview">pending</output>
        </div>
        <script>
          const editor = document.querySelector('#editor');
          document.addEventListener('input', (event) => {
            if (!event.composedPath().includes(editor)) return;
            document.querySelector('#preview').textContent = 'ready';
            event.stopImmediatePropagation();
          }, true);
          document.addEventListener('change', (event) => {
            if (event.composedPath().includes(editor)) event.stopImmediatePropagation();
          }, true);
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-fill-ref-hidden-events-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/compose`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({
      depth: 6,
      boxes: false,
      frameId: null,
      timeoutMs: 2_000,
    });
    const editorRef = observed.snapshot.match(
      /textbox[^\n]*\[ref=([^\]]+)\]/,
    )?.[1];
    expect(editorRef).toBeDefined();
    if (editorRef === undefined)
      throw new Error(
        "Event-suppressing fixture did not expose its editor ref.",
      );

    const draft =
      "정확한 값 전환 증거를 확인합니다.\n\nhttps://example.com/stage5";
    await expect(
      controller.fillRef({
        snapshotId: observed.snapshotId,
        ref: editorRef,
        frameId: null,
        value: draft,
        timeoutMs: 3_000,
      }),
    ).resolves.toMatchObject({
      input: {
        actionDispatched: true,
        inputEventObserved: false,
        changeEventObserved: false,
        valueMatchedBefore: false,
        valueMatches: true,
        targetConnectedAfter: true,
        targetKind: "contenteditable",
      },
    });
    const page = (controller as unknown as { activePage: Page }).activePage;
    await expect(page.locator("#preview").textContent()).resolves.toBe("ready");
    await expect(page.locator("#editor p").allTextContents()).resolves.toEqual([
      "정확한 값 전환 증거를 확인합니다.",
      "",
      "https://example.com/stage5",
    ]);
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "fill_ref",
      outcome: "succeeded",
      actionDispatched: true,
      inputEvidence: {
        inputEventObserved: false,
        changeEventObserved: false,
        valueMatchedBefore: false,
        valueMatches: true,
      },
    });
  });

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
  });

  it("scrolls an offscreen retained editor without Playwright stability-gated preparation", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Offscreen composer</title><style>
        [role="dialog"] { height: 180px; overflow: auto; }
        .spacer { height: 900px; }
        #editor { min-height: 48px; }
      </style></head><body>
        <div role="dialog" aria-modal="true" aria-label="Create post">
          <div class="spacer"></div>
          <div id="editor" role="textbox" contenteditable="true" tabindex="0"><p><br></p></div>
          <button type="button" disabled>Next</button>
        </div>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-fill-ref-offscreen-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/compose`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({
      depth: 6,
      boxes: false,
      frameId: null,
      timeoutMs: 2_000,
    });
    const editorRef = observed.snapshot.match(
      /textbox[^\n]*\[ref=([^\]]+)\]/,
    )?.[1];
    expect(editorRef).toBeDefined();
    if (editorRef === undefined)
      throw new Error(
        "Offscreen composer fixture did not expose a textbox ref.",
      );

    const page = (controller as unknown as { activePage: Page }).activePage;
    const retainedEditor = (
      controller as unknown as {
        observedSnapshots: Map<
          Frame,
          {
            textEditors: Map<string, { handle: ElementHandle<HTMLElement> }>;
          }
        >;
      }
    ).observedSnapshots
      .get(page.mainFrame())
      ?.textEditors.get(editorRef)?.handle;
    expect(retainedEditor).toBeDefined();
    if (retainedEditor === undefined)
      throw new Error("Snapshot did not retain the offscreen editor handle.");
    const stabilityGatedScroll = vi
      .spyOn(retainedEditor, "scrollIntoViewIfNeeded")
      .mockRejectedValue(
        new Error(
          "The exact DOM viewport path must not use Playwright stability waits.",
        ),
      );

    const draft =
      "보이는 영역 밖의 편집기 테스트입니다.\n\nhttps://example.com/stage5";
    await expect(
      controller.fillRef({
        snapshotId: observed.snapshotId,
        ref: editorRef,
        frameId: null,
        value: draft,
        timeoutMs: 3_000,
      }),
    ).resolves.toMatchObject({
      input: {
        actionDispatched: true,
        inputEventObserved: true,
        valueMatches: true,
        targetKind: "contenteditable",
      },
    });
    expect(stabilityGatedScroll).not.toHaveBeenCalled();
    await expect(
      page.locator("#editor").evaluate((editor) => {
        const rect = editor.getBoundingClientRect();
        const dialogRect = editor.parentElement?.getBoundingClientRect();
        return (
          dialogRect !== undefined &&
          rect.bottom > dialogRect.top &&
          rect.top < dialogRect.bottom
        );
      }),
    ).resolves.toBe(true);
  });

  it("returns structured no-input evidence before a Facebook-style contenteditable fill deadline", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Bounded unnamed composer</title></head><body>
        <div role="dialog" aria-modal="true" aria-label="Create post">
          <span>What's on your mind?</span>
          <div id="editor" role="textbox" contenteditable="true" tabindex="0"><p><br></p></div>
          <button type="button" disabled>Next</button>
        </div>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-fill-ref-timeout-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/compose`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({
      depth: 6,
      boxes: false,
      frameId: null,
      timeoutMs: 2_000,
    });
    const editorRef = observed.snapshot.match(
      /textbox[^\n]*\[ref=([^\]]+)\]/,
    )?.[1];
    expect(editorRef).toBeDefined();
    if (editorRef === undefined)
      throw new Error("Bounded composer fixture did not expose a textbox ref.");
    const dispatch = vi
      .spyOn(
        controller as unknown as {
          dispatchExactHandleFill: (
            handle: unknown,
            value: string,
            timeoutMs: number,
          ) => Promise<void>;
        },
        "dispatchExactHandleFill",
      )
      .mockImplementation(async (_handle, _value, timeoutMs) => {
        await new Promise((resolve) => setTimeout(resolve, timeoutMs));
        const error = new Error("Simulated exact-handle fill timeout.");
        error.name = "TimeoutError";
        throw error;
      });
    const draft = "멀티라인 테스트입니다.\n\nhttps://example.com/video";
    const startedAt = Date.now();
    let failure: Stage5BrowserError | null = null;
    try {
      await controller.fillRef({
        snapshotId: observed.snapshotId,
        ref: editorRef,
        frameId: null,
        value: draft,
        timeoutMs: 1_000,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Stage5BrowserError);
      failure = error as Stage5BrowserError;
    }
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(failure).toMatchObject({
      code: "OPERATION_FAILED",
      details: {
        reason: "fill_dispatch_failed",
        fillPhase: "fill_dispatch",
        actionDispatched: false,
        inputEvidence: {
          inputEventObserved: false,
          changeEventObserved: false,
          valueMatchedBefore: false,
          valueMatches: false,
          targetConnectedAfter: true,
          targetKind: "contenteditable",
        },
      },
    });
    expect(JSON.stringify(failure?.serialize())).not.toContain(draft);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const page = (controller as unknown as { activePage: Page }).activePage;
    await expect(page.locator("#editor").textContent()).resolves.toBe("");
    await expect(
      page.getByRole("button", { name: "Next" }).isDisabled(),
    ).resolves.toBe(true);
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "fill_ref",
      outcome: "blocked",
      reason: "timeout",
      actionDispatched: false,
      clickDispatched: null,
      fillPhase: "fill_dispatch",
      inputEvidence: { valueMatches: false },
    });
  });

  it("fails a detached snapshot scope promptly at the exact preparation step without resolving ARIA refs again", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Replacing composer</title></head><body>
        <div id="composer" role="dialog" aria-modal="true" aria-label="Create post">
          <div id="editor" role="textbox" contenteditable="true" tabindex="0"><p><br></p></div>
          <button type="button" disabled>Next</button>
        </div>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-fill-ref-scope-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/compose`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({
      depth: 6,
      boxes: false,
      frameId: null,
      timeoutMs: 2_000,
    });
    const editorRef = observed.snapshot.match(
      /textbox[^\n]*\[ref=([^\]]+)\]/,
    )?.[1];
    expect(editorRef).toBeDefined();
    if (editorRef === undefined)
      throw new Error(
        "Replacing composer fixture did not expose a textbox ref.",
      );
    const page = (controller as unknown as { activePage: Page }).activePage;
    await page
      .locator("#composer")
      .evaluate((composer) => composer.replaceWith(composer.cloneNode(true)));

    const startedAt = Date.now();
    await expect(
      controller.fillRef({
        snapshotId: observed.snapshotId,
        ref: editorRef,
        frameId: null,
        value:
          "이 값은 입력되면 안 됩니다.\n\nhttps://example.com/private-draft",
        timeoutMs: 2_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "TARGET_NOT_FOUND",
      details: {
        reason: "snapshot_scope_changed",
        fillPhase: "target_preparation",
        fillPreparationStep: "scope_validation",
        actionDispatched: false,
        targetState: null,
        inputEvidence: null,
      },
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await expect(page.locator("#editor").textContent()).resolves.toBe("");
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "fill_ref",
      outcome: "blocked",
      actionDispatched: false,
      fillPhase: "target_preparation",
      fillPreparationStep: "scope_validation",
      targetState: null,
    });
  });

  it("reports an externally locked stopped profile and waits for a bounded owned release", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><head><title>Released profile</title></head><body>Ready</body></html>",
      );
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-transient-lock-"),
    );
    const config = browserConfig(temporaryRoot);
    await mkdir(config.profileDir, { recursive: true });
    const lockPath = path.join(config.profileDir, "SingletonLock");
    await writeFile(lockPath, "owned-by-prior-worker");
    controller = new BrowserController(config);

    await expect(controller.status()).resolves.toMatchObject({
      state: "stopped",
      browserConnected: false,
      profileLockState: "possible_external_owner",
      profileLockFiles: ["SingletonLock"],
    });
    expect(
      (await controller.availableBrowsers()).browsers.find(
        (entry) => entry.browser === "chromium",
      ),
    ).toMatchObject({
      available: false,
      installed: true,
      profileState: "external_owner",
      startable: false,
      recoverable: false,
    });
    const release = setTimeout(() => {
      void rm(lockPath, { force: true });
    }, 150);
    try {
      await expect(
        controller.open({
          url: `http://127.0.0.1:${port}/`,
          newTab: false,
          stabilizationMs: 0,
          timeoutMs: 5_000,
        }),
      ).resolves.toMatchObject({ responseStatus: 200 });
    } finally {
      clearTimeout(release);
    }
    const running = await controller.status();
    expect(running).toMatchObject({
      state: "running",
      browserConnected: true,
    });
    expect(running.profileLockState).not.toBe("possible_external_owner");
  });

  it("removes only exact dead-process singleton entries before restarting the owned profile", async () => {
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-stale-singleton-"),
    );
    const config = browserConfig(temporaryRoot);
    await mkdir(config.profileDir, { recursive: true });
    const target = await resolveBrowserLaunchTarget({
      browser: "chromium",
      executablePath: null,
    });
    const identity = launchIdentityForTarget(target, config.profileDir);
    const deadBrowserProcessId = 2_147_483_647;
    const deadWorkerProcessId = 2_147_483_646;
    const now = new Date().toISOString();
    const executable = await realpath(identity.executablePath);
    const staleLeaseId = randomUUID();
    await writeProfileOwnershipLease(config.profileDir, {
      version: 1,
      leaseId: staleLeaseId,
      browser: "chromium",
      engine: "chromium",
      profileFingerprint: profilePathFingerprint(config.profileDir),
      ownerWorkerProcessId: deadWorkerProcessId,
      ownerWorkerStartedAt: "exited-test-worker",
      browserProcessId: deadBrowserProcessId,
      browserProcessStartedAt: "exited-test-browser",
      browserExecutableFingerprint: createHash("sha256")
        .update(executable)
        .digest("hex"),
      controlMode: "playwright",
      phase: "process_exited",
      createdAt: now,
      heartbeatAt: now,
    });
    await Promise.all([
      symlink(
        `fixture-host-${deadBrowserProcessId}`,
        path.join(config.profileDir, "SingletonLock"),
      ),
      symlink("stale-cookie", path.join(config.profileDir, "SingletonCookie")),
      symlink(
        path.join(config.profileDir, "missing-socket"),
        path.join(config.profileDir, "SingletonSocket"),
      ),
    ]);
    controller = new BrowserController(config);

    await expect(controller.status()).resolves.toMatchObject({
      state: "stopped",
      browserConnected: false,
      profileLockState: "possible_external_owner",
      profileOwner: {
        classification: "owned_orphaned",
        ownership: "proven",
        recovery: "automatic_owned_restart",
        lease: {
          state: "abandoned",
          browserProcess: "not_running",
          controlMode: "playwright",
          phase: "process_exited",
        },
      },
    });
    expect(
      (await controller.availableBrowsers()).browsers.find(
        (entry) => entry.browser === "chromium",
      ),
    ).toMatchObject({
      available: true,
      profileState: "owned_orphaned",
      startable: true,
      recoverable: true,
    });
    await expect(controller.start()).resolves.toMatchObject({
      state: "running",
      browserConnected: true,
      profileOwner: {
        classification: "owned_active",
        ownership: "proven",
      },
    });
    expect(processIsRunning(deadBrowserProcessId)).toBe(false);
    await expect(controller.stop()).resolves.toMatchObject({
      state: "stopped",
      browserConnected: false,
      profileLockFiles: [],
    });
  });

  it("recovers a conclusively proven direct-Playwright orphan without stranding its profile", async () => {
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-owned-orphan-"),
    );
    const config = browserConfig(temporaryRoot);
    await mkdir(config.profileDir, { recursive: true });
    const target = await resolveBrowserLaunchTarget({
      browser: "chromium",
      executablePath: null,
    });
    const identity = launchIdentityForTarget(target, config.profileDir);
    const baselineDescendants = await snapshotOwnedDescendants(process.pid);
    const orphanContext = await playwrightBrowserType(
      "chromium",
    ).launchPersistentContext(config.profileDir, {
      headless: true,
      args: controlledProfileArguments(identity.profile),
    });
    try {
      const orphanProcess = await observeLaunchedBrowserProcess(
        identity,
        baselineDescendants,
        2_000,
      );
      expect(orphanProcess).not.toBeNull();
      if (orphanProcess === null)
        throw new Error("Fixture browser process identity was not observable.");
      const orphanProcessId = orphanProcess.processId;
      const [browserStartedAt, browserExecutable] = await Promise.all([
        processStartedAtToken(orphanProcessId),
        processExecutablePath(orphanProcessId),
      ]);
      expect(browserStartedAt).not.toBeNull();
      expect(browserExecutable).not.toBeNull();
      if (browserStartedAt === null || browserExecutable === null) {
        throw new Error("Fixture browser process identity was not observable.");
      }
      const canonicalExecutable = await realpath(browserExecutable);
      const now = new Date().toISOString();
      await writeProfileOwnershipLease(config.profileDir, {
        version: 1,
        leaseId: randomUUID(),
        browser: "chromium",
        engine: "chromium",
        profileFingerprint: profilePathFingerprint(config.profileDir),
        ownerWorkerProcessId: 2_147_483_000,
        ownerWorkerStartedAt: "unreachable-test-worker",
        browserProcessId: orphanProcessId,
        browserProcessStartedAt: browserStartedAt,
        browserExecutableFingerprint: createHash("sha256")
          .update(canonicalExecutable)
          .digest("hex"),
        controlMode: "playwright",
        phase: "owned_active",
        createdAt: now,
        heartbeatAt: now,
      });

      controller = new BrowserController(config);
      expect(
        (await controller.availableBrowsers()).browsers.find(
          (entry) => entry.browser === "chromium",
        ),
      ).toMatchObject({
        available: true,
        profileState: "owned_orphaned",
        startable: true,
        recoverable: true,
      });
      await expect(controller.start()).resolves.toMatchObject({
        state: "running",
        browserConnected: true,
        profileOwner: {
          classification: "owned_active",
          ownership: "proven",
        },
      });
      expect(processIsRunning(orphanProcessId)).toBe(false);
    } finally {
      await orphanContext.close().catch(() => undefined);
    }
  });
});
