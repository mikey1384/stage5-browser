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

describe("BrowserController exact input", () => {
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

  it("uses one Space activation for a native popup when Enter would detach the opener", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Selection-intent keyboard activation</title></head><body>
        <button id="opener" type="button" aria-haspopup="menu">Account type</button>
        <div id="choices" role="menu" hidden>
          <div role="menuitem">Business operations</div>
        </div>
        <output id="counters">enterdowns:0 spacedowns:0 pointerdowns:0 clicks:0 replacements:0</output>
        <script>
          const counters = { enterdowns: 0, spacedowns: 0, pointerdowns: 0, clicks: 0, replacements: 0 };
          const renderCounters = () => {
            document.querySelector('#counters').textContent =
              'enterdowns:' + counters.enterdowns +
              ' spacedowns:' + counters.spacedowns +
              ' pointerdowns:' + counters.pointerdowns +
              ' clicks:' + counters.clicks +
              ' replacements:' + counters.replacements;
          };
          const wire = (button) => {
            button.addEventListener('keydown', (event) => {
              if (event.key === 'Enter') {
                counters.enterdowns += 1;
                counters.replacements += 1;
                const next = button.cloneNode(true);
                wire(next);
                button.replaceWith(next);
              }
              if (event.key === ' ') counters.spacedowns += 1;
              renderCounters();
            });
            button.addEventListener('pointerdown', () => { counters.pointerdowns += 1; renderCounters(); });
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
      path.join(os.tmpdir(), "stage5-browser-selection-space-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/popup`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    await expect(
      controller.clickByRole({
        role: "button",
        name: "Account type",
        exact: true,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: null,
          expectedVisible: {
            role: "menuitem",
            name: "Business operations",
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
      "enterdowns:0 spacedowns:1 pointerdowns:0 clicks:1 replacements:0",
    );
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_role",
      outcome: "succeeded",
      actionDispatched: true,
      clickDispatched: true,
      dispatchEvidence: {
        keyDownOnTarget: true,
        keyUpOnTarget: true,
        pointerDownOnTarget: false,
        clickOnTarget: true,
        targetConnectedAfter: true,
      },
    });
  });

  it("does not fall back when a selection-intent Space keydown detaches without opening options", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Selection-intent detachment</title></head><body>
        <button id="opener" type="button" aria-haspopup="menu">Account type</button>
        <output id="counters">enterdowns:0 spacedowns:0 pointerdowns:0 clicks:0 replacements:0 replacement-clicks:0</output>
        <script>
          const counters = {
            enterdowns: 0,
            spacedowns: 0,
            pointerdowns: 0,
            clicks: 0,
            replacements: 0,
            replacementClicks: 0,
          };
          const renderCounters = () => {
            document.querySelector('#counters').textContent =
              'enterdowns:' + counters.enterdowns +
              ' spacedowns:' + counters.spacedowns +
              ' pointerdowns:' + counters.pointerdowns +
              ' clicks:' + counters.clicks +
              ' replacements:' + counters.replacements +
              ' replacement-clicks:' + counters.replacementClicks;
          };
          const wire = (button, replacement) => {
            button.addEventListener('keydown', (event) => {
              if (event.key === 'Enter') counters.enterdowns += 1;
              if (event.key === ' ' && !replacement) {
                counters.spacedowns += 1;
                counters.replacements += 1;
                const next = button.cloneNode(true);
                wire(next, true);
                button.replaceWith(next);
              }
              renderCounters();
            });
            button.addEventListener('pointerdown', () => { counters.pointerdowns += 1; renderCounters(); });
            button.addEventListener('click', () => {
              counters.clicks += 1;
              if (replacement) counters.replacementClicks += 1;
              renderCounters();
            });
          };
          wire(document.querySelector('#opener'), false);
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-selection-space-detach-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/popup`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    await expect(
      controller.clickByRole({
        role: "button",
        name: "Account type",
        exact: true,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: null,
          expectedVisible: {
            role: "menuitem",
            name: "Business operations",
            exact: true,
            frameId: null,
          },
          timeoutMs: 500,
        },
        timeoutMs: 3_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "OPERATION_FAILED",
      details: {
        reason: "detached",
        actionDispatched: true,
        clickDispatched: false,
        suggestedAction: expect.stringMatching(/do not retry/i),
        dispatchEvidence: {
          keyDownOnTarget: true,
          keyUpOnTarget: false,
          pointerDownOnTarget: false,
          clickOnTarget: false,
          targetConnectedAfter: false,
        },
      },
    });

    const page = (controller as unknown as { activePage: Page }).activePage;
    await expect(page.locator("#counters").textContent()).resolves.toBe(
      "enterdowns:0 spacedowns:1 pointerdowns:0 clicks:0 replacements:1 replacement-clicks:0",
    );
  });

  it("never falls back or replays when a popup opener detaches during keyboard activation", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Popup keyboard replacement</title></head><body>
        <button id="opener" type="button" aria-haspopup="listbox" aria-expanded="false">
          Funding source
        </button>
        <output id="counters">keydowns:0 pointerdowns:0 clicks:0 replacements:0 replacement-clicks:0</output>
        <script>
          const counters = { keydowns: 0, pointerdowns: 0, clicks: 0, replacements: 0, replacementClicks: 0 };
          const renderCounters = () => {
            document.querySelector('#counters').textContent =
              'keydowns:' + counters.keydowns +
              ' pointerdowns:' + counters.pointerdowns +
              ' clicks:' + counters.clicks +
              ' replacements:' + counters.replacements +
              ' replacement-clicks:' + counters.replacementClicks;
          };
          const wire = (button, replacement) => {
            button.addEventListener('pointerdown', () => { counters.pointerdowns += 1; renderCounters(); });
            button.addEventListener('keydown', (event) => {
              if (event.key !== 'Enter') return;
              counters.keydowns += 1;
              if (!replacement) {
                const next = button.cloneNode(true);
                counters.replacements += 1;
                wire(next, true);
                button.replaceWith(next);
              }
              renderCounters();
            });
            button.addEventListener('click', () => {
              counters.clicks += 1;
              if (replacement) counters.replacementClicks += 1;
              renderCounters();
            });
          };
          wire(document.querySelector('#opener'), false);
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-popup-keyboard-detach-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/popup`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    let failure: Stage5BrowserError | null = null;
    try {
      await controller.clickByRole({
        role: "button",
        name: "Funding source",
        exact: true,
        frameId: null,
        postcondition: null,
        timeoutMs: 3_000,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Stage5BrowserError);
      failure = error as Stage5BrowserError;
    }
    expect(failure).not.toBeNull();
    expect(failure).toMatchObject({
      code: "OPERATION_FAILED",
      details: {
        reason: "detached",
        actionDispatched: true,
        clickDispatched: false,
        suggestedAction: expect.stringMatching(/do not retry/i),
        dispatchEvidence: {
          forcedFallbackUsed: false,
          pageMouseFallbackUsed: false,
          keyDownOnTarget: true,
          pointerDownOnTarget: false,
          mouseDownOnTarget: false,
          clickOnTarget: false,
          targetConnectedAfter: false,
        },
      },
    });
    expect(
      (
        await controller.snapshot({
          depth: 6,
          boxes: false,
          frameId: null,
          timeoutMs: 2_000,
        })
      ).snapshot,
    ).toContain(
      "keydowns:1 pointerdowns:0 clicks:0 replacements:1 replacement-clicks:0",
    );
  });

  it("accepts an observed opener postcondition after detached partial keyboard input without replay", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Partial keyboard effect</title></head><body>
        <button id="opener" type="button" aria-haspopup="menu">Intended use</button>
        <div id="menu" role="menu" hidden>
          <div role="menuitem">Business operations</div>
        </div>
        <output id="counters">keydowns:0 pointerdowns:0 clicks:0 replacements:0</output>
        <script>
          const counters = { keydowns: 0, pointerdowns: 0, clicks: 0, replacements: 0 };
          const renderCounters = () => {
            document.querySelector('#counters').textContent =
              'keydowns:' + counters.keydowns +
              ' pointerdowns:' + counters.pointerdowns +
              ' clicks:' + counters.clicks +
              ' replacements:' + counters.replacements;
          };
          const opener = document.querySelector('#opener');
          opener.addEventListener('pointerdown', () => {
            counters.pointerdowns += 1;
            renderCounters();
          });
          opener.addEventListener('keydown', (event) => {
            if (event.key !== ' ') return;
            counters.keydowns += 1;
            counters.replacements += 1;
            document.querySelector('#menu').hidden = false;
            opener.replaceWith(opener.cloneNode(true));
            renderCounters();
          });
          opener.addEventListener('click', () => {
            counters.clicks += 1;
            renderCounters();
          });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-partial-keyboard-effect-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/intended-use`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 2_000,
    });
    const openerRef = observed.snapshot.match(
      /button "Intended use"[^\n]*\[ref=([^\]]+)\]/,
    )?.[1];
    expect(openerRef).toBeDefined();
    if (openerRef === undefined)
      throw new Error("Fixture did not expose the opener reference.");

    await expect(
      controller.clickRef({
        snapshotId: observed.snapshotId,
        ref: openerRef,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: null,
          expectedVisible: {
            role: "menuitem",
            name: "Business operations",
            exact: true,
            frameId: null,
          },
          timeoutMs: 1_000,
        },
        timeoutMs: 3_000,
      }),
    ).resolves.toMatchObject({ postcondition: { passed: true } });
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_ref",
      outcome: "succeeded",
      actionDispatched: true,
      clickDispatched: false,
      dispatchEvidence: {
        keyDownOnTarget: true,
        keyUpOnTarget: false,
        pointerDownOnTarget: false,
        clickOnTarget: false,
        targetConnectedAfter: false,
        forcedFallbackUsed: false,
        pageMouseFallbackUsed: false,
      },
    });
    expect(
      (
        await controller.snapshot({
          depth: 8,
          boxes: false,
          frameId: null,
          timeoutMs: 2_000,
        })
      ).snapshot,
    ).toContain("keydowns:1 pointerdowns:0 clicks:0 replacements:1");
  });

  it("clicks one exact generic pointer-text option ref with a bounded semantic postcondition", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Generic pointer-text options</title></head><body>
        <div id="surface" style="height: 72px; overflow-y: auto">
          <div id="target" style="cursor: pointer">Business operations</div>
          <div style="cursor: pointer">Treasury management</div>
          <div style="cursor: pointer">Vendor payments</div>
          <div style="cursor: pointer">Payroll</div>
        </div>
        <a id="result" href="#recorded" hidden>Choice recorded</a>
        <output id="counters">target-clicks:0 other-clicks:0</output>
        <script>
          let targetClicks = 0;
          let otherClicks = 0;
          const renderCounters = () => {
            document.querySelector('#counters').textContent =
              'target-clicks:' + targetClicks + ' other-clicks:' + otherClicks;
          };
          document.querySelector('#target').addEventListener('click', () => {
            targetClicks += 1;
            document.querySelector('#result').hidden = false;
            renderCounters();
          });
          for (const option of document.querySelectorAll('#surface > div:not(#target)')) {
            option.addEventListener('click', () => {
              otherClicks += 1;
              renderCounters();
            });
          }
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-generic-pointer-option-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/generic-options`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 2_000,
    });
    const targetRef = observed.snapshot.match(
      /generic \[ref=([^\]]+)\] \[cursor=pointer\]: Business operations/,
    )?.[1];
    expect(targetRef).toBeDefined();
    if (targetRef === undefined)
      throw new Error("Fixture did not expose the exact generic option ref.");

    await expect(
      controller.clickRef({
        snapshotId: observed.snapshotId,
        ref: targetRef,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: null,
          expectedVisible: {
            role: "link",
            name: "Choice recorded",
            exact: true,
            frameId: null,
          },
          timeoutMs: 1_000,
        },
        timeoutMs: 3_000,
      }),
    ).resolves.toMatchObject({ postcondition: { passed: true } });
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_ref",
      outcome: "succeeded",
      actionDispatched: true,
      clickDispatched: true,
      dispatchEvidence: {
        pointerDownOnTarget: true,
        clickOnTarget: true,
        forcedFallbackUsed: false,
        pageMouseFallbackUsed: false,
      },
    });
    expect(
      (
        await controller.snapshot({
          depth: 8,
          boxes: false,
          frameId: null,
          timeoutMs: 2_000,
        })
      ).snapshot,
    ).toContain("target-clicks:1 other-clicks:0");
  });

  it("adds viewport-filtered deep semantic detail for an observed custom-option scroll container", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Deep custom options</title></head><body>
        <div id="surface" style="height: 40px; overflow-y: auto">
          <div><div><div><div><div><div><div><div id="target">Business operations</div></div></div></div></div></div></div></div>
          <div><div><div><div><div><div><div><div>Treasury management</div></div></div></div></div></div></div></div>
          <div><div><div><div><div><div><div><div>Vendor payments</div></div></div></div></div></div></div></div>
          <div><div><div><div><div><div><div><div>Payroll</div></div></div></div></div></div></div></div>
        </div>
        <a id="result" href="#recorded" hidden>Choice recorded</a>
        <output id="counters">target-clicks:0</output>
        <script>
          let targetClicks = 0;
          document.querySelector('#target').addEventListener('click', () => {
            targetClicks += 1;
            document.querySelector('#result').hidden = false;
            document.querySelector('#counters').textContent = 'target-clicks:' + targetClicks;
          });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-deep-scroll-options-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/deep-options`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const observed = await controller.snapshot({
      depth: 3,
      boxes: false,
      frameId: null,
      timeoutMs: 4_000,
    });
    expect(observed.scrollContainers).toEqual(
      expect.arrayContaining([expect.objectContaining({ inViewport: true })]),
    );
    expect(observed.snapshot).toMatch(
      /# Visible semantic detail for scroll-[A-Za-z0-9_-]+ \(bounded\)/,
    );
    const targetRefs = [
      ...observed.snapshot.matchAll(
        /generic \[ref=([^\]]+)\](?: \[[^\]]+\])?: Business operations/g,
      ),
    ]
      .map((match) => match[1])
      .filter((ref): ref is string => ref !== undefined);
    const targetRef = targetRefs.at(-1);
    expect(targetRef).toBeDefined();
    if (targetRef === undefined)
      throw new Error("Deep detail did not expose an exact option ref.");

    await expect(
      controller.clickRef({
        snapshotId: observed.snapshotId,
        ref: targetRef,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: null,
          expectedVisible: {
            role: "link",
            name: "Choice recorded",
            exact: true,
            frameId: null,
          },
          timeoutMs: 1_000,
        },
        timeoutMs: 3_000,
      }),
    ).resolves.toMatchObject({ postcondition: { passed: true } });
    expect(
      (
        await controller.snapshot({
          depth: 8,
          boxes: false,
          frameId: null,
          timeoutMs: 2_000,
        })
      ).snapshot,
    ).toContain("target-clicks:1");
  });

  it("reports definite no-dispatch when a native dropdown opener detaches while press is focusing it", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Pre-keyboard replacement</title></head><body>
        <button id="opener" type="button" aria-haspopup="listbox" aria-expanded="false">Funding source</button>
        <output id="counters">focuses:0 keydowns:0 clicks:0 replacements:0</output>
        <script>
          const counters = { focuses: 0, keydowns: 0, clicks: 0, replacements: 0 };
          const renderCounters = () => {
            document.querySelector('#counters').textContent =
              'focuses:' + counters.focuses +
              ' keydowns:' + counters.keydowns +
              ' clicks:' + counters.clicks +
              ' replacements:' + counters.replacements;
          };
          const opener = document.querySelector('#opener');
          opener.addEventListener('focus', () => {
            counters.focuses += 1;
            counters.replacements += 1;
            opener.replaceWith(opener.cloneNode(true));
            renderCounters();
          }, { once: true });
          opener.addEventListener('keydown', () => { counters.keydowns += 1; renderCounters(); });
          opener.addEventListener('click', () => { counters.clicks += 1; renderCounters(); });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-popup-pre-keyboard-detach-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/popup`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    await expect(
      controller.clickByRole({
        role: "button",
        name: "Funding source",
        exact: true,
        frameId: null,
        postcondition: null,
        timeoutMs: 3_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "OPERATION_FAILED",
      details: {
        reason: "detached",
        actionDispatched: false,
        clickDispatched: false,
        dispatchEvidence: {
          trustedEventObserved: true,
          keyDownOnTarget: false,
          keyUpOnTarget: false,
          pointerDownOnTarget: false,
          mouseDownOnTarget: false,
          clickOnTarget: false,
          targetConnectedAfter: false,
          misdirectedEventBlocked: true,
        },
      },
    });
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_role",
      outcome: "blocked",
      reason: "detached",
      actionDispatched: false,
      clickDispatched: false,
    });
    expect(
      (
        await controller.snapshot({
          depth: 6,
          boxes: false,
          frameId: null,
          timeoutMs: 2_000,
        })
      ).snapshot,
    ).toContain("focuses:1 keydowns:0 clicks:0 replacements:1");
  });

  it("re-resolves one unique role target when scrolling replaces it before any input", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Pre-input role replacement</title><style>
        body { margin: 0; min-height: 4200px; }
        #opener { position: absolute; top: 3200px; left: 40px; }
        #choices { position: absolute; top: 3250px; left: 40px; }
        #counters { position: fixed; top: 10px; left: 10px; }
      </style></head><body>
        <button id="opener" type="button" aria-haspopup="listbox" aria-expanded="false">
          Account purpose
        </button>
        <div id="choices" role="listbox" aria-label="Account purposes" hidden>
          <div role="option">Business operations</div>
        </div>
        <output id="counters">replacements:0 clicks:0</output>
        <script>
          let replacements = 0;
          let clicks = 0;
          const renderCounters = () => {
            document.querySelector('#counters').textContent =
              'replacements:' + replacements + ' clicks:' + clicks;
          };
          const wire = (button) => {
            button.addEventListener('click', (event) => {
              clicks += 1;
              event.currentTarget.setAttribute('aria-expanded', 'true');
              document.querySelector('#choices').hidden = false;
              renderCounters();
            });
          };
          wire(document.querySelector('#opener'));
          addEventListener('scroll', () => {
            if (replacements !== 0) return;
            const current = document.querySelector('#opener');
            const next = current.cloneNode(true);
            replacements += 1;
            wire(next);
            current.replaceWith(next);
            renderCounters();
          }, { passive: true });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-role-reresolve-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/popup`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    await expect(
      controller.clickByRole({
        role: "button",
        name: "Account purpose",
        exact: true,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: null,
          expectedVisible: {
            role: "option",
            name: "Business operations",
            exact: true,
            frameId: null,
          },
          timeoutMs: 1_000,
        },
        timeoutMs: 4_000,
      }),
    ).resolves.toMatchObject({ postcondition: { passed: true } });
    expect(
      (
        await controller.snapshot({
          depth: 6,
          boxes: false,
          frameId: null,
          timeoutMs: 2_000,
        })
      ).snapshot,
    ).toContain("replacements:1 clicks:1");
  });

  it("reports pointer-sequence replacement as non-retriable partial input without fallback", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Partial pointer replacement</title></head><body>
        <div id="opener" role="button" tabindex="0">Account purpose</div>
        <output id="counters">pointerdowns:0 mousedowns:0 pointerups:0 mouseups:0 clicks:0 replacements:0 replacement-clicks:0</output>
        <script>
          const counters = {
            pointerdowns: 0,
            mousedowns: 0,
            pointerups: 0,
            mouseups: 0,
            clicks: 0,
            replacements: 0,
            replacementClicks: 0,
          };
          const renderCounters = () => {
            document.querySelector('#counters').textContent =
              'pointerdowns:' + counters.pointerdowns +
              ' mousedowns:' + counters.mousedowns +
              ' pointerups:' + counters.pointerups +
              ' mouseups:' + counters.mouseups +
              ' clicks:' + counters.clicks +
              ' replacements:' + counters.replacements +
              ' replacement-clicks:' + counters.replacementClicks;
          };
          const wire = (button, replacement) => {
            button.addEventListener('pointerdown', () => { counters.pointerdowns += 1; renderCounters(); });
            button.addEventListener('mousedown', () => {
              counters.mousedowns += 1;
              if (!replacement) {
                const next = button.cloneNode(true);
                counters.replacements += 1;
                wire(next, true);
                button.replaceWith(next);
              }
              renderCounters();
            });
            button.addEventListener('pointerup', () => { counters.pointerups += 1; renderCounters(); });
            button.addEventListener('mouseup', () => { counters.mouseups += 1; renderCounters(); });
            button.addEventListener('click', () => {
              counters.clicks += 1;
              if (replacement) counters.replacementClicks += 1;
              renderCounters();
            });
          };
          wire(document.querySelector('#opener'), false);
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-partial-pointer-"),
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
      /button "Account purpose"[^\n]*\[ref=([^\]]+)\]/,
    )?.[1];
    expect(openerRef).toBeDefined();
    if (openerRef === undefined)
      throw new Error("Partial-pointer fixture did not expose its opener ref.");
    const dispatch = vi.spyOn(
      controller as unknown as {
        dispatchExactHandleClick: (...args: unknown[]) => Promise<void>;
      },
      "dispatchExactHandleClick",
    );

    await expect(
      controller.clickRef({
        snapshotId: observed.snapshotId,
        ref: openerRef,
        frameId: null,
        postcondition: null,
        timeoutMs: 3_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "OPERATION_FAILED",
      details: {
        reason: "detached",
        actionDispatched: true,
        clickDispatched: false,
        suggestedAction: expect.stringMatching(/do not retry/i),
        dispatchEvidence: {
          forcedFallbackUsed: false,
          pageMouseFallbackUsed: false,
          trustedEventObserved: true,
          pointerDownOnTarget: true,
          mouseDownOnTarget: true,
          pointerUpOnTarget: false,
          mouseUpOnTarget: false,
          clickOnTarget: false,
          targetConnectedAfter: false,
        },
      },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_ref",
      outcome: "failed",
      reason: "detached",
      actionDispatched: true,
      clickDispatched: false,
    });
    const after = await controller.snapshot({
      depth: 6,
      boxes: false,
      frameId: null,
      timeoutMs: 2_000,
    });
    expect(after.snapshot).toContain(
      "pointerdowns:1 mousedowns:1 pointerups:0 mouseups:0 clicks:0 replacements:1 replacement-clicks:0",
    );
    await expect(
      controller.clickRef({
        snapshotId: observed.snapshotId,
        ref: openerRef,
        frameId: null,
        postcondition: null,
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "TARGET_NOT_FOUND",
      details: { reason: "stale_or_unknown_snapshot" },
    });
    expect(
      (
        await controller.snapshot({
          depth: 6,
          boxes: false,
          frameId: null,
          timeoutMs: 2_000,
        })
      ).snapshot,
    ).toContain("replacements:1 replacement-clicks:0");
  });

  it("accepts an observed postcondition as the terminal result after partial exact-target input", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Partial effect reconciliation</title></head><body>
        <div id="validate" role="button" tabindex="0">Check description</div>
        <a href="#validated" id="result" hidden>Looks good</a>
        <output id="counters">downs:0 clicks:0 replacement-clicks:0</output>
        <script>
          let downs = 0;
          let clicks = 0;
          let replacementClicks = 0;
          const wire = (button, replacement) => {
            button.addEventListener('mousedown', () => {
              downs += 1;
              document.querySelector('#result').hidden = false;
              if (!replacement) {
                const next = button.cloneNode(true);
                wire(next, true);
                button.replaceWith(next);
              }
              document.querySelector('#counters').textContent =
                'downs:' + downs + ' clicks:' + clicks + ' replacement-clicks:' + replacementClicks;
            });
            button.addEventListener('click', () => {
              clicks += 1;
              if (replacement) replacementClicks += 1;
            });
          };
          wire(document.querySelector('#validate'), false);
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-partial-effect-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/validate`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    await expect(
      controller.clickByRole({
        role: "button",
        name: "Check description",
        exact: true,
        frameId: null,
        postcondition: {
          expectedUrl: null,
          expectedSelected: null,
          expectedVisible: {
            role: "link",
            name: "Looks good",
            exact: true,
            frameId: null,
          },
          timeoutMs: 1_000,
        },
        timeoutMs: 3_000,
      }),
    ).resolves.toMatchObject({ postcondition: { passed: true } });
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_role",
      outcome: "succeeded",
      actionDispatched: true,
      clickDispatched: false,
      dispatchEvidence: {
        pointerDownOnTarget: true,
        mouseDownOnTarget: true,
        clickOnTarget: false,
      },
    });
    expect(
      (
        await controller.snapshot({
          depth: 6,
          boxes: false,
          frameId: null,
          timeoutMs: 2_000,
        })
      ).snapshot,
    ).toContain("downs:1 clicks:0 replacement-clicks:0");
  });

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

  it("fails closed when activation creates multiple in-scope semantic replacements for a fresh ref", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Ambiguous reference replacement</title></head><body>
        <div role="dialog" aria-modal="true" aria-label="Business details">
          <button id="opener" type="button" onclick="document.querySelector('#counter').textContent = 'clicks:1'">
            Funding source
          </button>
          <output id="counter">clicks:0</output>
        </div>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-ref-activation-ambiguous-"),
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
      /button "Funding source"[^\n]*\[ref=([^\]]+)\]/,
    )?.[1];
    expect(openerRef).toBeDefined();
    if (openerRef === undefined)
      throw new Error(
        "Ambiguous replacement fixture did not expose its opener ref.",
      );

    const page = (controller as unknown as { activePage: Page }).activePage;
    vi.spyOn(
      controller as unknown as {
        activateSelectedPageForInput: (
          ...args: unknown[]
        ) => Promise<SanitizedPageActivationEvidence>;
      },
      "activateSelectedPageForInput",
    ).mockImplementation(async (...args) => {
      const attemptCount = typeof args[1] === "number" ? args[1] : 1;
      if (attemptCount === 1) {
        await page.locator("#opener").evaluate((opener) => {
          const first = opener.cloneNode(true);
          const second = opener.cloneNode(true);
          opener.replaceWith(first, second);
        });
      }
      return {
        attemptCount,
        controllerSelected: true,
        bringToFrontAttempted: attemptCount === 1,
        bringToFrontSucceeded: true,
        visibilityBefore: attemptCount === 1 ? "hidden" : "visible",
        visibilityAfter: "visible",
        documentFocusedBefore: false,
        documentFocusedAfter: true,
        nativeWindow: {
          required: attemptCount === 1,
          attempted: attemptCount === 1,
          supported: true,
          ownedProcessAvailable: true,
          ownedProcessRunning: true,
          targetWindowResolved: true,
          windowStateBefore: "normal",
          normalizationAttempted: false,
          normalizationSucceeded: null,
          applicationActivationAttempted: attemptCount === 1,
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
          result: attemptCount === 1 ? "activated" : "not_required",
        },
      };
    });

    await expect(
      controller.clickRef({
        snapshotId: observed.snapshotId,
        ref: openerRef,
        frameId: null,
        postcondition: null,
        timeoutMs: 3_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "AMBIGUOUS_TARGET",
      details: {
        reason: "reference_semantic_rebind_ambiguous",
        actionDispatched: false,
        clickDispatched: false,
      },
    });
    await expect(page.locator("#counter").textContent()).resolves.toBe(
      "clicks:0",
    );
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_ref",
      outcome: "blocked",
      reason: "ambiguous_target",
      actionDispatched: false,
      clickDispatched: false,
    });
  });

  it("hit-tests the visible clipped portion of a target inside an overflow container", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Clipped actionability</title><style>
        #dialog { position: relative; width: 320px; height: 80px; overflow: hidden; }
        #target { position: absolute; top: 60px; left: 10px; width: 180px; height: 100px; }
      </style></head><body>
        <div id="dialog" role="dialog" aria-label="Business details">
          <button id="target" type="button">Visible clipped control</button>
        </div>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-clipped-target-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const page = (controller as unknown as { activePage: Page }).activePage;
    const state = await inspectTargetState(page.locator("#target") as Locator);
    expect(state).toMatchObject({
      visible: true,
      enabled: true,
      inViewport: true,
      receivesPointerEvents: true,
      coveredBy: null,
    });
  });

  it("recaptures a suspiciously uniform screenshot when semantic content exists", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Uniform canvas</title><style>
        html, body { margin: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
        canvas { display: block; width: 1px; height: 1px; }
      </style></head><body><canvas aria-label="Managed render surface"></canvas></body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-uniform-capture-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const screenshot = await controller.screenshot({
      fullPage: false,
      timeoutMs: 5_000,
    });
    expect(screenshot.captureEvidence).toMatchObject({
      artifactClassification: "possibly_uniform",
      semanticContentPresent: true,
      retryUsed: true,
      pageActivation: {
        controllerSelected: true,
        visibilityAfter: "visible",
      },
    });
  });

  it("keeps an auxiliary player from stealing the active tab and recovers the sole remaining tab", async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (request.url === "/player") {
        response.end(`<!doctype html><html><head><title>Embedded player</title></head><body>
          <h1>YouTube player</h1>
          <script>setTimeout(() => window.close(), 150)</script>
        </body></html>`);
        return;
      }
      response.end(`<!doctype html><html><head><title>X post</title></head><body>
        <h1>X post verification</h1>
        <button type="button" onclick="window.open('/player', 'youtube-player')">Open player</button>
      </body></html>`);
    });
    const port = await listen(server);
    const postUrl = `http://127.0.0.1:${port}/post`;

    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-active-tab-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: postUrl,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    await controller.clickByRole({
      role: "button",
      name: "Open player",
      exact: true,
      frameId: null,
      postcondition: null,
      timeoutMs: 5_000,
    });

    const whilePlayerIsOpen = await controller.snapshot({
      depth: 6,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(whilePlayerIsOpen.page.url).toBe(postUrl);
    expect(whilePlayerIsOpen.snapshot).toContain("X post verification");
    expect(whilePlayerIsOpen.snapshot).not.toContain("YouTube player");

    await new Promise((resolve) => setTimeout(resolve, 250));
    const tabs = await controller.tabs();
    expect(tabs.pages).toHaveLength(1);
    expect(tabs.pages[0]?.url).toBe(postUrl);
    expect(tabs.activePageIndex).toBe(0);
  });

  it("restores the exact opaque Chromium target instead of choosing among duplicate tabs", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><head><title>Duplicate application</title></head><body>Application</body></html>",
      );
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-target-continuity-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/application`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const firstPage = (controller as unknown as { activePage: Page })
      .activePage;
    await controller.open({
      url: `http://127.0.0.1:${port}/application`,
      newTab: true,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const internals = controller as unknown as {
      activePage: Page;
      nativeControlRecord: NativeControlRecord | null;
      chromiumTargetId: (page: Page) => Promise<string | null>;
      restoreNativeSelectedPage: (pages: Page[]) => Promise<Page | null>;
    };
    const secondPage = internals.activePage;
    const selectedTargetId = await internals.chromiumTargetId(firstPage);
    expect(selectedTargetId).not.toBeNull();
    internals.nativeControlRecord = {
      version: 1,
      kind: "chromium_cdp",
      browser: "chromium",
      state: "controlled",
      processId: process.pid,
      port: 29_123,
      createdAt: "2026-08-25T00:00:00.000Z",
      selectedTargetId,
    };

    await expect(
      internals.restoreNativeSelectedPage([secondPage, firstPage]),
    ).resolves.toBe(firstPage);
  });

  it("returns bounded unique rendered-line context around text matches", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Noisy social feed</title></head><body>
        <nav>Management navigation</nav>
        <article>
          <h2>Concise Korean video title</h2>
          <blockquote>Repeated quoted context</blockquote>
          <blockquote>Repeated quoted context</blockquote>
          <blockquote>Repeated quoted context</blockquote>
          <p>The Economist interview excerpt</p>
          <a href="https://example.com/post/123">Corresponding social post link</a>
          <p>Full thumbnail beneath the link</p>
        </article>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-find-context-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const found = await controller.findText({
      query: "Economist",
      mode: "contains",
      caseSensitive: false,
      maxResults: 10,
      frameId: null,
      timeoutMs: 5_000,
    });

    expect(found).toMatchObject({
      matchCount: 1,
      returnedCount: 1,
      truncated: false,
    });
    const snippet = found.matches[0]?.snippet ?? "";
    expect(snippet.split("\n")).toHaveLength(5);
    expect(snippet).toContain("Concise Korean video title");
    expect(snippet).toContain("Repeated quoted context");
    expect(snippet.match(/Repeated quoted context/g)).toHaveLength(1);
    expect(snippet).toMatch(/> \d+: The Economist interview excerpt/);
    expect(snippet).toContain("Corresponding social post link");
    expect(snippet).toContain("Full thumbnail beneath the link");
  });

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

  it("activates the selected page and uses page mouse only after both handle paths emit zero events", async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (request.url === "/auxiliary") {
        response.end(
          "<!doctype html><html><head><title>Auxiliary tab</title></head><body>Auxiliary</body></html>",
        );
        return;
      }
      response.end(`<!doctype html><html><head><title>Foreground dispatch target</title></head><body>
        <button type="button" onclick="window.open('/auxiliary', 'auxiliary')">Open auxiliary</button>
        <div id="target" role="button" tabindex="0"
          onclick="document.querySelector('#expanded').hidden = false">See more</div>
        <a id="expanded" href="#expanded" hidden>Expanded foreground caption</a>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-page-mouse-dispatch-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/post`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    await controller.clickByRole({
      role: "button",
      name: "Open auxiliary",
      exact: true,
      frameId: null,
      postcondition: null,
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
        "Fixture did not expose the foreground exact-target reference.",
      );
    }

    const exactHandleDispatch = vi.spyOn(
      controller as unknown as {
        dispatchExactHandleClick: () => Promise<void>;
      },
      "dispatchExactHandleClick",
    );
    exactHandleDispatch
      .mockRejectedValueOnce(
        new Error(
          "Timeout 750ms exceeded while waiting for element stability.",
        ),
      )
      .mockRejectedValueOnce(
        new Error(
          "The forced exact-handle transport returned without an event.",
        ),
      );

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
            name: "Expanded foreground caption",
            exact: true,
            frameId: null,
          },
          timeoutMs: 1_000,
        },
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ postcondition: { passed: true } });
    expect(exactHandleDispatch).toHaveBeenCalledTimes(2);
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_ref",
      outcome: "succeeded",
      actionDispatched: true,
      clickDispatched: true,
      dispatchEvidence: {
        strategy: "guarded_exact_handle",
        forcedFallbackUsed: true,
        pageMouseFallbackUsed: true,
        pageActivation: {
          attemptCount: 1,
          controllerSelected: true,
          bringToFrontAttempted: false,
          bringToFrontSucceeded: false,
          visibilityAfter: "visible",
          documentFocusedAfter: true,
        },
        guardExpired: false,
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

  it("restores the exact owned Chromium window before dispatch when the selected page stays hidden", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Native activation target</title></head><body>
        <button id="target" type="button"
          onclick="document.querySelector('#expanded').hidden = false">See more</button>
        <a id="expanded" href="#expanded" hidden>Expanded after native activation</a>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-native-activation-"),
    );
    const config = browserConfig(temporaryRoot);
    let nativeApplicationActivated = false;
    const activateOwnedProcess = vi.fn(async () => {
      nativeApplicationActivated = true;
      return {
        attempted: true,
        supported: true,
        ownedProcessRunning: true,
        applicationActivated: false,
        applicationHiddenBefore: true,
        unhideAttempted: true,
        unhideSucceeded: true,
        activationRequestAccepted: true,
        frontProcessFallbackAttempted: true,
        frontProcessFallbackProcessResolved: true,
        frontProcessFallbackRequestSucceeded: true,
        applicationFrontmostAfter: false,
        applicationHiddenAfter: false,
        reason: "activation_state_unverified" as const,
      };
    });
    const activator: OwnedBrowserWindowActivator = {
      supported: true,
      activateOwnedProcess,
    };
    controller = new BrowserController(
      config,
      config.browser,
      undefined,
      undefined,
      undefined,
      undefined,
      activator,
    );
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
    const seeMoreRef = observed.snapshot
      .split("\n")
      .find((line) => line.includes("See more"))
      ?.match(/\[ref=([^\]]+)\]/)?.[1];
    expect(seeMoreRef).toBeDefined();
    if (seeMoreRef === undefined) {
      throw new Error(
        "Fixture did not expose the native-activation target reference.",
      );
    }

    config.headless = false;
    const internals = controller as unknown as {
      controlledBrowserProcessId: number | null;
      observePageActivation: () => Promise<{
        documentFocused: boolean | null;
        visibility: "hidden" | "prerender" | "unknown" | "visible";
      }>;
      prepareChromiumTargetWindow: () => Promise<{
        targetWindowResolved: boolean;
        windowStateBefore:
          | "fullscreen"
          | "maximized"
          | "minimized"
          | "normal"
          | "unknown";
        normalizationAttempted: boolean;
        normalizationSucceeded: boolean | null;
      }>;
    };
    internals.controlledBrowserProcessId = 42_424;
    vi.spyOn(internals, "observePageActivation").mockImplementation(
      async () => ({
        documentFocused: true,
        visibility: nativeApplicationActivated ? "visible" : "hidden",
      }),
    );
    const prepareWindow = vi
      .spyOn(internals, "prepareChromiumTargetWindow")
      .mockResolvedValue({
        targetWindowResolved: true,
        windowStateBefore: "minimized",
        normalizationAttempted: true,
        normalizationSucceeded: true,
      });

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
            name: "Expanded after native activation",
            exact: true,
            frameId: null,
          },
          timeoutMs: 1_000,
        },
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ postcondition: { passed: true } });
    expect(prepareWindow).toHaveBeenCalledTimes(1);
    expect(activateOwnedProcess).toHaveBeenCalledWith(42_424, 1_000);
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_ref",
      outcome: "succeeded",
      actionDispatched: true,
      dispatchEvidence: {
        pageActivation: {
          visibilityBefore: "hidden",
          visibilityAfter: "visible",
          nativeWindow: {
            required: true,
            attempted: true,
            ownedProcessAvailable: true,
            ownedProcessRunning: true,
            targetWindowResolved: true,
            windowStateBefore: "minimized",
            normalizationAttempted: true,
            normalizationSucceeded: true,
            applicationActivationAttempted: true,
            applicationActivationSucceeded: false,
            activationRequestAccepted: true,
            frontProcessFallbackAttempted: true,
            frontProcessFallbackProcessResolved: true,
            frontProcessFallbackRequestSucceeded: true,
            applicationFrontmostAfter: false,
            result: "activated",
          },
        },
      },
    });
  });

  it("dispatches no input when native activation cannot make the selected page visible", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Hidden native target</title></head><body>
        <button id="target" type="button"
          onclick="document.querySelector('#danger').hidden = false">See more</button>
        <p id="danger" hidden>Input was dispatched</p>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-native-hidden-"),
    );
    const config = browserConfig(temporaryRoot);
    const activateOwnedProcess = vi.fn(async () => ({
      attempted: true,
      supported: true,
      ownedProcessRunning: true,
      applicationActivated: true,
      applicationHiddenBefore: false,
      unhideAttempted: false,
      unhideSucceeded: null,
      activationRequestAccepted: true,
      frontProcessFallbackAttempted: false,
      frontProcessFallbackProcessResolved: null,
      frontProcessFallbackRequestSucceeded: null,
      applicationFrontmostAfter: true,
      applicationHiddenAfter: false,
      reason: "activated" as const,
    }));
    controller = new BrowserController(
      config,
      config.browser,
      undefined,
      undefined,
      undefined,
      undefined,
      { supported: true, activateOwnedProcess },
    );
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
    const seeMoreRef = observed.snapshot
      .split("\n")
      .find((line) => line.includes("See more"))
      ?.match(/\[ref=([^\]]+)\]/)?.[1];
    expect(seeMoreRef).toBeDefined();
    if (seeMoreRef === undefined) {
      throw new Error(
        "Fixture did not expose the hidden native target reference.",
      );
    }

    config.headless = false;
    const internals = controller as unknown as {
      controlledBrowserProcessId: number | null;
      observePageActivation: () => Promise<{
        documentFocused: boolean | null;
        visibility: "hidden" | "prerender" | "unknown" | "visible";
      }>;
      prepareChromiumTargetWindow: () => Promise<{
        targetWindowResolved: boolean;
        windowStateBefore:
          | "fullscreen"
          | "maximized"
          | "minimized"
          | "normal"
          | "unknown";
        normalizationAttempted: boolean;
        normalizationSucceeded: boolean | null;
      }>;
    };
    internals.controlledBrowserProcessId = 42_424;
    vi.spyOn(internals, "observePageActivation").mockResolvedValue({
      documentFocused: true,
      visibility: "hidden",
    });
    vi.spyOn(internals, "prepareChromiumTargetWindow").mockResolvedValue({
      targetWindowResolved: true,
      windowStateBefore: "normal",
      normalizationAttempted: false,
      normalizationSucceeded: null,
    });

    await expect(
      controller.clickRef({
        snapshotId: observed.snapshotId,
        ref: seeMoreRef,
        frameId: null,
        postcondition: null,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "OPERATION_FAILED",
      details: {
        reason: "page_not_active",
        actionDispatched: false,
        clickDispatched: false,
        pageActivation: {
          visibilityAfter: "hidden",
          nativeWindow: {
            applicationActivationSucceeded: true,
            frontProcessFallbackAttempted: false,
            result: "visibility_unchanged",
          },
        },
      },
    });
    expect(activateOwnedProcess).toHaveBeenCalledTimes(1);
    const rendered = await controller.findText({
      query: "Input was dispatched",
      mode: "contains",
      caseSensitive: false,
      maxResults: 10,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(rendered.matchCount).toBe(0);
  });

  it("does not force a click when the exact target detaches before pointer dispatch", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Detached dispatch target</title><style>
        @keyframes continuous-motion {
          from { transform: translateX(0); }
          to { transform: translateX(40px); }
        }
        #unstable-target {
          animation: continuous-motion 100ms linear infinite alternate;
          margin: 100px;
          width: 240px;
          height: 48px;
        }
      </style></head><body>
        <div id="unstable-target" role="button" tabindex="0">See more</div>
        <p id="danger" hidden>Replacement was clicked</p>
        <script>
          const nativeAddEventListener = window.addEventListener.bind(window);
          let dispatchProbeObserved = false;
          window.addEventListener = function(type, listener, options) {
            nativeAddEventListener(type, listener, options);
            if (!dispatchProbeObserved && type === 'pointerdown') {
              dispatchProbeObserved = true;
              setTimeout(() => {
                const current = document.querySelector('#unstable-target');
                const replacement = current.cloneNode(true);
                replacement.removeAttribute('style');
                replacement.setAttribute(
                  'onclick',
                  "document.querySelector('#danger').hidden = false",
                );
                current.replaceWith(replacement);
              }, 50);
            }
          };
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-detached-dispatch-"),
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
        "Fixture did not expose the detachable exact-target reference.",
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
      code: "OPERATION_FAILED",
      details: {
        reason: "detached",
        actionDispatched: false,
        clickDispatched: false,
        dispatchEvidence: {
          strategy: "guarded_exact_handle",
          forcedFallbackUsed: false,
          targetConnectedBefore: true,
          targetConnectedAfter: false,
          trustedEventObserved: false,
          clickOnTarget: false,
        },
      },
    });
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      action: "click_by_ref",
      outcome: "blocked",
      reason: "detached",
      actionDispatched: false,
      clickDispatched: false,
      dispatchEvidence: {
        forcedFallbackUsed: false,
        targetConnectedAfter: false,
        trustedEventObserved: false,
      },
    });
    const rendered = await controller.findText({
      query: "Replacement was clicked",
      mode: "contains",
      caseSensitive: false,
      maxResults: 10,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(rendered.matchCount).toBe(0);
  });
});
