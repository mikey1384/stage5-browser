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

describe("BrowserController snapshot-bound fill evidence", () => {
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
});
