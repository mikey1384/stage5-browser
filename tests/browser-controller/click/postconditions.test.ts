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

describe("BrowserController exact click postcondition reconciliation", () => {
  it("proves one exact option became hidden without returning its semantic name", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Hidden option postcondition</title></head><body>
        <div id="choices" role="listbox" aria-label="Funding choices">
          <div id="choice" role="option" tabindex="0">Operating revenue</div>
        </div>
        <output id="counters">clicks:0</output>
        <script>
          let clicks = 0;
          document.querySelector('#choice').addEventListener('click', () => {
            clicks += 1;
            document.querySelector('#choices').hidden = true;
            document.querySelector('#counters').textContent = 'clicks:' + clicks;
          });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-hidden-option-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/choice`,
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
    const optionRef = observed.snapshot.match(
      /option "Operating revenue"[^\n]*\[ref=([^\]]+)\]/,
    )?.[1];
    expect(optionRef).toBeDefined();
    if (optionRef === undefined)
      throw new Error("Option fixture did not expose its exact ref.");

    const result = await controller.clickRef({
      snapshotId: observed.snapshotId,
      ref: optionRef,
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
        timeoutMs: 1_000,
      },
      timeoutMs: 3_000,
    });

    expect(result.postcondition).toEqual({
      passed: true,
      checks: [
        { kind: "visible", passed: true, expected: false, observed: false },
      ],
    });
    expect(JSON.stringify(result.postcondition)).not.toContain(
      "Operating revenue",
    );
    const page = (controller as unknown as { activePage: Page }).activePage;
    await expect(page.locator("#counters").textContent()).resolves.toBe(
      "clicks:1",
    );
  });

  it("accepts exact-option disappearance as terminal success after partial pointer input without replay", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Partial hidden option effect</title></head><body>
        <div id="choices" role="listbox" aria-label="Funding choices">
          <div id="choice" role="option" tabindex="0">Operating revenue</div>
        </div>
        <output id="counters">pointerdowns:0 mousedowns:0 clicks:0</output>
        <script>
          const counters = { pointerdowns: 0, mousedowns: 0, clicks: 0 };
          const renderCounters = () => {
            document.querySelector('#counters').textContent =
              'pointerdowns:' + counters.pointerdowns +
              ' mousedowns:' + counters.mousedowns +
              ' clicks:' + counters.clicks;
          };
          const choice = document.querySelector('#choice');
          choice.addEventListener('pointerdown', () => {
            counters.pointerdowns += 1;
            renderCounters();
          });
          choice.addEventListener('mousedown', () => {
            counters.mousedowns += 1;
            choice.remove();
            renderCounters();
          });
          choice.addEventListener('click', () => {
            counters.clicks += 1;
            renderCounters();
          });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-partial-hidden-option-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/choice`,
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
    const optionRef = observed.snapshot.match(
      /option "Operating revenue"[^\n]*\[ref=([^\]]+)\]/,
    )?.[1];
    expect(optionRef).toBeDefined();
    if (optionRef === undefined)
      throw new Error("Partial option fixture did not expose its exact ref.");
    const dispatch = vi.spyOn(
      controller as unknown as {
        dispatchExactHandleClick: (...args: unknown[]) => Promise<void>;
      },
      "dispatchExactHandleClick",
    );

    await expect(
      controller.clickRef({
        snapshotId: observed.snapshotId,
        ref: optionRef,
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
          timeoutMs: 1_000,
        },
        timeoutMs: 3_000,
      }),
    ).resolves.toMatchObject({
      postcondition: {
        passed: true,
        checks: [
          { kind: "visible", passed: true, expected: false, observed: false },
        ],
      },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_ref",
      outcome: "succeeded",
      actionDispatched: true,
      clickDispatched: false,
      dispatchEvidence: {
        forcedFallbackUsed: false,
        pageMouseFallbackUsed: false,
        pointerDownOnTarget: true,
        mouseDownOnTarget: true,
        clickOnTarget: false,
      },
    });
    const page = (controller as unknown as { activePage: Page }).activePage;
    await expect(page.locator("#counters").textContent()).resolves.toBe(
      "pointerdowns:1 mousedowns:1 clicks:0",
    );
  });

  it("fails closed after one confirmed option click when the exact option remains visible", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Unmet hidden option effect</title></head><body>
        <div role="listbox" aria-label="Funding choices">
          <div id="choice" role="option" tabindex="0">Operating revenue</div>
        </div>
        <output id="counters">clicks:0</output>
        <script>
          let clicks = 0;
          document.querySelector('#choice').addEventListener('click', () => {
            clicks += 1;
            document.querySelector('#counters').textContent = 'clicks:' + clicks;
          });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-unmet-hidden-option-"),
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
        actionOutcome: "click_dispatched_postcondition_failed",
        checks: [
          { kind: "visible", passed: false, expected: false, observed: true },
        ],
        suggestedAction: expect.stringMatching(/do not repeat/i),
      },
    });
    const page = (controller as unknown as { activePage: Page }).activePage;
    await expect(page.locator("#counters").textContent()).resolves.toBe(
      "clicks:1",
    );
  });

  it("reports one exact opener-linked new page through an opt-in URL postcondition", async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(request.url === "/application"
        ? "<!doctype html><html><head><title>Application</title></head><body><h1>Application opened</h1></body></html>"
        : `<!doctype html><html><head><title>Landing</title></head><body>
          <button id="start" type="button">Get started</button>
          <script>start.addEventListener('click', () => window.open('/application', '_blank'));</script>
        </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "stage5-browser-new-page-postcondition-"));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/landing`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const original = (await controller.tabs()).pages[0];
    expect(original).toBeDefined();

    const clicked = await controller.clickByRole({
      role: "button",
      name: "Get started",
      exact: true,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedNewPageUrl: {
          url: `http://127.0.0.1:${port}/application`,
          match: "exact",
        },
        expectedSelected: null,
        expectedVisible: null,
        expectedHidden: null,
        timeoutMs: 2_000,
      },
      timeoutMs: 5_000,
    });
    expect(clicked.postcondition?.checks).toContainEqual({
      kind: "new_page_url",
      passed: true,
      expected: `http://127.0.0.1:${port}/application`,
      observed: `http://127.0.0.1:${port}/application`,
    });
    expect(clicked.newPageCount).toBe(1);
    expect(clicked.newPage).toMatchObject({
      url: `http://127.0.0.1:${port}/application`,
      openerTabId: original?.tabId,
    });
    expect(clicked.page.url).toBe(`http://127.0.0.1:${port}/landing`);
  });
});
