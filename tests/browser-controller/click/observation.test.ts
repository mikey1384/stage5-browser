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

describe("BrowserController click-adjacent observation and tab identity", () => {
  it("fails closed when activation creates multiple in-scope semantic replacements for a fresh ref", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Ambiguous reference replacement</title></head><body>
        <div role="dialog" aria-modal="true" aria-label="Business details">
          <button id="opener" type="button" onclick="document.querySelector('#counter').textContent = 'clicks:1'">
            Funding source
          </button>
          <output id="counter">clicks:0</output>
        </div>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-ref-activation-ambiguous-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
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
    const openerRef = observed.snapshot.match(
      /button "Funding source"[^\n]*\[ref=([^\]]+)\]/,
    )?.[1];
    expect(openerRef).toBeDefined();
    if (openerRef === undefined)
      throw new Error(
        "Ambiguous replacement fixture did not expose its opener ref.",
      );

    const page = (controller as unknown as { activePage: Page }).activePage;
    vi.spyOn(
      controller as unknown as {
        activateSelectedPageForInput: (
          ...args: unknown[]
        ) => Promise<SanitizedPageActivationEvidence>;
      },
      "activateSelectedPageForInput",
    ).mockImplementation(async (...args) => {
      const attemptCount = typeof args[1] === "number" ? args[1] : 1;
      if (attemptCount === 1) {
        await page.locator("#opener").evaluate((opener) => {
          const first = opener.cloneNode(true);
          const second = opener.cloneNode(true);
          opener.replaceWith(first, second);
        });
      }
      return {
        attemptCount,
        controllerSelected: true,
        bringToFrontAttempted: attemptCount === 1,
        bringToFrontSucceeded: true,
        visibilityBefore: attemptCount === 1 ? "hidden" : "visible",
        visibilityAfter: "visible",
        documentFocusedBefore: false,
        documentFocusedAfter: true,
        nativeWindow: {
          required: attemptCount === 1,
          attempted: attemptCount === 1,
          supported: true,
          ownedProcessAvailable: true,
          ownedProcessRunning: true,
          targetWindowResolved: true,
          windowStateBefore: "normal",
          normalizationAttempted: false,
          normalizationSucceeded: null,
          applicationActivationAttempted: attemptCount === 1,
          applicationActivationSucceeded: true,
          applicationHiddenBefore: false,
          unhideAttempted: false,
          unhideSucceeded: null,
          activationRequestAccepted: true,
          frontProcessFallbackAttempted: false,
          frontProcessFallbackProcessResolved: null,
          frontProcessFallbackRequestSucceeded: null,
          applicationFrontmostAfter: true,
          applicationHiddenAfter: false,
          result: attemptCount === 1 ? "activated" : "not_required",
        },
      };
    });

    await expect(
      controller.clickRef({
        snapshotId: observed.snapshotId,
        ref: openerRef,
        frameId: null,
        postcondition: null,
        timeoutMs: 3_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "AMBIGUOUS_TARGET",
      details: {
        reason: "reference_semantic_rebind_ambiguous",
        actionDispatched: false,
        clickDispatched: false,
      },
    });
    await expect(page.locator("#counter").textContent()).resolves.toBe(
      "clicks:0",
    );
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_ref",
      outcome: "blocked",
      reason: "ambiguous_target",
      actionDispatched: false,
      clickDispatched: false,
    });
  });

  it("hit-tests the visible clipped portion of a target inside an overflow container", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Clipped actionability</title><style>
        #dialog { position: relative; width: 320px; height: 80px; overflow: hidden; }
        #target { position: absolute; top: 60px; left: 10px; width: 180px; height: 100px; }
      </style></head><body>
        <div id="dialog" role="dialog" aria-label="Business details">
          <button id="target" type="button">Visible clipped control</button>
        </div>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-clipped-target-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const page = (controller as unknown as { activePage: Page }).activePage;
    const state = await inspectTargetState(page.locator("#target") as Locator);
    expect(state).toMatchObject({
      visible: true,
      enabled: true,
      inViewport: true,
      receivesPointerEvents: true,
      pointerHitPoint: "center",
      coveredBy: null,
    });
  });

  it("recaptures a suspiciously uniform screenshot when semantic content exists", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Uniform canvas</title><style>
        html, body { margin: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
        canvas { display: block; width: 1px; height: 1px; }
      </style></head><body><canvas aria-label="Managed render surface"></canvas></body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-uniform-capture-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const screenshot = await controller.screenshot({
      fullPage: false,
      timeoutMs: 5_000,
    });
    expect(screenshot.captureEvidence).toMatchObject({
      artifactClassification: "possibly_uniform",
      semanticContentPresent: true,
      retryUsed: true,
      pageActivation: {
        controllerSelected: true,
        visibilityAfter: "visible",
      },
    });
  });

  it("keeps an auxiliary player from stealing the active tab and recovers the sole remaining tab", async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (request.url === "/player") {
        response.end(`<!doctype html><html><head><title>Embedded player</title></head><body>
          <h1>YouTube player</h1>
          <script>setTimeout(() => window.close(), 150)</script>
        </body></html>`);
        return;
      }
      response.end(`<!doctype html><html><head><title>X post</title></head><body>
        <h1>X post verification</h1>
        <button type="button" onclick="window.open('/player', 'youtube-player')">Open player</button>
      </body></html>`);
    });
    const port = await listen(server);
    const postUrl = `http://127.0.0.1:${port}/post`;

    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-active-tab-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: postUrl,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    await controller.clickByRole({
      role: "button",
      name: "Open player",
      exact: true,
      frameId: null,
      postcondition: null,
      timeoutMs: 5_000,
    });

    const whilePlayerIsOpen = await controller.snapshot({
      depth: 6,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(whilePlayerIsOpen.page.url).toBe(postUrl);
    expect(whilePlayerIsOpen.snapshot).toContain("X post verification");
    expect(whilePlayerIsOpen.snapshot).not.toContain("YouTube player");

    await new Promise((resolve) => setTimeout(resolve, 250));
    const tabs = await controller.tabs();
    expect(tabs.pages).toHaveLength(1);
    expect(tabs.pages[0]?.url).toBe(postUrl);
    expect(tabs.activePageIndex).toBe(0);
  });

  it("restores the exact opaque Chromium target instead of choosing among duplicate tabs", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><head><title>Duplicate application</title></head><body>Application</body></html>",
      );
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-target-continuity-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/application`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const firstPage = (controller as unknown as { activePage: Page })
      .activePage;
    await controller.open({
      url: `http://127.0.0.1:${port}/application`,
      newTab: true,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const internals = controller as unknown as {
      activePage: Page;
      nativeControlRecord: NativeControlRecord | null;
      chromiumTargetId: (page: Page) => Promise<string | null>;
      restoreNativeSelectedPage: (pages: Page[]) => Promise<Page | null>;
    };
    const secondPage = internals.activePage;
    const selectedTargetId = await internals.chromiumTargetId(firstPage);
    expect(selectedTargetId).not.toBeNull();
    internals.nativeControlRecord = {
      version: 1,
      kind: "chromium_cdp",
      browser: "chromium",
      state: "controlled",
      processId: process.pid,
      port: 29_123,
      createdAt: "2026-08-25T00:00:00.000Z",
      selectedTargetId,
    };

    await expect(
      internals.restoreNativeSelectedPage([secondPage, firstPage]),
    ).resolves.toBe(firstPage);
  });

  it("returns bounded unique rendered-line context around text matches", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Noisy social feed</title></head><body>
        <nav>Management navigation</nav>
        <article>
          <h2>Concise Korean video title</h2>
          <blockquote>Repeated quoted context</blockquote>
          <blockquote>Repeated quoted context</blockquote>
          <blockquote>Repeated quoted context</blockquote>
          <p>The Economist interview excerpt</p>
          <a href="https://example.com/post/123">Corresponding social post link</a>
          <p>Full thumbnail beneath the link</p>
        </article>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-find-context-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const found = await controller.findText({
      query: "Economist",
      mode: "contains",
      caseSensitive: false,
      maxResults: 10,
      frameId: null,
      timeoutMs: 5_000,
    });

    expect(found).toMatchObject({
      matchCount: 1,
      returnedCount: 1,
      truncated: false,
    });
    const snippet = found.matches[0]?.snippet ?? "";
    expect(snippet.split("\n")).toHaveLength(5);
    expect(snippet).toContain("Concise Korean video title");
    expect(snippet).toContain("Repeated quoted context");
    expect(snippet.match(/Repeated quoted context/g)).toHaveLength(1);
    expect(snippet).toMatch(/> \d+: The Economist interview excerpt/);
    expect(snippet).toContain("Corresponding social post link");
    expect(snippet).toContain("Full thumbnail beneath the link");
  });
});
