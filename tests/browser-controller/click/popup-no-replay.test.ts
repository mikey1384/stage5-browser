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

describe("BrowserController popup dispatch evidence and no replay", () => {
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
});
