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

describe("BrowserController observed nested scroll containers", () => {
  it("targets observed nested scrollers, waits for feed growth, correlates diagnostics, and tolerates fractional boundaries", async () => {
    server = createServer((request, response) => {
      if (request.url === "/feed") {
        setTimeout(() => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end('{"ok":true}');
        }, 25);
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (request.url === "/modal-scroll") {
        response.end(`<!doctype html><html><head><title>Scrollable modal</title><style>
          body { margin: 0; overflow: hidden; }
          #composer { height: 160px; overflow-y: auto; }
          #modal-spacer { height: 600px; }
        </style></head><body>
          <section id="composer" role="dialog" aria-modal="true" aria-label="Scrollable composer">
            <article>Draft post</article><div id="modal-spacer"></div>
          </section>
        </body></html>`);
        return;
      }
      if (request.url === "/stalled") {
        response.end(`<!doctype html><html><head><title>Stalled feed</title>
          <style>body { margin: 0; height: 1800px; } #loader { position: fixed; inset: auto 10px 10px; width: 120px; height: 20px; }</style>
          </head><body>
          <article>Visible post</article><div id="loader" role="progressbar" aria-label="Loading more posts"></div>
          <script>
            addEventListener('load', () => {
              const root = document.scrollingElement;
              root.scrollTop = Math.max(0, root.scrollHeight - innerHeight - 0.5);
              root.scrollBy = () => undefined;
            });
          </script>
        </body></html>`);
        return;
      }
      response.end(`<!doctype html><html><head><title>Nested feed</title>
        <style>
          body { margin: 0; overflow: hidden; }
          #other-posts { height: 180px; overflow-y: auto; border: 1px solid black; }
          #spacer { height: 700px; }
        </style></head><body>
        <section id="other-posts" role="feed" aria-label="Other posts">
          <article>Echo iPhone app</article><div id="spacer"></div>
        </section>
        <script>
          let requested = false;
          const feed = document.querySelector('#other-posts');
          feed.addEventListener('scroll', () => {
            if (requested) return;
            requested = true;
            const loader = document.createElement('div');
            loader.id = 'loader';
            loader.setAttribute('role', 'progressbar');
            loader.setAttribute('aria-label', 'Loading more posts');
            feed.append(loader);
            fetch('/feed').then(() => setTimeout(() => {
              const article = document.createElement('article');
              article.textContent = 'Newly loaded Stage5 post';
              feed.append(article);
              loader.remove();
            }, 50));
          });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-nested-scroll-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));

    await controller.open({
      url: `${baseUrl}/nested`,
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
    expect(observed).toMatchObject({
      scrollContainerCount: 1,
      scrollContainers: [
        { label: "Other posts", role: "feed", inViewport: true },
      ],
    });
    const documentAttempt = await controller.scroll({
      direction: "down",
      amount: "viewport",
      count: 1,
      settleMs: 0,
      frameId: null,
      endMarker: null,
      target: null,
      waitFor: null,
      timeoutMs: 5_000,
    });
    expect(documentAttempt).toMatchObject({
      moved: false,
      nestedScrollContainerCandidateCount: 1,
    });
    expect(documentAttempt.warnings).toContainEqual(
      expect.objectContaining({
        code: "nested_scroll_containers_available",
      }),
    );

    const targetedObservation = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    const containerRef = targetedObservation.scrollContainers[0]?.ref;
    expect(containerRef).toBeDefined();
    if (containerRef === undefined) {
      throw new Error(
        "Fixture did not expose the nested feed scroll container.",
      );
    }

    const nested = await controller.scroll({
      direction: "down",
      amount: "viewport",
      count: 1,
      settleMs: 0,
      frameId: null,
      endMarker: null,
      target: { snapshotId: targetedObservation.snapshotId, ref: containerRef },
      waitFor: { condition: "either", timeoutMs: 1_000 },
      timeoutMs: 5_000,
    });
    expect(nested).toMatchObject({
      target: { kind: "container", ref: containerRef },
      moved: true,
      documentBoundaryReached: false,
      wait: {
        requested: true,
        satisfied: true,
        evidence: "article_count_growth",
        before: { articleCount: 1 },
        after: { articleCount: 2, loadingIndicatorCount: 0 },
      },
    });
    const diagnostics = await controller.diagnostics();
    expect(diagnostics.page?.lastAction).toMatchObject({
      action: "scroll",
      outcome: "succeeded",
      actionDispatched: true,
      clickDispatched: null,
    });
    expect(diagnostics.page?.lastActionNetworkEvents).toContainEqual(
      expect.objectContaining({
        kind: "http_response",
        status: 200,
        url: `${baseUrl}/feed`,
      }),
    );
    await expect(
      controller.scroll({
        direction: "down",
        amount: "viewport",
        count: 1,
        settleMs: 0,
        frameId: null,
        endMarker: null,
        target: {
          snapshotId: targetedObservation.snapshotId,
          ref: containerRef,
        },
        waitFor: null,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "TARGET_NOT_FOUND",
      details: { reason: "stale_or_unknown_snapshot" },
    });

    await controller.open({
      url: `${baseUrl}/modal-scroll`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const modalObservation = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(modalObservation).toMatchObject({
      scope: "modal",
      scrollContainerCount: 1,
      scrollContainers: [
        { label: "Scrollable composer", role: "dialog", inViewport: true },
      ],
    });

    await controller.open({
      url: `${baseUrl}/stalled`,
      newTab: false,
      stabilizationMs: 100,
      timeoutMs: 5_000,
    });
    const stalled = await controller.scroll({
      direction: "down",
      amount: "viewport",
      count: 1,
      settleMs: 50,
      frameId: null,
      endMarker: null,
      target: null,
      waitFor: { condition: "either", timeoutMs: 250 },
      timeoutMs: 5_000,
    });
    expect(stalled.before.maxY - stalled.before.y).toBeLessThanOrEqual(1);
    expect(stalled).toMatchObject({
      target: { kind: "document", ref: null },
      moved: false,
      targetBoundaryReached: true,
      documentBoundaryReached: true,
      endReached: false,
      endState: "dynamic_content_stalled",
      wait: { requested: true, satisfied: false, evidence: "timeout" },
    });
    expect(stalled.warnings).toContainEqual(
      expect.objectContaining({ code: "content_wait_timed_out" }),
    );
    expect(stalled.warnings).toContainEqual(
      expect.objectContaining({ code: "dynamic_content_stalled" }),
    );
  });

  it("moves an exact observed horizontal surface in both directions", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Horizontal choices</title>
        <style>
          body { margin: 0; overflow: hidden; }
          #carousel { width: 240px; height: 100px; overflow-x: auto; overflow-y: hidden; }
          #choices { width: 900px; height: 80px; display: flex; }
          article { width: 180px; flex: none; }
        </style></head><body>
        <section id="carousel" aria-label="Horizontal choices">
          <div id="choices">
            <article>Alpha</article><article>Beta</article><article>Gamma</article>
            <article>Delta</article><article>Epsilon</article>
          </div>
        </section>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-horizontal-scroll-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));

    await controller.open({
      url: `http://127.0.0.1:${port}/horizontal`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const initial = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    const initialContainer = initial.scrollContainers[0];
    expect(initialContainer).toMatchObject({
      label: "Horizontal choices",
      position: { x: 0, y: 0, maxY: 0 },
    });
    expect(initialContainer?.position.maxX).toBeGreaterThan(600);
    if (initialContainer === undefined) {
      throw new Error("Fixture did not expose the horizontal scroll surface.");
    }

    const movedRight = await controller.scroll({
      direction: "right",
      amount: "viewport",
      count: 1,
      settleMs: 0,
      frameId: null,
      endMarker: null,
      target: { snapshotId: initial.snapshotId, ref: initialContainer.ref },
      waitFor: null,
      timeoutMs: 5_000,
    });
    expect(movedRight).toMatchObject({
      target: { kind: "container", ref: initialContainer.ref },
      moved: true,
      targetBoundaryReached: false,
      documentBoundaryReached: false,
      endReached: false,
      endState: "not_at_boundary",
      before: { x: 0, y: 0 },
      after: { y: 0 },
    });
    expect(movedRight.after.x).toBeGreaterThanOrEqual(239);

    const movedObservation = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    const movedContainer = movedObservation.scrollContainers[0];
    if (movedContainer === undefined) {
      throw new Error("Horizontal scroll surface disappeared after movement.");
    }
    const returnedLeft = await controller.scroll({
      direction: "left",
      amount: "document_start",
      count: 1,
      settleMs: 0,
      frameId: null,
      endMarker: null,
      target: {
        snapshotId: movedObservation.snapshotId,
        ref: movedContainer.ref,
      },
      waitFor: null,
      timeoutMs: 5_000,
    });
    expect(returnedLeft).toMatchObject({
      moved: true,
      targetBoundaryReached: true,
      documentBoundaryReached: false,
      endReached: true,
      endState: "confirmed_container_start",
      after: { x: 0, y: 0 },
    });
  });
});
