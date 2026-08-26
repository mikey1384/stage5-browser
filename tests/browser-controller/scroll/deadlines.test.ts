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

describe("BrowserController scroll deadlines, activation, and no replay", () => {
  it("does not dispatch after page activation consumes the remaining scroll action budget", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Activation budget</title><style>
        body { margin: 0; min-height: 1800px; }
      </style></head><body><article>Budgeted scroll</article></body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-scroll-activation-budget-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const nativeWindow = {
      required: false,
      attempted: false,
      supported: false,
      ownedProcessAvailable: false,
      ownedProcessRunning: null,
      targetWindowResolved: null,
      windowStateBefore: "unknown",
      normalizationAttempted: false,
      normalizationSucceeded: null,
      applicationActivationAttempted: false,
      applicationActivationSucceeded: null,
      applicationHiddenBefore: null,
      unhideAttempted: false,
      unhideSucceeded: null,
      activationRequestAccepted: null,
      frontProcessFallbackAttempted: false,
      frontProcessFallbackProcessResolved: null,
      frontProcessFallbackRequestSucceeded: null,
      applicationFrontmostAfter: null,
      applicationHiddenAfter: null,
      result: "not_required",
    };
    const internals = controller as unknown as {
      activateSelectedPageForInput: () => Promise<{
        attemptCount: number;
        controllerSelected: boolean;
        bringToFrontAttempted: boolean;
        bringToFrontSucceeded: boolean;
        visibilityBefore: "visible";
        visibilityAfter: "visible";
        documentFocusedBefore: boolean;
        documentFocusedAfter: boolean;
        nativeWindow: typeof nativeWindow;
      }>;
      performScrollStep: (...args: unknown[]) => Promise<void>;
    };
    const actualNow = Date.now.bind(Date);
    let clockOffsetMs = 0;
    const now = vi
      .spyOn(Date, "now")
      .mockImplementation(() => actualNow() + clockOffsetMs);
    let activationCalls = 0;
    vi.spyOn(internals, "activateSelectedPageForInput").mockImplementation(
      async () => {
        activationCalls += 1;
        if (activationCalls === 2) {
          clockOffsetMs = 4_400;
        }
        return {
          attemptCount: activationCalls,
          controllerSelected: true,
          bringToFrontAttempted: true,
          bringToFrontSucceeded: true,
          visibilityBefore: "visible",
          visibilityAfter: "visible",
          documentFocusedBefore: true,
          documentFocusedAfter: true,
          nativeWindow,
        };
      },
    );
    const performScrollStep = vi.spyOn(internals, "performScrollStep");

    try {
      const result = await controller.scroll({
        direction: "down",
        amount: "half_viewport",
        count: 1,
        settleMs: 0,
        frameId: null,
        endMarker: null,
        target: null,
        waitFor: null,
        timeoutMs: 5_000,
      });
      expect(result.stepsCompleted).toBe(0);
      expect(performScrollStep).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("does not accept content evidence observed after the bounded wait deadline", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Late content observation</title><style>
        body { margin: 0; min-height: 1800px; }
        [role="feed"] { position: fixed; inset: 0; }
      </style></head><body>
        <section role="feed" aria-label="Posts"></section>
        <script>
          addEventListener('scroll', () => {
            document.querySelector('[role="feed"]').innerHTML = '<article>Late rendered post</article>';
          }, { once: true });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-late-content-observation-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const internals = controller as unknown as {
      scrollContentObservation: (
        frame: unknown,
        surface: unknown,
      ) => Promise<unknown>;
    };
    const originalObservation =
      internals.scrollContentObservation.bind(controller);
    const actualNow = Date.now.bind(Date);
    let clockOffsetMs = 0;
    const now = vi
      .spyOn(Date, "now")
      .mockImplementation(() => actualNow() + clockOffsetMs);
    let observationCalls = 0;
    vi.spyOn(internals, "scrollContentObservation").mockImplementation(
      async (frame, surface) => {
        observationCalls += 1;
        const observation = await originalObservation(frame, surface);
        if (observationCalls === 2) {
          clockOffsetMs = 1_500;
          return {
            ...(observation as Record<string, unknown>),
            articleCount: 1,
          };
        }
        return observation;
      },
    );

    try {
      const result = await controller.scroll({
        direction: "down",
        amount: "half_viewport",
        count: 1,
        settleMs: 0,
        frameId: null,
        endMarker: null,
        target: null,
        waitFor: { condition: "article_count_growth", timeoutMs: 1_000 },
        timeoutMs: 5_000,
      });
      expect(result.wait).toMatchObject({
        requested: true,
        satisfied: false,
        evidence: "timeout",
        before: { articleCount: 0 },
        after: { articleCount: 1 },
      });
      expect(result.wait.waitedMs).toBeGreaterThan(1_000);
    } finally {
      now.mockRestore();
    }
  });

  it("fails scroll closed before dispatch when the controller-selected renderer cannot become visible", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Hidden scroll target</title><style>
        body { margin: 0; min-height: 1800px; }
      </style></head><body><article>Never scrolled</article></body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-hidden-scroll-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const internals = controller as unknown as {
      activateSelectedPageForInput: () => Promise<{
        attemptCount: number;
        controllerSelected: boolean;
        bringToFrontAttempted: boolean;
        bringToFrontSucceeded: boolean;
        visibilityBefore: "hidden";
        visibilityAfter: "hidden";
        documentFocusedBefore: boolean;
        documentFocusedAfter: boolean;
        nativeWindow: Record<string, unknown>;
      }>;
      performScrollStep: (...args: unknown[]) => Promise<void>;
      scrollPosition: (...args: unknown[]) => Promise<unknown>;
    };
    vi.spyOn(internals, "activateSelectedPageForInput").mockResolvedValue({
      attemptCount: 1,
      controllerSelected: true,
      bringToFrontAttempted: true,
      bringToFrontSucceeded: true,
      visibilityBefore: "hidden",
      visibilityAfter: "hidden",
      documentFocusedBefore: true,
      documentFocusedAfter: true,
      nativeWindow: {
        required: true,
        attempted: true,
        supported: true,
        ownedProcessAvailable: true,
        ownedProcessRunning: true,
        targetWindowResolved: true,
        windowStateBefore: "normal",
        normalizationAttempted: false,
        normalizationSucceeded: null,
        applicationActivationAttempted: true,
        applicationActivationSucceeded: false,
        applicationHiddenBefore: false,
        unhideAttempted: false,
        unhideSucceeded: null,
        activationRequestAccepted: true,
        frontProcessFallbackAttempted: true,
        frontProcessFallbackProcessResolved: true,
        frontProcessFallbackRequestSucceeded: true,
        applicationFrontmostAfter: false,
        applicationHiddenAfter: false,
        result: "visibility_unchanged",
      },
    });
    const performScrollStep = vi.spyOn(internals, "performScrollStep");
    const scrollPosition = vi.spyOn(internals, "scrollPosition");

    await expect(
      controller.scroll({
        direction: "down",
        amount: "half_viewport",
        count: 1,
        settleMs: 0,
        frameId: null,
        endMarker: null,
        target: null,
        waitFor: null,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "OPERATION_FAILED",
      details: {
        reason: "page_not_active",
        actionDispatched: false,
        stepsCompleted: 0,
        pageActivation: {
          visibilityBefore: "hidden",
          visibilityAfter: "hidden",
        },
      },
    });
    expect(performScrollStep).not.toHaveBeenCalled();
    expect(scrollPosition).not.toHaveBeenCalled();
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "scroll",
      outcome: "blocked",
      reason: "page_not_active",
      actionDispatched: false,
      clickDispatched: null,
    });
  });

  it("does not replay a completed scroll step when renderer visibility is lost before the next step", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Visibility lost between scrolls</title><style>
        body { margin: 0; min-height: 2700px; }
      </style></head><body><article>One bounded step</article></body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-scroll-visibility-loss-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const nativeWindow = {
      required: false,
      attempted: false,
      supported: false,
      ownedProcessAvailable: false,
      ownedProcessRunning: null,
      targetWindowResolved: null,
      windowStateBefore: "unknown",
      normalizationAttempted: false,
      normalizationSucceeded: null,
      applicationActivationAttempted: false,
      applicationActivationSucceeded: null,
      applicationHiddenBefore: null,
      unhideAttempted: false,
      unhideSucceeded: null,
      activationRequestAccepted: null,
      frontProcessFallbackAttempted: false,
      frontProcessFallbackProcessResolved: null,
      frontProcessFallbackRequestSucceeded: null,
      applicationFrontmostAfter: null,
      applicationHiddenAfter: null,
      result: "not_required",
    };
    const internals = controller as unknown as {
      activateSelectedPageForInput: () => Promise<{
        attemptCount: number;
        controllerSelected: boolean;
        bringToFrontAttempted: boolean;
        bringToFrontSucceeded: boolean;
        visibilityBefore: "hidden" | "visible";
        visibilityAfter: "hidden" | "visible";
        documentFocusedBefore: boolean;
        documentFocusedAfter: boolean;
        nativeWindow: typeof nativeWindow;
      }>;
      performScrollStep: (...args: unknown[]) => Promise<void>;
    };
    vi.spyOn(internals, "activateSelectedPageForInput")
      .mockResolvedValueOnce({
        attemptCount: 1,
        controllerSelected: true,
        bringToFrontAttempted: true,
        bringToFrontSucceeded: true,
        visibilityBefore: "visible",
        visibilityAfter: "visible",
        documentFocusedBefore: true,
        documentFocusedAfter: true,
        nativeWindow,
      })
      .mockResolvedValueOnce({
        attemptCount: 2,
        controllerSelected: true,
        bringToFrontAttempted: true,
        bringToFrontSucceeded: true,
        visibilityBefore: "visible",
        visibilityAfter: "visible",
        documentFocusedBefore: true,
        documentFocusedAfter: true,
        nativeWindow,
      })
      .mockResolvedValueOnce({
        attemptCount: 3,
        controllerSelected: true,
        bringToFrontAttempted: true,
        bringToFrontSucceeded: true,
        visibilityBefore: "hidden",
        visibilityAfter: "hidden",
        documentFocusedBefore: true,
        documentFocusedAfter: true,
        nativeWindow,
      });
    const performScrollStep = vi.spyOn(internals, "performScrollStep");

    await expect(
      controller.scroll({
        direction: "down",
        amount: "half_viewport",
        count: 2,
        settleMs: 0,
        frameId: null,
        endMarker: null,
        target: null,
        waitFor: null,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "OPERATION_FAILED",
      details: {
        reason: "page_not_active",
        actionDispatched: true,
        stepsCompleted: 1,
        pageActivation: {
          visibilityAfter: "hidden",
        },
      },
    });
    expect(performScrollStep).toHaveBeenCalledTimes(1);
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "scroll",
      outcome: "failed",
      reason: "page_not_active",
      actionDispatched: true,
      clickDispatched: null,
    });
  });
});
