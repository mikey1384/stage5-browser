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

describe("BrowserController snapshot ref activation and rebinding", () => {
  it("keeps and rebinds a fresh unnamed link ref by its observed destination", async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (request.url === "/build") {
        response.end(
          "<!doctype html><html><head><title>Build destination</title></head><body>Build ready</body></html>",
        );
        return;
      }
      response.end(`<!doctype html><html><head><title>Unnamed destination links</title></head><body>
        <a id="build" href="/build"><span aria-hidden="true">Build icon</span></a>
        <a id="settings" href="/settings"><span aria-hidden="true">Settings icon</span></a>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-unnamed-link-ref-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    const baseUrl = `http://127.0.0.1:${port}`;
    for (const replaceBeforeClick of [false, true]) {
      await controller.open({
        url: `${baseUrl}/`,
        newTab: false,
        stabilizationMs: 0,
        timeoutMs: 5_000,
      });
      const observed = await controller.snapshot({
        depth: 6,
        boxes: false,
        frameId: null,
        timeoutMs: 2_000,
      });
      const lines = observed.snapshot.split("\n");
      const buildUrlLine = lines.findIndex((line) =>
        line.includes("/url: /build"),
      );
      expect(buildUrlLine).toBeGreaterThan(0);
      const buildLinkLine = lines
        .slice(0, buildUrlLine)
        .reverse()
        .find((line) => /\blink\b/u.test(line));
      const buildRef = buildLinkLine?.match(/\[ref=([^\]]+)\]/u)?.[1];
      expect(buildRef).toBeDefined();
      if (buildRef === undefined)
        throw new Error(
          "Unnamed-link fixture did not expose its observed /build ref.",
        );
      if (replaceBeforeClick) {
        const page = (controller as unknown as { activePage: Page }).activePage;
        await page
          .locator("#build")
          .evaluate((link) => link.replaceWith(link.cloneNode(true)));
      }

      await expect(
        controller.clickRef({
          snapshotId: observed.snapshotId,
          ref: buildRef,
          frameId: null,
          postcondition: {
            expectedUrl: { url: `${baseUrl}/build`, match: "exact" },
            expectedSelected: null,
            expectedVisible: null,
            timeoutMs: 2_000,
          },
          timeoutMs: 4_000,
        }),
      ).resolves.toMatchObject({
        page: { url: `${baseUrl}/build` },
        postcondition: { passed: true },
      });
      expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
        action: "click_by_ref",
        outcome: "succeeded",
        actionDispatched: true,
        clickDispatched: true,
      });
    }
  });

  it("rebinds a fresh ref to one semantically identical in-scope replacement after page activation", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Reference activation replacement</title></head><body>
        <button id="outside" type="button">Funding source</button>
        <div role="dialog" aria-modal="true" aria-label="Business details">
          <button id="opener" type="button" aria-selected="false"
            onclick="this.setAttribute('aria-selected', 'true'); document.querySelector('#counter').textContent = 'clicks:1'">
            Funding source
          </button>
          <output id="counter">clicks:0</output>
        </div>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-ref-activation-rebind-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({
      depth: 6,
      boxes: false,
      frameId: null,
      timeoutMs: 2_000,
    });
    expect(observed.scope).toBe("modal");
    const openerRef = observed.snapshot.match(
      /button "Funding source"[^\n]*\[ref=([^\]]+)\]/,
    )?.[1];
    expect(openerRef).toBeDefined();
    if (openerRef === undefined)
      throw new Error(
        "Activation replacement fixture did not expose its opener ref.",
      );

    const page = (controller as unknown as { activePage: Page }).activePage;
    let activationCount = 0;
    const activation = vi
      .spyOn(
        controller as unknown as {
          activateSelectedPageForInput: (
            ...args: unknown[]
          ) => Promise<SanitizedPageActivationEvidence>;
        },
        "activateSelectedPageForInput",
      )
      .mockImplementation(async () => {
        activationCount += 1;
        if (activationCount === 1) {
          await page
            .locator("#opener")
            .evaluate((opener) => opener.replaceWith(opener.cloneNode(true)));
        }
        return {
          attemptCount: activationCount,
          controllerSelected: true,
          bringToFrontAttempted: activationCount === 1,
          bringToFrontSucceeded: true,
          visibilityBefore: activationCount === 1 ? "hidden" : "visible",
          visibilityAfter: "visible",
          documentFocusedBefore: false,
          documentFocusedAfter: true,
          nativeWindow: {
            required: activationCount === 1,
            attempted: activationCount === 1,
            supported: true,
            ownedProcessAvailable: true,
            ownedProcessRunning: true,
            targetWindowResolved: true,
            windowStateBefore: "normal",
            normalizationAttempted: false,
            normalizationSucceeded: null,
            applicationActivationAttempted: activationCount === 1,
            applicationActivationSucceeded: true,
            applicationHiddenBefore: false,
            unhideAttempted: false,
            unhideSucceeded: null,
            activationRequestAccepted: true,
            frontProcessFallbackAttempted: false,
            frontProcessFallbackProcessResolved: null,
            frontProcessFallbackRequestSucceeded: null,
            applicationFrontmostAfter: true,
            applicationHiddenAfter: false,
            result: activationCount === 1 ? "activated" : "not_required",
          },
        };
      });

    await expect(
      controller.clickRef({
        snapshotId: observed.snapshotId,
        ref: openerRef,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: true,
          expectedVisible: null,
          timeoutMs: 1_000,
        },
        timeoutMs: 3_000,
      }),
    ).resolves.toMatchObject({ postcondition: { passed: true } });
    expect(activation).toHaveBeenCalledTimes(1);
    await expect(page.locator("#counter").textContent()).resolves.toBe(
      "clicks:1",
    );
    await expect(
      page.locator("#outside").getAttribute("aria-selected"),
    ).resolves.toBeNull();
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_ref",
      outcome: "succeeded",
      actionDispatched: true,
      clickDispatched: true,
    });
  });

  it("settles activation replacement before the final ref bind without activating again at dispatch", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Deferred activation replacement</title></head><body>
        <div role="dialog" aria-modal="true" aria-label="Business use">
          <button id="opener" type="button" aria-selected="false"
            onclick="this.setAttribute('aria-selected', 'true'); document.querySelector('#counter').textContent = 'clicks:1'">
            Use Coinbase for business operations
          </button>
          <output id="counter">clicks:0 replacements:0</output>
        </div>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-deferred-activation-rebind-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({
      depth: 6,
      boxes: false,
      frameId: null,
      timeoutMs: 2_000,
    });
    const openerRef = observed.snapshot.match(
      /button "Use Coinbase for business operations"[^\n]*\[ref=([^\]]+)\]/,
    )?.[1];
    expect(openerRef).toBeDefined();
    if (openerRef === undefined)
      throw new Error(
        "Deferred activation fixture did not expose its opener ref.",
      );

    const page = (controller as unknown as { activePage: Page }).activePage;
    const internals = controller as unknown as {
      activateSelectedPageForInput: (
        page: Page,
        attemptCount: number,
      ) => Promise<SanitizedPageActivationEvidence>;
    };
    const originalActivation =
      internals.activateSelectedPageForInput.bind(controller);
    let activationCount = 0;
    const replaceOpener = async (): Promise<void> => {
      await page.locator("#opener").evaluate((opener) => {
        opener.replaceWith(opener.cloneNode(true));
        const counter = document.querySelector("#counter");
        if (counter !== null) counter.textContent = "clicks:0 replacements:1";
      });
    };
    const activation = vi
      .spyOn(internals, "activateSelectedPageForInput")
      .mockImplementation(async (...args) => {
        activationCount += 1;
        if (activationCount === 1) {
          void page
            .waitForTimeout(25)
            .then(replaceOpener)
            .catch(() => undefined);
        } else {
          await replaceOpener();
        }
        const evidence = await originalActivation(...args);
        return {
          ...evidence,
          attemptCount: activationCount,
          bringToFrontAttempted: activationCount === 1,
          bringToFrontSucceeded: activationCount === 1,
          visibilityBefore: activationCount === 1 ? "hidden" : "visible",
          visibilityAfter: "visible",
          documentFocusedBefore: false,
          documentFocusedAfter: true,
        };
      });

    await expect(
      controller.clickRef({
        snapshotId: observed.snapshotId,
        ref: openerRef,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: true,
          expectedVisible: null,
          timeoutMs: 1_000,
        },
        timeoutMs: 3_000,
      }),
    ).resolves.toMatchObject({ postcondition: { passed: true } });
    expect(activation).toHaveBeenCalledTimes(1);
    await expect(page.locator("#counter").textContent()).resolves.toBe(
      "clicks:1",
    );
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_ref",
      outcome: "succeeded",
      actionDispatched: true,
      clickDispatched: true,
    });
  });

  it("reactivates and rebinds once when the selected page becomes hidden before dispatch", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Late activation loss</title></head><body>
        <div role="listbox" aria-label="Business use">
          <div id="target" role="option" aria-selected="false"
            onclick="this.setAttribute('aria-selected', 'true'); document.querySelector('#counter').textContent = 'clicks:1 replacements:1'">
            Proprietary trading / investing
          </div>
          <output id="counter">clicks:0 replacements:0</output>
        </div>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-late-activation-rebind-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({
      depth: 6,
      boxes: false,
      frameId: null,
      timeoutMs: 2_000,
    });
    const targetRef = observed.snapshot.match(
      /option "Proprietary trading \/ investing"[^\n]*\[ref=([^\]]+)\]/,
    )?.[1];
    expect(targetRef).toBeDefined();
    if (targetRef === undefined) {
      throw new Error("Late-activation fixture did not expose its option ref.");
    }

    const page = (controller as unknown as { activePage: Page }).activePage;
    const internals = controller as unknown as {
      activateSelectedPageForInput: (
        page: Page,
        attemptCount: number,
      ) => Promise<SanitizedPageActivationEvidence>;
      observePageActivation: () => Promise<{
        documentFocused: boolean | null;
        visibility: "hidden" | "prerender" | "unknown" | "visible";
      }>;
    };
    let activationCount = 0;
    const activation = vi
      .spyOn(internals, "activateSelectedPageForInput")
      .mockImplementation(async (_page, attemptCount) => {
        activationCount += 1;
        if (activationCount === 2) {
          void page
            .waitForTimeout(25)
            .then(() =>
              page.locator("#target").evaluate((target) => {
                target.replaceWith(target.cloneNode(true));
                const counter = document.querySelector("#counter");
                if (counter !== null)
                  counter.textContent = "clicks:0 replacements:1";
              }),
            )
            .catch(() => undefined);
        }
        const reactivating = activationCount === 2;
        return {
          attemptCount,
          controllerSelected: true,
          bringToFrontAttempted: reactivating,
          bringToFrontSucceeded: reactivating,
          visibilityBefore: reactivating ? "hidden" : "visible",
          visibilityAfter: "visible",
          documentFocusedBefore: false,
          documentFocusedAfter: reactivating,
          nativeWindow: {
            required: reactivating,
            attempted: reactivating,
            supported: true,
            ownedProcessAvailable: true,
            ownedProcessRunning: true,
            targetWindowResolved: true,
            windowStateBefore: "normal",
            normalizationAttempted: false,
            normalizationSucceeded: null,
            applicationActivationAttempted: reactivating,
            applicationActivationSucceeded: reactivating,
            applicationHiddenBefore: false,
            unhideAttempted: false,
            unhideSucceeded: null,
            activationRequestAccepted: reactivating,
            frontProcessFallbackAttempted: false,
            frontProcessFallbackProcessResolved: null,
            frontProcessFallbackRequestSucceeded: null,
            applicationFrontmostAfter: true,
            applicationHiddenAfter: false,
            result: reactivating ? "activated" : "not_required",
          },
        };
      });
    const observeActivation = vi
      .spyOn(internals, "observePageActivation")
      .mockResolvedValueOnce({
        documentFocused: false,
        visibility: "hidden",
      })
      .mockResolvedValue({
        documentFocused: true,
        visibility: "visible",
      });

    await expect(
      controller.clickRef({
        snapshotId: observed.snapshotId,
        ref: targetRef,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: true,
          expectedVisible: null,
          timeoutMs: 1_000,
        },
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ postcondition: { passed: true } });
    expect(activation).toHaveBeenCalledTimes(2);
    expect(activation).toHaveBeenLastCalledWith(page, 2, expect.any(Object));
    expect(observeActivation).toHaveBeenCalledTimes(3);
    await expect(page.locator("#counter").textContent()).resolves.toBe(
      "clicks:1 replacements:1",
    );
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_ref",
      outcome: "succeeded",
      actionDispatched: true,
      clickDispatched: true,
      dispatchEvidence: {
        pageActivation: {
          attemptCount: 2,
          bringToFrontAttempted: true,
          visibilityBefore: "hidden",
          visibilityAfter: "visible",
          nativeWindow: { attempted: true, result: "activated" },
        },
      },
    });
  });

  it("fails closed when late reactivation makes a fresh ref semantically ambiguous", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Late ambiguous activation</title></head><body>
        <div role="listbox" aria-label="Business use">
          <div id="target" role="option" onclick="document.querySelector('#counter').textContent = 'clicks:1'">
            Proprietary trading / investing
          </div>
          <output id="counter">clicks:0</output>
        </div>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-late-activation-ambiguous-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({
      depth: 6,
      boxes: false,
      frameId: null,
      timeoutMs: 2_000,
    });
    const targetRef = observed.snapshot.match(
      /option "Proprietary trading \/ investing"[^\n]*\[ref=([^\]]+)\]/,
    )?.[1];
    expect(targetRef).toBeDefined();
    if (targetRef === undefined) {
      throw new Error("Late-ambiguity fixture did not expose its option ref.");
    }

    const page = (controller as unknown as { activePage: Page }).activePage;
    const internals = controller as unknown as {
      activateSelectedPageForInput: (
        page: Page,
        attemptCount: number,
      ) => Promise<SanitizedPageActivationEvidence>;
      observePageActivation: () => Promise<{
        documentFocused: boolean | null;
        visibility: "hidden" | "prerender" | "unknown" | "visible";
      }>;
    };
    let activationCount = 0;
    vi.spyOn(internals, "activateSelectedPageForInput").mockImplementation(
      async (_page, attemptCount) => {
        activationCount += 1;
        if (activationCount === 2) {
          await page.locator("#target").evaluate((target) => {
            target.replaceWith(target.cloneNode(true), target.cloneNode(true));
          });
        }
        const reactivating = activationCount === 2;
        return {
          attemptCount,
          controllerSelected: true,
          bringToFrontAttempted: reactivating,
          bringToFrontSucceeded: reactivating,
          visibilityBefore: reactivating ? "hidden" : "visible",
          visibilityAfter: "visible",
          documentFocusedBefore: false,
          documentFocusedAfter: reactivating,
          nativeWindow: {
            required: reactivating,
            attempted: reactivating,
            supported: true,
            ownedProcessAvailable: true,
            ownedProcessRunning: true,
            targetWindowResolved: true,
            windowStateBefore: "normal",
            normalizationAttempted: false,
            normalizationSucceeded: null,
            applicationActivationAttempted: reactivating,
            applicationActivationSucceeded: reactivating,
            applicationHiddenBefore: false,
            unhideAttempted: false,
            unhideSucceeded: null,
            activationRequestAccepted: reactivating,
            frontProcessFallbackAttempted: false,
            frontProcessFallbackProcessResolved: null,
            frontProcessFallbackRequestSucceeded: null,
            applicationFrontmostAfter: true,
            applicationHiddenAfter: false,
            result: reactivating ? "activated" : "not_required",
          },
        };
      },
    );
    vi.spyOn(internals, "observePageActivation")
      .mockResolvedValueOnce({
        documentFocused: false,
        visibility: "hidden",
      })
      .mockResolvedValue({
        documentFocused: true,
        visibility: "visible",
      });

    await expect(
      controller.clickRef({
        snapshotId: observed.snapshotId,
        ref: targetRef,
        frameId: null,
        postcondition: null,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "AMBIGUOUS_TARGET",
      details: {
        reason: "reference_semantic_rebind_ambiguous",
        actionDispatched: false,
        clickDispatched: false,
      },
    });
    expect(activationCount).toBe(2);
    await expect(page.locator("#counter").textContent()).resolves.toBe(
      "clicks:0",
    );
  });
});
