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

import type { BrowserContext, ElementHandle, Frame, Locator, Page } from "playwright";
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

describe("BrowserController frame control, profile ownership, and reattachment", () => {
  it("settles transient CDP discovery against the exact retained native target", async () => {
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-target-settle-"),
    );
    const config = browserConfig(temporaryRoot);
    config.readinessTimeoutMs = 10;
    controller = new BrowserController(config);
    const internals = controller as unknown as {
      nativeControlRecord: NativeControlRecord | null;
      settleNativeSelectedPage: (context: BrowserContext) => Promise<{
        page: Page | null;
        observation: {
          resolution: string;
          selectedTargetInitiallyObserved: boolean | null;
          selectedTargetObserved: boolean | null;
          discoveryWaitAttempted: boolean;
          discoveryWaitMs: number;
        } | null;
      }>;
    };
    internals.nativeControlRecord = {
      version: 1,
      kind: "chromium_cdp",
      browser: "chromium",
      state: "controlled",
      processId: 42_424,
      port: 29_123,
      createdAt: "2026-08-27T04:00:00.000Z",
      selectedTargetId: "exact-fixture-target",
    };

    let targetProbeCount = 0;
    let exactPage: Page;
    const session = {
      send: vi.fn(async () => {
        targetProbeCount += 1;
        if (targetProbeCount === 1) throw new Error("Transient target discovery miss");
        return { targetInfo: { targetId: "exact-fixture-target" } };
      }),
      detach: vi.fn(async () => undefined),
    };
    const context = {
      pages: vi.fn(() => [exactPage]),
      newCDPSession: vi.fn(async () => session),
    } as unknown as BrowserContext;
    exactPage = {
      context: () => context,
      isClosed: () => false,
    } as unknown as Page;

    const settled = await internals.settleNativeSelectedPage(context);

    expect(settled.page).toBe(exactPage);
    expect(settled.observation).toMatchObject({
      resolution: "settled_exact",
      selectedTargetInitiallyObserved: false,
      selectedTargetObserved: true,
      discoveryWaitAttempted: true,
    });
    expect(settled.observation?.discoveryWaitMs).toBeGreaterThan(0);
    expect(targetProbeCount).toBe(2);
  });

  it("inspects and acts inside an observed cross-origin frame without coordinate guessing", async () => {
    frameServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><body>
        <h2>Embedded Groove Lab</h2>
        <label for="song">Song name</label><input id="song" />
        <button type="button" onclick="document.querySelector('#result').textContent='Frame clicked'">
          Download Boss Battle
        </button>
        <p id="result"></p>
      </body></html>`);
    });
    const framePort = await listen(frameServer);

    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Frame host</title></head><body>
        <h1>Outer application</h1>
        <iframe name="groove-lab" src="http://127.0.0.1:${framePort}/embedded?token=secret#fragment"></iframe>
      </body></html>`);
    });
    const hostPort = await listen(server);

    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-frame-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    for (const [index, browser] of (
      ["chromium", "firefox", "webkit"] as const
    ).entries()) {
      if (index > 0) {
        await controller.switchBrowser({ browser });
      }
      await controller.open({
        url: `http://127.0.0.1:${hostPort}/host`,
        newTab: false,
        timeoutMs: 5_000,
      });

      const inventory = await controller.frames();
      const embedded = inventory.frames.find(
        (frame) => frame.name === "groove-lab",
      );
      expect(embedded).toBeDefined();
      expect(embedded?.url).toBe(`http://127.0.0.1:${framePort}/embedded`);
      if (embedded === undefined) {
        throw new Error(
          `Cross-origin fixture frame was not observed in ${browser}.`,
        );
      }

      const snapshot = await controller.snapshot({
        depth: 8,
        boxes: false,
        frameId: embedded.id,
        timeoutMs: 5_000,
      });
      expect(snapshot.snapshot).toContain("Embedded Groove Lab");

      await controller.fillByRole({
        role: "textbox",
        name: "Song name",
        exact: true,
        frameId: embedded.id,
        value: "Boss Battle",
        timeoutMs: 5_000,
      });
      await controller.clickByRole({
        role: "button",
        name: "Download Boss Battle",
        exact: true,
        frameId: embedded.id,
        postcondition: null,
        timeoutMs: 5_000,
      });

      const after = await controller.snapshot({
        depth: 8,
        boxes: false,
        frameId: embedded.id,
        timeoutMs: 5_000,
      });
      expect(after.snapshot).toContain("Frame clicked");

      await controller.open({
        url: "about:blank",
        newTab: false,
        timeoutMs: 5_000,
      });
      await expect(
        controller.snapshot({
          depth: 8,
          boxes: false,
          frameId: embedded.id,
          timeoutMs: 5_000,
        }),
      ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
        code: "TARGET_NOT_FOUND",
      });
    }
  });

  it("reports sanitized lock-owner evidence and fails closed when automatic reattachment is unproven", async () => {
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-owned-lock-"),
    );
    const config = browserConfig(temporaryRoot);
    config.readinessTimeoutMs = 10;
    await mkdir(config.profileDir, { recursive: true });
    await writeFile(
      path.join(config.profileDir, "SingletonLock"),
      "owned-browser-fixture",
    );
    const inspectOwner = vi.fn(async () => ({
      evidence: {
        classification: "dedicated_browser_control_unavailable" as const,
        ownership: "proven" as const,
        lockOwnerProcess: "running" as const,
        expectedApplication: "Chromium",
        applicationIdentity: "matched" as const,
        loopbackControl: "absent" as const,
        authenticationHandoff: "unverified" as const,
        recovery: "close_dedicated_browser_normally" as const,
        suggestedAction:
          "Close only the dedicated Chromium application normally, then retry once.",
      },
      reconnectRecord: null,
      handoffRecord: null,
    }));
    controller = new BrowserController(
      config,
      config.browser,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      inspectOwner,
    );

    const stopped = await controller.status();
    expect(stopped).toMatchObject({
      state: "stopped",
      profileLockState: "possible_external_owner",
      profileOwner: {
        classification: "dedicated_browser_control_unavailable",
        ownership: "proven",
        expectedApplication: "Chromium",
        recovery: "close_dedicated_browser_normally",
      },
    });
    await expect(controller.start()).rejects.toMatchObject<
      Partial<Stage5BrowserError>
    >({
      code: "BROWSER_NOT_READY",
      details: {
        reason: "profile_locked",
        ownershipReason: "dedicated_browser_control_unavailable",
        profileOwner: {
          loopbackControl: "absent",
          recovery: "close_dedicated_browser_normally",
        },
        suggestedAction:
          "Close only the dedicated Chromium application normally, then retry once.",
      },
    });
    const diagnostic = await controller.diagnostics();
    expect(diagnostic.profileOwner).toMatchObject({
      classification: "dedicated_browser_control_unavailable",
      ownership: "proven",
      lockOwnerProcess: "running",
      applicationIdentity: "matched",
    });
    expect(inspectOwner).toHaveBeenCalled();
  });

  it("reattaches through a reconstructed exact owned-process capability instead of launching into a lock", async () => {
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-reconnect-lock-"),
    );
    const config = browserConfig(temporaryRoot);
    config.readinessTimeoutMs = 10;
    await mkdir(config.profileDir, { recursive: true });
    await writeFile(
      path.join(config.profileDir, "SingletonLock"),
      "owned-browser-fixture",
    );
    const reconnectRecord: NativeControlRecord = {
      version: 1,
      kind: "chromium_cdp",
      browser: "chromium",
      state: "controlled",
      processId: 42_424,
      port: 29_123,
      createdAt: "2026-08-25T04:00:00.000Z",
    };
    const inspectOwner = vi.fn(async () => ({
      evidence: {
        classification: "reconnectable_stage5_browser" as const,
        ownership: "proven" as const,
        lockOwnerProcess: "running" as const,
        expectedApplication: "Google Chrome for Testing",
        applicationIdentity: "matched" as const,
        loopbackControl: "available" as const,
        authenticationHandoff: "absent" as const,
        recovery: "automatic_reattach" as const,
        suggestedAction: "Stage5 Browser can safely reattach automatically.",
      },
      reconnectRecord,
      handoffRecord: null,
    }));
    controller = new BrowserController(
      config,
      config.browser,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      inspectOwner,
    );
    const internals = controller as unknown as {
      attachToNativeChromium: (
        record: NativeControlRecord,
        identity: BrowserLaunchIdentity,
        targetOrigin: string | null,
      ) => Promise<BrowserStatus>;
    };
    const attach = vi
      .spyOn(internals, "attachToNativeChromium")
      .mockImplementation(async (_record, identity) => ({
        browser: "chromium",
        state: "running",
        workerPid: process.pid,
        browserConnected: true,
        pages: [],
        activePageIndex: null,
        lastKnownUrl: null,
        launchIdentity: identity,
        runtimeProfile: null,
        profileLockState: "owned_browser_running",
        profileLockFiles: ["SingletonLock"],
        profileOwner: {
          classification: "owned_active",
          ownership: "proven",
          lockOwnerProcess: "running",
          expectedApplication: identity.applicationName,
          applicationIdentity: "matched",
          loopbackControl: "available",
          authenticationHandoff: "absent",
          recovery: "none",
          suggestedAction: null,
        },
      }));

    await expect(controller.start()).resolves.toMatchObject({
      state: "running",
      browserConnected: true,
      profileOwner: { classification: "owned_active" },
    });
    expect(attach).toHaveBeenCalledWith(
      reconnectRecord,
      expect.objectContaining({
        browser: "chromium",
        profile: expect.objectContaining({
          userDataDir: config.profileDir,
          profileDirectory: "Default",
        }),
      }),
      null,
    );
  });
});
