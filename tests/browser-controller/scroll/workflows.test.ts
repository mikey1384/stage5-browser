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

describe("BrowserController scroll workflows and popup semantics", () => {
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
});
