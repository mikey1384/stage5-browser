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

describe("BrowserController semantic loader and feed observation", () => {
  it("scopes document loader waits to the visible semantic feed", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Scoped feed wait</title><style>
        body { margin: 0; }
        #unrelated { position: fixed; top: 5px; right: 5px; width: 80px; height: 20px; }
        #feed-spacer { height: 800px; }
        #feed-loader { width: 120px; height: 20px; }
        #tail { height: 900px; }
      </style></head><body>
        <nav><div id="unrelated" role="progressbar" aria-label="Unrelated management loading"></div></nav>
        <section role="feed" aria-label="Posts">
          <article>Already rendered post</article>
          <div id="feed-spacer"></div>
          <div id="feed-loader" role="progressbar" aria-label="Loading more posts"></div>
          <div id="tail"></div>
        </section>
        <script>
          let scheduled = false;
          addEventListener('scroll', () => {
            if (scheduled) return;
            scheduled = true;
            setTimeout(() => document.querySelector('#feed-loader')?.remove(), 150);
          });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-scoped-feed-wait-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const scrolled = await controller.scroll({
      direction: "down",
      amount: "viewport",
      count: 1,
      settleMs: 0,
      frameId: null,
      endMarker: null,
      target: null,
      waitFor: { condition: "loading_indicators_disappear", timeoutMs: 1_000 },
      timeoutMs: 5_000,
    });
    expect(scrolled.wait).toMatchObject({
      requested: true,
      satisfied: true,
      evidence: "loading_indicators_disappeared",
      before: { articleCount: 1, loadingIndicatorCount: 1 },
      after: { articleCount: 1, loadingIndicatorCount: 0 },
    });
    expect(scrolled.warnings).not.toContainEqual(
      expect.objectContaining({ code: "content_wait_timed_out" }),
    );
  });

  it("pins feed observation scope and treats loading-only status articles as unresolved placeholders", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Stable loading observation</title><style>
        body { margin: 0; min-height: 1800px; }
        #placeholders { position: fixed; top: 20px; left: 20px; width: 320px; }
        #late-feed { position: fixed; top: 180px; left: 20px; width: 320px; height: 120px; }
      </style></head><body>
        <section id="placeholders" aria-label="Other posts">
          <article>
            <span hidden>Cached post text</span>
            <button aria-hidden="true" style="display:none">Hidden template action</button>
            <div role="status">Loading...</div>
          </article>
          <article>
            <span aria-hidden="true">Assistive placeholder text</span>
            <div role="status">Loading...</div>
          </article>
        </section>
        <section id="late-feed" aria-label="Unrelated feed"></section>
        <script>
          addEventListener('scroll', () => {
            document.querySelector('#late-feed')?.setAttribute('role', 'feed');
          }, { once: true });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-stable-loading-observation-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const scrolled = await controller.scroll({
      direction: "down",
      amount: "half_viewport",
      count: 1,
      settleMs: 0,
      frameId: null,
      endMarker: null,
      target: null,
      waitFor: { condition: "article_count_growth", timeoutMs: 1_000 },
      timeoutMs: 1_000,
    });

    expect(scrolled.wait).toMatchObject({
      requested: true,
      satisfied: false,
      evidence: "timeout",
      before: { articleCount: 0, loadingIndicatorCount: 2 },
      after: { articleCount: 0, loadingIndicatorCount: 2 },
    });
    expect(scrolled).toMatchObject({ stepsCompleted: 1, moved: true });
    expect(scrolled.wait.waitedMs).toBeLessThan(900);
    expect(scrolled.warnings).toContainEqual(
      expect.objectContaining({ code: "content_wait_timed_out" }),
    );
  });

  it("does not treat an in-post status as a feed loader when the article has substantive content", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Substantive post status</title><style>
        body { margin: 0; min-height: 1800px; }
      </style></head><body>
        <section role="feed" aria-label="Posts">
          <article><p>Rendered Stage5 post</p><div role="status">Loading comments...</div></article>
        </section>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-substantive-post-status-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const scrolled = await controller.scroll({
      direction: "down",
      amount: "half_viewport",
      count: 1,
      settleMs: 0,
      frameId: null,
      endMarker: null,
      target: null,
      waitFor: { condition: "loading_indicators_disappear", timeoutMs: 150 },
      timeoutMs: 5_000,
    });
    expect(scrolled.wait).toMatchObject({
      satisfied: false,
      evidence: "timeout",
      before: { articleCount: 1, loadingIndicatorCount: 0 },
      after: { articleCount: 1, loadingIndicatorCount: 0 },
    });
  });

  it("fails closed before dispatch when a scroll observation would truncate semantic candidates", async () => {
    const articles = Array.from(
      { length: 501 },
      (_, index) => `<article>Rendered post ${index + 1}</article>`,
    ).join("");
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Bounded feed observation</title><style>
        body { margin: 0; min-height: 1800px; }
        [role="feed"] { position: fixed; inset: 0; overflow: hidden; }
      </style></head><body><section role="feed" aria-label="Posts">${articles}</section></body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-bounded-feed-observation-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const internals = controller as unknown as {
      performScrollStep: (...args: unknown[]) => Promise<void>;
    };
    const performScrollStep = vi.spyOn(internals, "performScrollStep");
    await expect(
      controller.scroll({
        direction: "down",
        amount: "half_viewport",
        count: 1,
        settleMs: 0,
        frameId: null,
        endMarker: null,
        target: null,
        waitFor: { condition: "article_count_growth", timeoutMs: 1_000 },
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "OPERATION_FAILED",
      details: {
        reason: "scroll_observation_incomplete",
        actionDispatched: false,
        stepsCompleted: 0,
      },
    });
    expect(performScrollStep).not.toHaveBeenCalled();
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "scroll",
      outcome: "blocked",
      reason: "unknown",
      actionDispatched: false,
      clickDispatched: null,
    });
  });
});
