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

describe("BrowserController private authentication handoff", () => {
  it("hands authentication to an uncontrolled browser, scopes deep modals, and reports bounded diagnostics", async () => {
    let authenticated = false;
    server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://fixture.invalid");
      if (requestUrl.pathname === "/missing") {
        response.writeHead(404, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("missing");
        return;
      }
      if (requestUrl.pathname === "/success") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
        return;
      }
      if (requestUrl.pathname === "/background") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          "<!doctype html><html><head><title>Background tab</title></head><body>Background</body></html>",
        );
        return;
      }
      if (requestUrl.pathname === "/login") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        if (authenticated) {
          response.end(
            '<!doctype html><html><head><title>Stage5 account</title></head><body><h1>Signed in</h1><a href="/account">Stage5 account</a></body></html>',
          );
          return;
        }
        response.end(`<!doctype html><html><head><title>Login modal</title><style>
          #continue-wrap { display: inline-block; position: relative; }
          #cover { position: absolute; inset: 0; z-index: 100; background: transparent; }
        </style></head><body>
          <main><section><div><div><div><div><div><div><div><div><div><div>
            <div role="dialog" aria-modal="true" aria-labelledby="login-heading">
              <h2 id="login-heading">Sign in</h2>
              <label for="username">Username</label><input id="username" />
              <span id="continue-wrap"><button type="button">Continue</button><span id="cover"></span></span>
              <button type="button" aria-selected="false" onclick="fetch('/success?token=private-success-value').then(() => this.setAttribute('aria-selected', 'true'))">Use password</button>
            </div>
          </div></div></div></div></div></div></div></div></div></div></section></main>
          <script>
            console.error('automation rejection private-console-value');
            fetch('/missing?otp=private-network-value#fragment');
            setTimeout(() => { throw new Error('private-page-error-value'); }, 10);
            setTimeout(() => {
              const popup = window.open('/background?token=private-popup-value', 'background');
              popup?.blur();
              window.focus();
            }, 25);
          </script>
        </body></html>`);
        return;
      }

      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><head><title>Initial</title></head><body>Initial</body></html>",
      );
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-auth-modal-"),
    );
    const config = browserConfig(temporaryRoot);
    humanLauncher = new FakeHumanBrowserLauncher();
    controller = new BrowserController(config, config.browser, humanLauncher);
    await controller.open({
      url: `${baseUrl}/login`,
      newTab: false,
      timeoutMs: 5_000,
    });

    const tabs = await controller.tabs();
    const loginTab = tabs.pages.find((page) => page.url === `${baseUrl}/login`);
    const backgroundTab = tabs.pages.find((page) =>
      page.url.startsWith(`${baseUrl}/background`),
    );
    expect(loginTab).toBeDefined();
    expect(backgroundTab).toBeDefined();
    if (backgroundTab === undefined || loginTab === undefined) {
      throw new Error("Fixture did not expose both authentication tabs.");
    }
    await controller.selectTab({ tabId: loginTab.tabId });
    expect((await controller.tabs()).activePageIndex).toBe(loginTab.index);

    const snapshot = await controller.snapshot({
      depth: 4,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(snapshot).toMatchObject({
      scope: "modal",
      visibleModalCount: 1,
      warnings: [],
    });
    expect(snapshot.snapshot).toContain("Username");
    expect(snapshot.snapshot).toContain("Continue");
    expect(snapshot.refCount).toBeGreaterThanOrEqual(2);

    const selectedBackground = await controller.selectTab({
      tabId: backgroundTab.tabId,
    });
    expect(selectedBackground.authenticationTargetUpdated).toBe(false);
    await controller.selectTab({ tabId: loginTab.tabId });

    await expect(
      controller.clickByRole({
        role: "button",
        name: "Continue",
        exact: true,
        frameId: null,
        postcondition: null,
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "OPERATION_FAILED",
      details: {
        reason: "pointer_intercepted",
        clickDispatched: false,
        actionOutcome: "blocked",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const diagnostics = await controller.diagnostics();
    expect(diagnostics.page).toMatchObject({
      pageUrl: `${baseUrl}/login`,
      totals: {
        pageErrors: 1,
        httpErrors: 1,
      },
      lastAction: {
        action: "click_by_role",
        outcome: "blocked",
        reason: "pointer_intercepted",
        clickDispatched: false,
        targetState: {
          visible: true,
          enabled: true,
          receivesPointerEvents: false,
          role: "button",
          coveredBy: { tagName: "span" },
        },
      },
    });
    expect(diagnostics.page?.totals.consoleErrors).toBeGreaterThanOrEqual(1);
    expect(diagnostics.page?.consoleEvents).toContainEqual(
      expect.objectContaining({
        category: "automation_rejection",
        fingerprint: expect.stringMatching(/^[a-f0-9]{12}$/),
      }),
    );
    expect(diagnostics.page?.networkEvents).toContainEqual(
      expect.objectContaining({
        kind: "http_error",
        status: 404,
        url: `${baseUrl}/missing`,
      }),
    );
    const serializedDiagnostics = JSON.stringify(diagnostics);
    expect(serializedDiagnostics).not.toContain("private-console-value");
    expect(serializedDiagnostics).not.toContain("private-network-value");
    expect(serializedDiagnostics).not.toContain("private-page-error-value");
    expect(serializedDiagnostics).not.toContain("private-popup-value");

    await controller.clickByRole({
      role: "button",
      name: "Use password",
      exact: true,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: true,
        expectedVisible: null,
        timeoutMs: 1_000,
      },
      timeoutMs: 2_000,
    });
    const successfulDiagnostics = await controller.diagnostics();
    expect(successfulDiagnostics.page?.lastActionNetworkEvents).toContainEqual(
      expect.objectContaining({
        kind: "http_response",
        status: 200,
        url: `${baseUrl}/success`,
      }),
    );
    expect(successfulDiagnostics.page?.totals.httpSuccesses).toBeGreaterThan(0);

    // Only the injected fake launcher crosses the visible-handoff guard. The controlled
    // browser remains headless before and after this request.
    const handoff = await requestFakeLoginHandoff(controller, config, {
      url: `${baseUrl}/login`,
      timeoutMs: 5_000,
    });
    expect(handoff).toMatchObject({
      state: "awaiting_user",
      browserConnected: false,
      targetOrigin: baseUrl,
      targetPageAvailable: false,
      page: null,
      controlMode: "human_bootstrap",
      profileBinding: {
        userDataDir: config.profileDir,
        profileDirectory: "Default",
        profilePath: path.join(config.profileDir, "Default"),
      },
      humanBootstrap: {
        running: true,
        controlledByPlaywright: false,
        automationFlagsPresent: false,
        exactUserInteractionsObserved: false,
        handoffLabel: expect.stringContaining("Stage5 chromium"),
        launchIdentity: {
          browser: "chromium",
          engine: "chromium",
          applicationName: expect.any(String),
          profile: {
            userDataDir: config.profileDir,
            profileDirectory: "Default",
          },
        },
      },
    });
    expect(handoff.instructions).toContain(
      handoff.humanBootstrap!.launchIdentity.applicationName,
    );
    expect(handoff.instructions).not.toContain("may not exit Brave");
    expect(humanLauncher.launches).toHaveLength(1);
    expect(humanLauncher.launches[0]).toMatchObject({
      profileDir: config.profileDir,
      url: `${baseUrl}/login`,
      target: { browser: "chromium", engine: "chromium" },
    });
    await expect(controller.tabs()).rejects.toMatchObject<
      Partial<Stage5BrowserError>
    >({
      code: "AUTH_HANDOFF_REQUIRED",
    });
    await expect(controller.stop()).rejects.toMatchObject<
      Partial<Stage5BrowserError>
    >({
      code: "AUTH_HANDOFF_REQUIRED",
    });
    const humanDiagnostics = await controller.diagnostics();
    expect(humanDiagnostics.automationExposure).toEqual({
      controlMode: "human_bootstrap",
      controlledByPlaywright: false,
      enableAutomationArgument: "absent",
      navigatorWebdriver: null,
      navigatorWebdriverObserved: false,
      observation: "uncontrolled_browser_not_instrumented",
    });

    await expect(
      controller.resumeAfterLogin({
        expected: { url: `${baseUrl}/login`, match: "exact" },
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "AUTH_HANDOFF_REQUIRED",
      details: { reason: "human_browser_still_running" },
    });

    authenticated = true;
    await humanLauncher.finish(true);
    const resumed = await controller.resumeAfterLogin({
      expected: { url: `${baseUrl}/login`, match: "exact" },
      timeoutMs: 5_000,
    });
    expect(resumed).toMatchObject({
      state: "ready_for_agent_verification",
      verificationRequired: true,
      controlMode: "playwright",
      humanBootstrap: {
        running: false,
        profileShutdown: {
          state: "clean",
          exitType: "normal",
          exitedCleanly: true,
          exitedCleanlySource: "process_exit",
          profileDirectory: "Default",
          currentSessionEvidence: "clean_process_exit",
          reattachmentDecision: "allowed",
        },
      },
      lastHandoffOutcome: {
        observation: "sanitized_before_after_boundary",
        exactUserInteractionsObserved: false,
        beforeUrl: `${baseUrl}/login`,
        afterUrl: `${baseUrl}/login`,
        routeChanged: false,
        semanticStructureChanged: true,
        launchIdentityMatched: true,
        runtimeProfile: {
          source: "unavailable",
          profilePath: null,
          matchesConfigured: null,
        },
        storageContinuity: {
          state: expect.stringMatching(/preserved|unverified/),
          afterControlledStart: {
            cookieDatabase: { inspection: "live_context_metadata" },
          },
          afterTargetLoad: {
            cookieDatabase: { inspection: "live_context_metadata" },
          },
          targetOriginLoadedAtControlledStart: false,
          navigatorWebdriverAtControlledStart: true,
        },
      },
    });
    expect(resumed.verificationPreview).toMatchObject({
      observation: "bounded_semantic_preview",
      available: true,
      snapshot: expect.stringContaining("Signed in"),
    });
    const resumedDiagnostics = await controller.diagnostics();
    expect(resumedDiagnostics.automationExposure).toMatchObject({
      controlMode: "playwright",
      controlledByPlaywright: true,
      enableAutomationArgument: "present",
      navigatorWebdriver: true,
      navigatorWebdriverObserved: true,
    });
    const verified = await controller.snapshot({
      depth: 4,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(verified.snapshot).toContain("Signed in");
    expect(await controller.authStatus()).toMatchObject({
      state: "profile_ready",
      verificationRequired: false,
      lastHandoffOutcome: { semanticStructureChanged: true },
    });
  });
});
