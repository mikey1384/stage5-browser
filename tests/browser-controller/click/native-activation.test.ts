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

describe("BrowserController owned native activation and terminal blocking", () => {
  it("activates the selected page and uses page mouse only after both handle paths emit zero events", async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (request.url === "/auxiliary") {
        response.end(
          "<!doctype html><html><head><title>Auxiliary tab</title></head><body>Auxiliary</body></html>",
        );
        return;
      }
      response.end(`<!doctype html><html><head><title>Foreground dispatch target</title></head><body>
        <button type="button" onclick="window.open('/auxiliary', 'auxiliary')">Open auxiliary</button>
        <div id="target" role="button" tabindex="0"
          onclick="document.querySelector('#expanded').hidden = false">See more</div>
        <a id="expanded" href="#expanded" hidden>Expanded foreground caption</a>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-page-mouse-dispatch-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/post`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    await controller.clickByRole({
      role: "button",
      name: "Open auxiliary",
      exact: true,
      frameId: null,
      postcondition: null,
      timeoutMs: 5_000,
    });

    const observed = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    const seeMoreLine = observed.snapshot
      .split("\n")
      .find((line) => line.includes("See more"));
    const seeMoreRef = seeMoreLine?.match(/\[ref=([^\]]+)\]/)?.[1];
    expect(seeMoreRef).toBeDefined();
    if (seeMoreRef === undefined) {
      throw new Error(
        "Fixture did not expose the foreground exact-target reference.",
      );
    }

    const exactHandleDispatch = vi.spyOn(
      controller as unknown as {
        dispatchExactHandleClick: () => Promise<void>;
      },
      "dispatchExactHandleClick",
    );
    exactHandleDispatch
      .mockRejectedValueOnce(
        new Error(
          "Timeout 750ms exceeded while waiting for element stability.",
        ),
      )
      .mockRejectedValueOnce(
        new Error(
          "The forced exact-handle transport returned without an event.",
        ),
      );

    await expect(
      controller.clickRef({
        snapshotId: observed.snapshotId,
        ref: seeMoreRef,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: null,
          expectedVisible: {
            role: "link",
            name: "Expanded foreground caption",
            exact: true,
            frameId: null,
          },
          timeoutMs: 1_000,
        },
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ postcondition: { passed: true } });
    expect(exactHandleDispatch).toHaveBeenCalledTimes(2);
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_ref",
      outcome: "succeeded",
      actionDispatched: true,
      clickDispatched: true,
      dispatchEvidence: {
        strategy: "guarded_exact_handle",
        forcedFallbackUsed: true,
        pageMouseFallbackUsed: true,
        pageActivation: {
          attemptCount: 1,
          controllerSelected: true,
          bringToFrontAttempted: false,
          bringToFrontSucceeded: false,
          visibilityAfter: "visible",
          documentFocusedAfter: true,
        },
        guardExpired: false,
        trustedEventObserved: true,
        pointerDownOnTarget: true,
        mouseDownOnTarget: true,
        pointerUpOnTarget: true,
        mouseUpOnTarget: true,
        clickOnTarget: true,
        misdirectedEventBlocked: false,
        targetStateChangeBlocked: false,
      },
    });
  });

  it("restores the exact owned Chromium window before dispatch when the selected page stays hidden", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Native activation target</title></head><body>
        <button id="target" type="button"
          onclick="document.querySelector('#expanded').hidden = false">See more</button>
        <a id="expanded" href="#expanded" hidden>Expanded after native activation</a>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-native-activation-"),
    );
    const config = browserConfig(temporaryRoot);
    let nativeApplicationActivated = false;
    const activateOwnedProcess = vi.fn(async () => {
      nativeApplicationActivated = true;
      return {
        attempted: true,
        supported: true,
        ownedProcessRunning: true,
        applicationActivated: false,
        applicationHiddenBefore: true,
        unhideAttempted: true,
        unhideSucceeded: true,
        activationRequestAccepted: true,
        frontProcessFallbackAttempted: true,
        frontProcessFallbackProcessResolved: true,
        frontProcessFallbackRequestSucceeded: true,
        applicationFrontmostAfter: false,
        applicationHiddenAfter: false,
        reason: "activation_state_unverified" as const,
      };
    });
    const activator: OwnedBrowserWindowActivator = {
      supported: true,
      activateOwnedProcess,
    };
    controller = new BrowserController(
      config,
      config.browser,
      undefined,
      undefined,
      undefined,
      undefined,
      activator,
    );
    await controller.open({
      url: `http://127.0.0.1:${port}/post`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    const seeMoreRef = observed.snapshot
      .split("\n")
      .find((line) => line.includes("See more"))
      ?.match(/\[ref=([^\]]+)\]/)?.[1];
    expect(seeMoreRef).toBeDefined();
    if (seeMoreRef === undefined) {
      throw new Error(
        "Fixture did not expose the native-activation target reference.",
      );
    }

    config.headless = false;
    const internals = controller as unknown as {
      controlledBrowserProcessId: number | null;
      observePageActivation: () => Promise<{
        documentFocused: boolean | null;
        visibility: "hidden" | "prerender" | "unknown" | "visible";
      }>;
      prepareChromiumTargetWindow: () => Promise<{
        targetWindowResolved: boolean;
        windowStateBefore:
          | "fullscreen"
          | "maximized"
          | "minimized"
          | "normal"
          | "unknown";
        normalizationAttempted: boolean;
        normalizationSucceeded: boolean | null;
      }>;
    };
    internals.controlledBrowserProcessId = 42_424;
    vi.spyOn(internals, "observePageActivation").mockImplementation(
      async () => ({
        documentFocused: true,
        visibility: nativeApplicationActivated ? "visible" : "hidden",
      }),
    );
    const prepareWindow = vi
      .spyOn(internals, "prepareChromiumTargetWindow")
      .mockResolvedValue({
        targetWindowResolved: true,
        windowStateBefore: "minimized",
        normalizationAttempted: true,
        normalizationSucceeded: true,
      });

    await expect(
      controller.clickRef({
        snapshotId: observed.snapshotId,
        ref: seeMoreRef,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: null,
          expectedVisible: {
            role: "link",
            name: "Expanded after native activation",
            exact: true,
            frameId: null,
          },
          timeoutMs: 1_000,
        },
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ postcondition: { passed: true } });
    expect(prepareWindow).toHaveBeenCalledTimes(1);
    expect(activateOwnedProcess).toHaveBeenCalledWith(42_424, 1_000);
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_ref",
      outcome: "succeeded",
      actionDispatched: true,
      dispatchEvidence: {
        pageActivation: {
          visibilityBefore: "hidden",
          visibilityAfter: "visible",
          nativeWindow: {
            required: true,
            attempted: true,
            ownedProcessAvailable: true,
            ownedProcessRunning: true,
            targetWindowResolved: true,
            windowStateBefore: "minimized",
            normalizationAttempted: true,
            normalizationSucceeded: true,
            applicationActivationAttempted: true,
            applicationActivationSucceeded: false,
            activationRequestAccepted: true,
            frontProcessFallbackAttempted: true,
            frontProcessFallbackProcessResolved: true,
            frontProcessFallbackRequestSucceeded: true,
            applicationFrontmostAfter: false,
            result: "activated",
          },
        },
      },
    });
  });

  it("dispatches no input when native activation cannot make the selected page visible", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Hidden native target</title></head><body>
        <button id="target" type="button"
          onclick="document.querySelector('#danger').hidden = false">See more</button>
        <p id="danger" hidden>Input was dispatched</p>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-native-hidden-"),
    );
    const config = browserConfig(temporaryRoot);
    const activateOwnedProcess = vi.fn(async () => ({
      attempted: true,
      supported: true,
      ownedProcessRunning: true,
      applicationActivated: true,
      applicationHiddenBefore: false,
      unhideAttempted: false,
      unhideSucceeded: null,
      activationRequestAccepted: true,
      frontProcessFallbackAttempted: false,
      frontProcessFallbackProcessResolved: null,
      frontProcessFallbackRequestSucceeded: null,
      applicationFrontmostAfter: true,
      applicationHiddenAfter: false,
      reason: "activated" as const,
    }));
    controller = new BrowserController(
      config,
      config.browser,
      undefined,
      undefined,
      undefined,
      undefined,
      { supported: true, activateOwnedProcess },
    );
    await controller.open({
      url: `http://127.0.0.1:${port}/post`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    const seeMoreRef = observed.snapshot
      .split("\n")
      .find((line) => line.includes("See more"))
      ?.match(/\[ref=([^\]]+)\]/)?.[1];
    expect(seeMoreRef).toBeDefined();
    if (seeMoreRef === undefined) {
      throw new Error(
        "Fixture did not expose the hidden native target reference.",
      );
    }

    config.headless = false;
    const internals = controller as unknown as {
      controlledBrowserProcessId: number | null;
      observePageActivation: () => Promise<{
        documentFocused: boolean | null;
        visibility: "hidden" | "prerender" | "unknown" | "visible";
      }>;
      prepareChromiumTargetWindow: () => Promise<{
        targetWindowResolved: boolean;
        windowStateBefore:
          | "fullscreen"
          | "maximized"
          | "minimized"
          | "normal"
          | "unknown";
        normalizationAttempted: boolean;
        normalizationSucceeded: boolean | null;
      }>;
    };
    internals.controlledBrowserProcessId = 42_424;
    vi.spyOn(internals, "observePageActivation").mockResolvedValue({
      documentFocused: true,
      visibility: "hidden",
    });
    vi.spyOn(internals, "prepareChromiumTargetWindow").mockResolvedValue({
      targetWindowResolved: true,
      windowStateBefore: "normal",
      normalizationAttempted: false,
      normalizationSucceeded: null,
    });

    await expect(
      controller.clickRef({
        snapshotId: observed.snapshotId,
        ref: seeMoreRef,
        frameId: null,
        postcondition: null,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "OPERATION_FAILED",
      details: {
        reason: "page_not_active",
        actionDispatched: false,
        clickDispatched: false,
        pageActivation: {
          visibilityAfter: "hidden",
          nativeWindow: {
            applicationActivationSucceeded: true,
            frontProcessFallbackAttempted: false,
            result: "visibility_unchanged",
          },
        },
      },
    });
    expect(activateOwnedProcess).toHaveBeenCalledTimes(1);
    const rendered = await controller.findText({
      query: "Input was dispatched",
      mode: "contains",
      caseSensitive: false,
      maxResults: 10,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(rendered.matchCount).toBe(0);
  });

  it("does not force a click when the exact target detaches before pointer dispatch", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Detached dispatch target</title><style>
        @keyframes continuous-motion {
          from { transform: translateX(0); }
          to { transform: translateX(40px); }
        }
        #unstable-target {
          animation: continuous-motion 100ms linear infinite alternate;
          margin: 100px;
          width: 240px;
          height: 48px;
        }
      </style></head><body>
        <div id="unstable-target" role="button" tabindex="0">See more</div>
        <p id="danger" hidden>Replacement was clicked</p>
        <script>
          const nativeAddEventListener = window.addEventListener.bind(window);
          let dispatchProbeObserved = false;
          window.addEventListener = function(type, listener, options) {
            nativeAddEventListener(type, listener, options);
            if (!dispatchProbeObserved && type === 'pointerdown') {
              dispatchProbeObserved = true;
              setTimeout(() => {
                const current = document.querySelector('#unstable-target');
                const replacement = current.cloneNode(true);
                replacement.removeAttribute('style');
                replacement.setAttribute(
                  'onclick',
                  "document.querySelector('#danger').hidden = false",
                );
                current.replaceWith(replacement);
              }, 50);
            }
          };
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-detached-dispatch-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/post`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const observed = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    const seeMoreLine = observed.snapshot
      .split("\n")
      .find((line) => line.includes("See more"));
    const seeMoreRef = seeMoreLine?.match(/\[ref=([^\]]+)\]/)?.[1];
    expect(seeMoreRef).toBeDefined();
    if (seeMoreRef === undefined) {
      throw new Error(
        "Fixture did not expose the detachable exact-target reference.",
      );
    }

    await expect(
      controller.clickRef({
        snapshotId: observed.snapshotId,
        ref: seeMoreRef,
        frameId: null,
        postcondition: null,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "OPERATION_FAILED",
      details: {
        reason: "detached",
        actionDispatched: false,
        clickDispatched: false,
        dispatchEvidence: {
          strategy: "guarded_exact_handle",
          forcedFallbackUsed: false,
          targetConnectedBefore: true,
          targetConnectedAfter: false,
          trustedEventObserved: false,
          clickOnTarget: false,
        },
      },
    });
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_ref",
      outcome: "blocked",
      reason: "detached",
      actionDispatched: false,
      clickDispatched: false,
      dispatchEvidence: {
        forcedFallbackUsed: false,
        targetConnectedAfter: false,
        trustedEventObserved: false,
      },
    });
    const rendered = await controller.findText({
      query: "Replacement was clicked",
      mode: "contains",
      caseSensitive: false,
      maxResults: 10,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(rendered.matchCount).toBe(0);
  });
});
