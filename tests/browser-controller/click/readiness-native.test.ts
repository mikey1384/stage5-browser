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

describe("BrowserController exact click readiness and native controls", () => {
  it("reconciles a transient DOM-readiness warning when the document completes during stabilization", async () => {
    server = createServer((request, response) => {
      if (request.url === "/slow.js") {
        setTimeout(() => {
          response.writeHead(200, {
            "content-type": "application/javascript; charset=utf-8",
          });
          response.end('document.body.dataset.ready = "true";');
        }, 100);
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><html><head><title>Readiness reconciliation</title><script src="/slow.js"></script></head><body>Ready later</body></html>',
      );
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-readiness-"),
    );
    const config = { ...browserConfig(temporaryRoot), readinessTimeoutMs: 10 };
    controller = new BrowserController(config);

    const opened = await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 250,
      timeoutMs: 2_000,
    });
    expect(opened).toMatchObject({
      readiness: "domcontentloaded",
      page: { readyState: "complete" },
      warnings: [],
    });
  });

  it("bounds role resolution long enough for a transitioning control to appear", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Transitioning role</title></head><body>
        <div id="controls"></div>
        <a id="ready" href="#ready" hidden>Next step ready</a>
        <script>
          setTimeout(() => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = 'Continue';
            button.onclick = () => { document.querySelector('#ready').hidden = false; };
            document.querySelector('#controls').append(button);
          }, 250);
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-role-transition-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    await expect(
      controller.clickByRole({
        role: "button",
        name: "Continue",
        exact: true,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: null,
          expectedVisible: {
            role: "link",
            name: "Next step ready",
            exact: true,
            frameId: null,
          },
          timeoutMs: 1_000,
        },
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ postcondition: { passed: true } });
  });

  it("dispatches OneTrust-style consent buttons exactly once through the shared role/ref engine", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Consent fixture</title></head><body>
        <div id="onetrust-consent-sdk" role="dialog" aria-label="Privacy choices">
          <button id="reject" type="button" aria-selected="false">Reject all</button>
          <output id="result">click-count:0</output>
        </div>
        <script>
          let clicks = 0;
          document.querySelector('#reject').addEventListener('click', (event) => {
            clicks += 1;
            event.currentTarget.setAttribute('aria-selected', 'true');
            document.querySelector('#result').textContent = 'click-count:' + clicks;
          });
        </script>
      </body></html>`);
    });
    const port = await listen(server);

    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-consent-"),
    );
    for (const browser of ["chromium", "firefox"] as const) {
      const config = {
        ...browserConfig(temporaryRoot),
        browser,
        profileDir: path.join(temporaryRoot, "profiles", browser),
      };
      controller = new BrowserController(config, browser);
      const url = `http://127.0.0.1:${port}/${browser}`;
      await controller.open({
        url,
        newTab: false,
        stabilizationMs: 0,
        timeoutMs: 5_000,
      });
      await controller.clickByRole({
        role: "button",
        name: "Reject all",
        exact: true,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: true,
          expectedVisible: null,
          timeoutMs: 1_000,
        },
        timeoutMs: 3_000,
      });
      expect(
        (
          await controller.snapshot({
            depth: 5,
            boxes: false,
            frameId: null,
            timeoutMs: 2_000,
          })
        ).snapshot,
      ).toContain("click-count:1");

      await controller.open({
        url,
        newTab: false,
        stabilizationMs: 0,
        timeoutMs: 5_000,
      });
      const observed = await controller.snapshot({
        depth: 5,
        boxes: false,
        frameId: null,
        timeoutMs: 2_000,
      });
      const rejectRef = observed.snapshot.match(
        /button "Reject all"[^\n]*\[ref=([^\]]+)\]/,
      )?.[1];
      expect(rejectRef).toBeDefined();
      if (rejectRef === undefined)
        throw new Error("Consent fixture did not expose the Reject all ref.");
      await controller.clickRef({
        snapshotId: observed.snapshotId,
        ref: rejectRef,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: true,
          expectedVisible: null,
          timeoutMs: 1_000,
        },
        timeoutMs: 3_000,
      });
      expect(
        (
          await controller.snapshot({
            depth: 5,
            boxes: false,
            frameId: null,
            timeoutMs: 2_000,
          })
        ).snapshot,
      ).toContain("click-count:1");
      await controller.stop();
      controller = undefined;
    }
  });

  it("activates accessible native popup buttons without entering a replace-on-pointerdown sequence", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Popup opener replacement</title></head><body>
        <button id="opener" type="button" aria-haspopup="listbox" aria-expanded="false">
          Funding source
        </button>
        <div id="choices" role="listbox" aria-label="Funding choices" hidden>
          <div role="option">Business revenue</div>
        </div>
        <output id="counters">pointerdowns:0 clicks:0 replacement-clicks:0</output>
        <script>
          let pointerdowns = 0;
          let clicks = 0;
          let replacementClicks = 0;
          const renderCounters = () => {
            document.querySelector('#counters').textContent =
              'pointerdowns:' + pointerdowns +
              ' clicks:' + clicks +
              ' replacement-clicks:' + replacementClicks;
          };
          const wire = (button, replacement) => {
            button.addEventListener('pointerdown', () => {
              pointerdowns += 1;
              const next = button.cloneNode(true);
              wire(next, true);
              button.replaceWith(next);
              renderCounters();
            });
            button.addEventListener('click', (event) => {
              clicks += 1;
              if (replacement) replacementClicks += 1;
              event.currentTarget.setAttribute('aria-expanded', 'true');
              document.querySelector('#choices').hidden = false;
              renderCounters();
            });
          };
          wire(document.querySelector('#opener'), false);
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-popup-keyboard-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    const url = `http://127.0.0.1:${port}/popup`;

    for (const target of ["role", "ref"] as const) {
      await controller.open({
        url,
        newTab: false,
        stabilizationMs: 0,
        timeoutMs: 5_000,
      });
      const postcondition = {
        expectedUrl: null,
        expectedSelected: true,
        expectedVisible: null,
        timeoutMs: 1_000,
      } as const;
      if (target === "role") {
        await controller.clickByRole({
          role: "button",
          name: "Funding source",
          exact: true,
          frameId: null,
          postcondition,
          timeoutMs: 3_000,
        });
      } else {
        const observed = await controller.snapshot({
          depth: 6,
          boxes: false,
          frameId: null,
          timeoutMs: 2_000,
        });
        const openerRef = observed.snapshot.match(
          /button "Funding source"[^\n]*\[ref=([^\]]+)\]/,
        )?.[1];
        expect(openerRef).toBeDefined();
        if (openerRef === undefined)
          throw new Error("Popup fixture did not expose its opener ref.");
        await controller.clickRef({
          snapshotId: observed.snapshotId,
          ref: openerRef,
          frameId: null,
          postcondition,
          timeoutMs: 3_000,
        });
      }

      expect(
        (
          await controller.snapshot({
            depth: 6,
            boxes: false,
            frameId: null,
            timeoutMs: 2_000,
          })
        ).snapshot,
      ).toContain("pointerdowns:0 clicks:1 replacement-clicks:0");
      expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
        action: target === "role" ? "click_by_role" : "click_by_ref",
        outcome: "succeeded",
        actionDispatched: true,
        clickDispatched: true,
        dispatchEvidence: {
          forcedFallbackUsed: false,
          pageMouseFallbackUsed: false,
          pointerDownOnTarget: false,
          mouseDownOnTarget: false,
          pointerUpOnTarget: false,
          mouseUpOnTarget: false,
          clickOnTarget: true,
        },
      });
    }
  });

  it("activates a native React-style custom dropdown without splitting its pointer sequence", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Plain custom dropdown</title></head><body>
        <button id="opener" type="button">Customer location</button>
        <div id="choices" role="dialog" aria-label="Customer locations" hidden>
          <div role="option">United States</div>
        </div>
        <output id="counters">enterdowns:0 spacedowns:0 pointerdowns:0 mousedowns:0 clicks:0 replacements:0</output>
        <script>
          const counters = { enterdowns: 0, spacedowns: 0, pointerdowns: 0, mousedowns: 0, clicks: 0, replacements: 0 };
          const renderCounters = () => {
            document.querySelector('#counters').textContent =
              'enterdowns:' + counters.enterdowns +
              ' spacedowns:' + counters.spacedowns +
              ' pointerdowns:' + counters.pointerdowns +
              ' mousedowns:' + counters.mousedowns +
              ' clicks:' + counters.clicks +
              ' replacements:' + counters.replacements;
          };
          const wire = (button) => {
            button.addEventListener('keydown', (event) => {
              if (event.key === 'Enter') counters.enterdowns += 1;
              if (event.key === ' ') counters.spacedowns += 1;
              renderCounters();
            });
            button.addEventListener('pointerdown', () => { counters.pointerdowns += 1; renderCounters(); });
            button.addEventListener('mousedown', () => {
              counters.mousedowns += 1;
              const next = button.cloneNode(true);
              counters.replacements += 1;
              wire(next);
              button.replaceWith(next);
              renderCounters();
            });
            button.addEventListener('click', () => {
              counters.clicks += 1;
              document.querySelector('#choices').hidden = false;
              renderCounters();
            });
          };
          wire(document.querySelector('#opener'));
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-plain-popup-keyboard-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/popup`,
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
      /button "Customer location"[^\n]*\[ref=([^\]]+)\]/,
    )?.[1];
    expect(openerRef).toBeDefined();
    if (openerRef === undefined)
      throw new Error(
        "Plain custom dropdown fixture did not expose its opener ref.",
      );

    await expect(
      controller.clickRef({
        snapshotId: observed.snapshotId,
        ref: openerRef,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: null,
          expectedVisible: {
            role: "option",
            name: "United States",
            exact: true,
            frameId: null,
          },
          timeoutMs: 1_000,
        },
        timeoutMs: 3_000,
      }),
    ).resolves.toMatchObject({ postcondition: { passed: true } });
    const page = (controller as unknown as { activePage: Page }).activePage;
    await expect(page.locator("#counters").textContent()).resolves.toBe(
      "enterdowns:0 spacedowns:1 pointerdowns:0 mousedowns:0 clicks:1 replacements:0",
    );
  });
});
