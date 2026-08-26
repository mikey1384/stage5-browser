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

describe("BrowserController controller lifecycle and navigation", () => {
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
});
