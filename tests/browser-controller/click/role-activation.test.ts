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

describe("BrowserController role click activation boundaries", () => {
  it("does not treat an ambiguous post-click option set as hidden", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Ambiguous hidden option effect</title></head><body>
        <div id="choices" role="listbox" aria-label="Funding choices">
          <div id="choice" role="option" tabindex="0">Operating revenue</div>
        </div>
        <output id="counters">clicks:0</output>
        <script>
          let clicks = 0;
          document.querySelector('#choice').addEventListener('click', () => {
            clicks += 1;
            const duplicate = document.querySelector('#choice').cloneNode(true);
            duplicate.removeAttribute('id');
            document.querySelector('#choices').append(duplicate);
            document.querySelector('#counters').textContent = 'clicks:' + clicks;
          });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-ambiguous-hidden-option-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/choice`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    await expect(
      controller.clickByRole({
        role: "option",
        name: "Operating revenue",
        exact: true,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: null,
          expectedVisible: null,
          expectedHidden: {
            role: "option",
            name: "Operating revenue",
            exact: true,
            frameId: null,
          },
          timeoutMs: 250,
        },
        timeoutMs: 3_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "POSTCONDITION_FAILED",
      details: {
        clickDispatched: true,
        checks: [
          { kind: "visible", passed: false, expected: false, observed: null },
        ],
      },
    });
    const page = (controller as unknown as { activePage: Page }).activePage;
    await expect(page.locator("#counters").textContent()).resolves.toBe(
      "clicks:1",
    );
    await expect(
      page
        .getByRole("option", { name: "Operating revenue", exact: true })
        .count(),
    ).resolves.toBe(2);
  });

  it("does not foreground a controller-selected page whose renderer is already visible", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Background-safe input</title></head><body>
        <button type="button" aria-selected="false" onclick="this.setAttribute('aria-selected', 'true')">
          Inspect locally
        </button>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-background-safe-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const page = (controller as unknown as { activePage: Page }).activePage;
    const bringToFront = vi.spyOn(page, "bringToFront");

    await controller.clickByRole({
      role: "button",
      name: "Inspect locally",
      exact: true,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: true,
        expectedVisible: null,
        timeoutMs: 500,
      },
      timeoutMs: 3_000,
    });

    expect(bringToFront).not.toHaveBeenCalled();
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      dispatchEvidence: {
        pageActivation: {
          bringToFrontAttempted: false,
          visibilityBefore: "visible",
          visibilityAfter: "visible",
        },
      },
    });
  });

  it("reprepares a unique role target once after zero-dispatch activation loss", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Late role activation loss</title></head><body>
        <button id="target" type="button" aria-selected="false"
          onclick="this.setAttribute('aria-selected', 'true'); document.querySelector('#counter').textContent = 'clicks:1'">
          Confirm business use
        </button>
        <output id="counter">clicks:0</output>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-late-role-activation-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const page = (controller as unknown as { activePage: Page }).activePage;
    const internals = controller as unknown as {
      activateSelectedPageForInput: (
        page: Page,
        attemptCount: number,
      ) => Promise<SanitizedPageActivationEvidence>;
      nativeWindowActivationNotRequired: () =>
        SanitizedPageActivationEvidence["nativeWindow"];
      observePageActivation: () => Promise<{
        documentFocused: boolean | null;
        visibility: "hidden" | "prerender" | "unknown" | "visible";
      }>;
    };
    const inactiveNativeEvidence =
      internals.nativeWindowActivationNotRequired();
    const activation = vi
      .spyOn(internals, "activateSelectedPageForInput")
      .mockImplementation(async (_page, attemptCount) => {
        const reactivating = attemptCount === 2;
        return {
          attemptCount,
          controllerSelected: true,
          bringToFrontAttempted: reactivating,
          bringToFrontSucceeded: reactivating,
          visibilityBefore: reactivating ? "hidden" : "visible",
          visibilityAfter: "visible",
          documentFocusedBefore: false,
          documentFocusedAfter: reactivating,
          nativeWindow: reactivating
            ? {
                ...inactiveNativeEvidence,
                required: true,
                attempted: true,
                result: "activated",
              }
            : inactiveNativeEvidence,
        };
      });
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
      controller.clickByRole({
        role: "button",
        name: "Confirm business use",
        exact: true,
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
    await expect(page.locator("#counter").textContent()).resolves.toBe(
      "clicks:1",
    );
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_role",
      outcome: "succeeded",
      actionDispatched: true,
      clickDispatched: true,
    });
  });

  it("re-resolves a unique role target after page activation replaces it before input", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Activation replacement</title></head><body>
        <button id="opener" type="button" aria-selected="false"
          onclick="this.setAttribute('aria-selected', 'true'); document.querySelector('#counter').textContent = 'clicks:1'">
          Funding source
        </button>
        <output id="counter">clicks:0</output>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-activation-rebind-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
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
      controller.clickByRole({
        role: "button",
        name: "Funding source",
        exact: true,
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
      action: "click_by_role",
      outcome: "succeeded",
      actionDispatched: true,
      clickDispatched: true,
    });
  });
});
