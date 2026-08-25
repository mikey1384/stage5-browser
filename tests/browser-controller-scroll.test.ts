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

import { BrowserController } from "../src/browser-controller.js";
import {
  playwrightBrowserType,
  resolveBrowserLaunchTarget,
} from "../src/browser-provider.js";
import type { Stage5BrowserConfig } from "../src/config.js";
import { Stage5BrowserError } from "../src/errors.js";
import {
  inspectTargetState,
  PageDiagnosticBuffer,
  type SanitizedPageActivationEvidence,
} from "../src/page-diagnostics.js";
import { waitForProfileUnlock } from "../src/human-auth-bootstrap.js";
import type { OwnedBrowserWindowActivator } from "../src/native-window-activation.js";
import type { NativeControlRecord } from "../src/native-control-channel.js";
import {
  processIsRunning,
  readNativeControlRecord,
} from "../src/native-control-channel.js";
import {
  launchIdentityForTarget,
  controlledProfileArguments,
  type BrowserLaunchIdentity,
  type ProfileStorageInspection,
} from "../src/profile-binding.js";
import {
  processExecutablePath,
  processStartedAtToken,
  profilePathFingerprint,
  observeLaunchedBrowserProcess,
  snapshotOwnedDescendants,
  writeProfileOwnershipLease,
} from "../src/profile-ownership-lease.js";
import type { BrowserStatus } from "../src/protocol.js";
import {
  browserConfig,
  cleanBrowserControllerTestState,
  FakeHumanBrowserLauncher,
  listen,
  requestFakeLoginHandoff,
  storageInspection,
} from "./browser-controller-fixture.js";

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

describe("BrowserController scrolling", () => {
  it("handles timeline scrolling, text search, observed refs, click postconditions, redirects, and rate limits", async () => {
    server = createServer((request, response) => {
      const requestUrl = request.url ?? "/";
      if (requestUrl === "/redirect") {
        response.writeHead(302, { location: "/client-redirect" });
        response.end();
        return;
      }
      if (requestUrl === "/client-redirect") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html><head><title>Client redirect</title></head><body>
          <p>Redirecting</p><script>setTimeout(() => location.href = '/final', 50)</script>
        </body></html>`);
        return;
      }
      if (requestUrl === "/final") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          "<!doctype html><html><head><title>Final page</title></head><body>Final destination</body></html>",
        );
        return;
      }
      if (requestUrl === "/rate-limited") {
        response.writeHead(429, {
          "content-type": "text/html; charset=utf-8",
          "retry-after": "60",
        });
        response.end("<!doctype html><html><body>Slow down</body></html>");
        return;
      }
      if (requestUrl === "/destination") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          "<!doctype html><html><head><title>Observed destination</title></head><body>Reference worked</body></html>",
        );
        return;
      }
      if (requestUrl === "/dynamic") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html><head><title>Dynamic timeline</title>
          <style>body { margin: 0; } #dynamic-spacer { height: 1000px; }</style></head><body>
          <article>Recent video</article><div id="dynamic-spacer"></div>
          <script>
            let grew = false;
            addEventListener('scroll', () => {
              if (!grew) {
                grew = true;
                document.querySelector('#dynamic-spacer').style.height = '2500px';
              }
            });
          </script>
        </body></html>`);
        return;
      }

      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Timeline fixture</title>
        <style>body { margin: 0; } #spacer { height: 2200px; }</style></head><body>
        <button role="tab" aria-selected="false" onclick="setTimeout(() => this.setAttribute('aria-selected', 'true'), 50)">Delayed Media</button>
        <button role="tab" aria-selected="false" onclick="document.querySelector('#login').hidden = false">Media</button>
        <div id="login" role="dialog" hidden>Log in to continue</div>
        <a href="/destination"><span aria-hidden="true">decorative</span></a>
        <div id="spacer"></div><p id="older"></p>
        <script>
          addEventListener('scroll', () => {
            if (scrollY > 100) document.querySelector('#older').textContent = 'Rick Rubin archived post';
          });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-timeline-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));

    const redirected = await controller.open({
      url: `${baseUrl}/redirect`,
      newTab: false,
      stabilizationMs: 250,
      timeoutMs: 5_000,
    });
    expect(redirected).toMatchObject({
      finalUrl: `${baseUrl}/final`,
      redirected: true,
      redirectChain: [
        {
          kind: "server",
          from: `${baseUrl}/redirect`,
          to: `${baseUrl}/client-redirect`,
          status: 302,
        },
      ],
    });
    expect(redirected.observedUrls).toContain(`${baseUrl}/final`);

    const rateLimited = await controller.open({
      url: `${baseUrl}/rate-limited`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    expect(rateLimited.responseStatus).toBe(429);
    expect(rateLimited.warnings).toContainEqual(
      expect.objectContaining({
        code: "http_rate_limited",
        status: 429,
        suggestedAction: expect.stringContaining("do not immediately repeat"),
      }),
    );

    await controller.open({
      url: `${baseUrl}/timeline`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const delayedSelection = await controller.clickByRole({
      role: "tab",
      name: "Delayed Media",
      exact: true,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: true,
        expectedVisible: null,
        timeoutMs: 100,
      },
      timeoutMs: 5_000,
    });
    expect(delayedSelection.postcondition).toMatchObject({ passed: true });
    await expect(
      controller.clickByRole({
        role: "tab",
        name: "Media",
        exact: true,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: true,
          expectedVisible: null,
          timeoutMs: 250,
        },
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "POSTCONDITION_FAILED",
      details: {
        clickDispatched: true,
        actionOutcome: "click_dispatched_postcondition_failed",
      },
    });

    const scrolled = await controller.scroll({
      direction: "down",
      amount: "viewport",
      count: 1,
      settleMs: 100,
      frameId: null,
      endMarker: null,
      target: null,
      waitFor: null,
      timeoutMs: 5_000,
    });
    expect(scrolled.moved).toBe(true);
    const found = await controller.findText({
      query: "Rick Rubin",
      mode: "contains",
      caseSensitive: false,
      maxResults: 10,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(found).toMatchObject({
      matchCount: 1,
      returnedCount: 1,
      textTruncated: false,
    });
    expect(found.matches[0]?.snippet).toContain("Rick Rubin archived post");

    await controller.open({
      url: `${baseUrl}/timeline`,
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
    const unnamedLink = observed.snapshot.match(/link \[ref=([^\]]+)\]/)?.[1];
    expect(unnamedLink).toBeDefined();
    if (unnamedLink === undefined) {
      throw new Error("Fixture did not expose an unnamed link reference.");
    }
    const clicked = await controller.clickRef({
      snapshotId: observed.snapshotId,
      ref: unnamedLink,
      frameId: null,
      postcondition: {
        expectedUrl: { url: `${baseUrl}/destination`, match: "exact" },
        expectedSelected: null,
        expectedVisible: null,
        timeoutMs: 2_000,
      },
      timeoutMs: 5_000,
    });
    expect(clicked.postcondition).toMatchObject({ passed: true });
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      outcome: "succeeded",
      actionDispatched: true,
      clickDispatched: true,
      dispatchEvidence: {
        trustedEventObserved: true,
        clickOnTarget: true,
      },
    });
    await expect(
      controller.clickRef({
        snapshotId: observed.snapshotId,
        ref: unnamedLink,
        frameId: null,
        postcondition: null,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "TARGET_NOT_FOUND",
    });
    await controller.waitForUrl({
      expected: { url: "/destination", match: "contains" },
      timeoutMs: 1_000,
    });

    await controller.open({
      url: `${baseUrl}/dynamic`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const dynamicBoundary = await controller.scroll({
      direction: "down",
      amount: "viewport",
      count: 8,
      settleMs: 50,
      frameId: null,
      endMarker: null,
      target: null,
      waitFor: null,
      timeoutMs: 5_000,
    });
    expect(dynamicBoundary).toMatchObject({
      documentBoundaryReached: true,
      endReached: false,
      endState: "dynamic_content_stalled",
    });
    expect(dynamicBoundary.warnings).toContainEqual(
      expect.objectContaining({
        code: "dynamic_content_stalled",
      }),
    );

    expect(await controller.authStatus()).toMatchObject({
      state: "profile_ready",
      authenticated: "unknown",
      persistentProfile: true,
    });
    await expect(
      controller.requestLoginHandoff({
        url: null,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "AUTH_HANDOFF_UNAVAILABLE",
    });
    await expect(
      controller.resumeAfterLogin({
        expected: null,
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "AUTH_HANDOFF_REQUIRED",
    });
  });

  it("suppresses offscreen popup semantics and requires rendered option postconditions", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Dormant popup portal</title><style>
        body { margin: 0; min-height: 1800px; }
        #closed-portal {
          position: fixed;
          left: -10000px;
          top: 20px;
          width: 240px;
          height: 80px;
          overflow-y: auto;
          background: white;
        }
        #popup-spacer { height: 500px; }
        #ordinary-link { position: absolute; top: 1400px; }
      </style></head><body>
        <button id="closed-check" type="button">Check closed choices</button>
        <button id="open-check" type="button">Check open choices</button>
        <output id="clicks">clicks:0</output>
        <div id="closed-portal" role="listbox" aria-label="Dormant choices">
          <div role="option">Agency account</div>
          <div role="status">Stale focused choice</div>
          <div id="popup-spacer"></div>
        </div>
        <a id="ordinary-link" href="/ordinary">Ordinary offscreen link</a>
        <script>
          let clicks = 0;
          for (const button of document.querySelectorAll('button')) {
            button.addEventListener('click', () => {
              clicks += 1;
              document.querySelector('#clicks').textContent = 'clicks:' + clicks;
            });
          }
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-dormant-popup-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/popup`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const closed = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(closed.snapshot).not.toContain("Dormant choices");
    expect(closed.snapshot).not.toContain("Agency account");
    expect(closed.snapshot).not.toContain("Stale focused choice");
    expect(closed.snapshot).toContain("Ordinary offscreen link");
    expect(closed.scrollContainerCount).toBe(0);

    await expect(
      controller.clickByRole({
        role: "button",
        name: "Check closed choices",
        exact: true,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: null,
          expectedVisible: {
            role: "option",
            name: "Agency account",
            exact: true,
            frameId: null,
          },
          timeoutMs: 500,
        },
        timeoutMs: 3_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "POSTCONDITION_FAILED",
      details: {
        clickDispatched: true,
        actionOutcome: "click_dispatched_postcondition_failed",
        checks: [
          { kind: "visible", expected: true, observed: false, passed: false },
        ],
      },
    });
    const page = (controller as unknown as { activePage: Page }).activePage;
    await expect(page.locator("#clicks").textContent()).resolves.toBe(
      "clicks:1",
    );

    await page.locator("#closed-portal").evaluate((portal) => {
      (portal as HTMLElement).style.left = "20px";
    });
    const opened = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(opened.snapshot).toContain("Dormant choices");
    expect(opened.snapshot).toContain("Agency account");
    expect(opened.snapshot).toContain("Stale focused choice");
    expect(opened).toMatchObject({
      scrollContainerCount: 1,
      scrollContainers: [{ role: "listbox", inViewport: true }],
    });
    await expect(
      controller.clickByRole({
        role: "button",
        name: "Check open choices",
        exact: true,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: null,
          expectedVisible: {
            role: "option",
            name: "Agency account",
            exact: true,
            frameId: null,
          },
          timeoutMs: 500,
        },
        timeoutMs: 3_000,
      }),
    ).resolves.toMatchObject({ postcondition: { passed: true } });
    await expect(page.locator("#clicks").textContent()).resolves.toBe(
      "clicks:2",
    );
  });

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
