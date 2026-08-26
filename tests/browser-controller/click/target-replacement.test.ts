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

describe("BrowserController exact target replacement before and during input", () => {
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
});
