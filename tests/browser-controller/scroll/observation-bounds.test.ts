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

describe("BrowserController bounded content observation", () => {
  it("does not let an optional animation-scan cap block explicit loader disappearance", async () => {
    const complexMarkup = Array.from(
      { length: 5_001 },
      () => "<span></span>",
    ).join("");
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Complex feed observation</title><style>
        body { margin: 0; min-height: 1800px; }
        [role="feed"] { position: fixed; inset: 0; overflow: hidden; }
      </style></head><body>
        <section role="feed" aria-label="Posts">
          <article id="post"><div role="status">Loading...</div></article>
          <div aria-hidden="true">${complexMarkup}</div>
        </section>
        <script>
          addEventListener('scroll', () => {
            document.querySelector('#post').innerHTML = '<p>Rendered post</p>';
          }, { once: true });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-complex-feed-observation-"),
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
      waitFor: { condition: "loading_indicators_disappear", timeoutMs: 1_000 },
      timeoutMs: 5_000,
    });
    expect(scrolled.wait).toMatchObject({
      requested: true,
      satisfied: true,
      evidence: "loading_indicators_disappeared",
      before: { articleCount: 0, loadingIndicatorCount: 1 },
      after: { articleCount: 1, loadingIndicatorCount: 0 },
    });
    expect(scrolled.stepsCompleted).toBe(1);
  });

  it("allows substantive article growth when only the optional animation scan is capped", async () => {
    const complexMarkup = Array.from(
      { length: 5_001 },
      () => "<span></span>",
    ).join("");
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Animated complex feed</title><style>
        body { margin: 0; min-height: 1800px; }
        [role="feed"] { position: fixed; inset: 0; overflow: hidden; }
        #animated-loader { width: 20px; height: 20px; animation: pulse 1s linear infinite; }
        @keyframes pulse { from { opacity: .5; } to { opacity: 1; } }
      </style></head><body>
        <section role="feed" aria-label="Posts">
          <article id="post"><div id="animated-loader"></div></article>
          <div aria-hidden="true">${complexMarkup}</div>
        </section>
        <script>
          addEventListener('scroll', () => {
            document.querySelector('#post').innerHTML = '<p>Rendered post</p>';
          }, { once: true });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-animated-complex-feed-"),
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
      timeoutMs: 5_000,
    });
    expect(scrolled.wait).toMatchObject({
      requested: true,
      satisfied: true,
      evidence: "article_count_growth",
      before: { articleCount: 0, loadingIndicatorCount: 1 },
      after: { articleCount: 1, loadingIndicatorCount: 0 },
    });
  });

  it("fails closed when animation-only disappearance depends on a capped scan", async () => {
    const complexMarkup = Array.from(
      { length: 5_001 },
      () => "<span></span>",
    ).join("");
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Incomplete animated disappearance</title><style>
        body { margin: 0; min-height: 1800px; }
        [role="feed"] { position: fixed; inset: 0; overflow: hidden; }
        #animated-loader { width: 20px; height: 20px; animation: pulse 1s linear infinite; }
        @keyframes pulse { from { opacity: .5; } to { opacity: 1; } }
      </style></head><body>
        <section role="feed" aria-label="Posts">
          <article id="post"><div id="animated-loader"></div></article>
          <div aria-hidden="true">${complexMarkup}</div>
        </section>
        <script>
          addEventListener('scroll', () => {
            document.querySelector('#post').innerHTML = '<p>Rendered post</p>';
          }, { once: true });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(
        os.tmpdir(),
        "stage5-browser-incomplete-animation-disappearance-",
      ),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    await expect(
      controller.scroll({
        direction: "down",
        amount: "half_viewport",
        count: 1,
        settleMs: 0,
        frameId: null,
        endMarker: null,
        target: null,
        waitFor: { condition: "loading_indicators_disappear", timeoutMs: 150 },
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "OPERATION_FAILED",
      details: {
        reason: "scroll_observation_incomplete",
        actionDispatched: true,
        stepsCompleted: 1,
      },
    });
  });

  it("does not mistake a detached pinned feed for loading-indicator disappearance", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Detached feed observation</title><style>
        body { margin: 0; min-height: 1800px; }
        #feed { position: fixed; top: 20px; left: 20px; width: 320px; height: 120px; }
        [role="progressbar"] { width: 120px; height: 20px; }
      </style></head><body>
        <section id="feed" role="feed" aria-label="Posts">
          <article>Rendered post</article>
          <div role="progressbar" aria-label="Loading more posts"></div>
        </section>
        <script>
          addEventListener('scroll', () => {
            const feed = document.querySelector('#feed');
            feed?.replaceWith(feed.cloneNode(true));
          }, { once: true });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-detached-feed-observation-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const startedAt = Date.now();
    await expect(
      controller.scroll({
        direction: "down",
        amount: "half_viewport",
        count: 1,
        settleMs: 0,
        frameId: null,
        endMarker: null,
        target: null,
        waitFor: {
          condition: "loading_indicators_disappear",
          timeoutMs: 10_000,
        },
        timeoutMs: 15_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "OPERATION_FAILED",
      details: {
        reason: "scroll_observation_surface_unavailable",
        actionDispatched: true,
        stepsCompleted: 1,
      },
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "scroll",
      outcome: "failed",
      reason: "detached",
      actionDispatched: true,
      clickDispatched: null,
    });
  });
});
