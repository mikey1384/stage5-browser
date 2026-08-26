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

describe("BrowserController fill preparation and deadline boundaries", () => {
  it("waits once for a transient unique role editor before the only fill dispatch", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Transient editor</title></head><body>
        <div id="mount"></div>
        <script>
          setTimeout(() => {
            const input = document.createElement('input');
            input.setAttribute('aria-label', 'Business description');
            document.querySelector('#mount').append(input);
          }, 125);
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-fill-role-transition-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/form`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    await expect(controller.fillByRole({
      role: "textbox",
      name: "Business description",
      exact: true,
      frameId: null,
      value: "Public fixture description",
      timeoutMs: 2_000,
    })).resolves.toMatchObject({
      input: {
        actionDispatched: true,
        valueMatches: true,
        targetKind: "input",
      },
    });
    const page = (controller as unknown as { activePage: Page }).activePage;
    await expect(page.getByRole("textbox", { name: "Business description" }).inputValue())
      .resolves.toBe("Public fixture description");
  });

  it("reports the HTML date format before input and accepts one corrected ISO fill", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Date editor</title></head><body>
        <label>Incorporation date <input type="date" role="textbox" /></label>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-fill-role-date-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/form`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    await expect(controller.fillByRole({
      role: "textbox",
      name: "Incorporation date",
      exact: true,
      frameId: null,
      value: "08/25/2026",
      timeoutMs: 2_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "OPERATION_FAILED",
      details: {
        reason: "invalid_date_format",
        expectedFormat: "YYYY-MM-DD",
        actionDispatched: false,
      },
    });
    const page = (controller as unknown as { activePage: Page }).activePage;
    await expect(page.locator('input[type="date"]').inputValue()).resolves.toBe("");

    await expect(controller.fillByRole({
      role: "textbox",
      name: "Incorporation date",
      exact: true,
      frameId: null,
      value: "2026-08-25",
      timeoutMs: 2_000,
    })).resolves.toMatchObject({ input: { valueMatches: true } });
    await expect(page.locator('input[type="date"]').inputValue()).resolves.toBe("2026-08-25");
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
});
