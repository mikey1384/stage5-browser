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

describe("BrowserController virtualization and guarded dispatch fallbacks", () => {
  it("incrementally scrolls to fresh refs, safely rebinds virtualization, and fails closed", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Offscreen references</title><style>
        body { margin: 0; }
        #spacer { height: 2200px; }
        #impossible { position: fixed; top: 2000px; left: 10px; }
      </style></head><body>
        <button id="impossible" type="button">Impossible action</button>
        <article id="virtualized-post">
          <h2>Known virtualized post</h2>
          <div id="spacer"></div>
          <button type="button" onclick="void 0">See more</button>
          <a id="expanded" href="#expanded" hidden>Expanded caption</a>
        </article>
        <script>
          let replaced = false;
          addEventListener('scroll', () => {
            if (replaced) return;
            replaced = true;
            const current = document.querySelector('#virtualized-post');
            const replacement = current.cloneNode(true);
            replacement.querySelector('button').setAttribute(
              'onclick',
              "document.querySelector('#expanded').hidden = false",
            );
            current.replaceWith(replacement);
          }, { passive: true });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-offscreen-ref-"),
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
        "Fixture did not expose the offscreen See more reference.",
      );
    }
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
            name: "Expanded caption",
            exact: true,
            frameId: null,
          },
          timeoutMs: 1_000,
        },
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ postcondition: { passed: true } });
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_ref",
      outcome: "succeeded",
      actionDispatched: true,
      clickDispatched: true,
      targetState: { inViewport: true },
    });

    const impossibleObservation = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    const impossibleLine = impossibleObservation.snapshot
      .split("\n")
      .find((line) => line.includes("Impossible action"));
    const impossibleRef = impossibleLine?.match(/\[ref=([^\]]+)\]/)?.[1];
    expect(impossibleRef).toBeDefined();
    if (impossibleRef === undefined) {
      throw new Error(
        "Fixture did not expose the impossible offscreen reference.",
      );
    }
    const failedAt = Date.now();
    await expect(
      controller.clickRef({
        snapshotId: impossibleObservation.snapshotId,
        ref: impossibleRef,
        frameId: null,
        postcondition: null,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "OPERATION_FAILED",
      details: {
        actionDispatched: false,
        clickDispatched: false,
        targetState: { inViewport: false },
      },
    });
    expect(Date.now() - failedAt).toBeLessThan(3_000);
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_ref",
      outcome: "blocked",
      actionDispatched: false,
      clickDispatched: false,
      targetState: { inViewport: false },
    });
    await expect(
      controller.clickRef({
        snapshotId: impossibleObservation.snapshotId,
        ref: impossibleRef,
        frameId: null,
        postcondition: null,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "TARGET_NOT_FOUND",
      details: { reason: "stale_or_unknown_snapshot" },
    });
  });

  it("rejects ambiguous article-scoped replacements after feed virtualization", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Ambiguous virtualization</title><style>
        body { margin: 0; }
        .spacer { height: 2200px; }
      </style></head><body>
        <article id="virtualized-post">
          <h2>Duplicated virtualized post</h2>
          <div class="spacer"></div>
          <button type="button">See more</button>
        </article>
        <script>
          let replaced = false;
          addEventListener('scroll', () => {
            if (replaced) return;
            replaced = true;
            const current = document.querySelector('#virtualized-post');
            current.replaceWith(current.cloneNode(true), current.cloneNode(true));
          }, { passive: true });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-ambiguous-ref-"),
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
        "Fixture did not expose the ambiguous offscreen reference.",
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
      code: "AMBIGUOUS_TARGET",
      details: {
        reason: "virtualized_target_rebind_ambiguous",
        actionDispatched: false,
        clickDispatched: false,
      },
    });
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_ref",
      outcome: "blocked",
      reason: "ambiguous_target",
      actionDispatched: false,
      clickDispatched: false,
    });
  });

  it("uses a guarded forced dispatch only after proving the stable-click attempt emitted no event", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Animated exact target</title><style>
        @keyframes continuous-motion {
          from { transform: translateX(0); }
          to { transform: translateX(40px); }
        }
        #moving-target {
          animation: continuous-motion 100ms linear infinite alternate;
          margin: 100px;
          width: 240px;
          height: 48px;
        }
      </style></head><body>
        <div id="moving-target" role="button" tabindex="0"
          onclick="document.querySelector('#expanded').hidden = false">See more</div>
        <a id="expanded" href="#expanded" hidden>Expanded moving caption</a>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-guarded-dispatch-"),
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
        "Fixture did not expose the moving exact-target reference.",
      );
    }

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
            name: "Expanded moving caption",
            exact: true,
            frameId: null,
          },
          timeoutMs: 1_000,
        },
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ postcondition: { passed: true } });
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_ref",
      outcome: "succeeded",
      actionDispatched: true,
      clickDispatched: true,
      dispatchEvidence: {
        strategy: "guarded_exact_handle",
        forcedFallbackUsed: true,
        guardExpired: false,
        targetConnectedBefore: true,
        targetConnectedAtFirstEvent: true,
        targetConnectedAfter: true,
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
});
