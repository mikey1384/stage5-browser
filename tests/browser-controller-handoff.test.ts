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

describe("BrowserController files, authentication, and reattachment", () => {
  it("discovers hidden file inputs and sets only fresh snapshot-bound regular files", async () => {
    server = createServer((request, response) => {
      if (request.url === "/upload" && request.method === "POST") {
        request.resume();
        setTimeout(() => {
          response.writeHead(204);
          response.end();
        }, 25);
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Upload fixture</title></head><body>
        <div role="dialog" aria-modal="true" aria-label="Post composer">
          <h1>Create post</h1>
          <input id="media" type="file" accept="video/mp4" hidden>
          <script>
            document.addEventListener('input', (event) => {
              const input = event.target;
              if (!(input instanceof HTMLInputElement) || input.id !== 'media' || input.files.length === 0) return;
              document.querySelector('#preview').textContent = input.files[0].name;
              const progress = document.querySelector('#progress');
              progress.hidden = false;
              progress.value = 25;
              fetch('/upload', { method: 'POST', body: 'fixture' }).then(() => {
                progress.value = 100;
                document.querySelector('#complete').hidden = false;
              });
              input.value = '';
            }, { capture: true });
          </script>
          <p id="preview"></p>
          <progress id="progress" max="100" value="0" hidden></progress>
          <button id="complete" hidden>Processing complete</button>
        </div>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-upload-"),
    );
    const videoPath = path.join(temporaryRoot, "rick-rubin-test.mp4");
    await writeFile(videoPath, Buffer.alloc(1_024, 7));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/composer`,
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
      fileInputCount: 1,
      fileInputs: [
        {
          accept: "video/mp4",
          multiple: false,
          disabled: false,
          visible: false,
        },
      ],
    });
    const fileRef = observed.fileInputs[0]?.ref;
    expect(fileRef).toBeDefined();
    if (fileRef === undefined) {
      throw new Error("Fixture did not expose the hidden file input.");
    }

    await expect(
      controller.setInputFiles({
        snapshotId: observed.snapshotId,
        ref: fileRef,
        paths: ["relative-video.mp4"],
        frameId: null,
        completion: null,
        observationMs: 0,
        previewDepth: 8,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "INVALID_FILE",
      details: { reason: "file_path_not_absolute", fileIndex: 0 },
    });

    const selected = await controller.setInputFiles({
      snapshotId: observed.snapshotId,
      ref: fileRef,
      paths: [videoPath],
      frameId: null,
      completion: {
        expectedComplete: {
          role: "button",
          name: "Processing complete",
          exact: true,
          frameId: null,
        },
        expectedError: null,
        timeoutMs: 2_000,
      },
      observationMs: 100,
      previewDepth: 8,
      timeoutMs: 5_000,
    });
    expect(selected).toMatchObject({
      selection: {
        dispatched: true,
        confirmedByInput: true,
        fileCount: 1,
        totalBytes: 1_024,
        files: [{ name: "rick-rubin-test.mp4", sizeBytes: 1_024 }],
      },
      attachmentPreview: { available: true },
      processing: {
        state: "completion_observed",
        evidence: "expected_completion_visible",
      },
    });
    expect(selected.attachmentPreview.snapshot).toContain(
      "Processing complete",
    );
    expect(JSON.stringify(selected)).not.toContain(temporaryRoot);

    await expect(
      controller.setInputFiles({
        snapshotId: observed.snapshotId,
        ref: fileRef,
        paths: [videoPath],
        frameId: null,
        completion: null,
        observationMs: 0,
        previewDepth: 8,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "TARGET_NOT_FOUND",
      details: { reason: "stale_or_unknown_snapshot" },
    });
  });

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
    await controller.selectTab({ index: loginTab.index });
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
      index: backgroundTab.index,
    });
    expect(selectedBackground.authenticationTargetUpdated).toBe(false);
    await controller.selectTab({ index: loginTab.index });

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

  it("resumes a Firefox handoff after a delayed profile unlock without relaunching control", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><head><title>Firefox handoff</title></head><body><button>Continue</button></body></html>",
      );
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-firefox-handoff-"),
    );
    const config = {
      ...browserConfig(temporaryRoot),
      browser: "firefox" as const,
      profileDir: path.join(temporaryRoot, "profiles", "firefox"),
    };
    humanLauncher = new FakeHumanBrowserLauncher();
    controller = new BrowserController(config, "firefox", humanLauncher);
    await controller.open({
      url: `http://127.0.0.1:${port}/private-step`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const retainedLock = path.join(config.profileDir, "lock");
    await writeFile(retainedLock, "delayed-firefox-unlock");
    const firstAttemptAt = Date.now();
    await expect(
      requestFakeLoginHandoff(controller, config, {
        url: null,
        timeoutMs: 1_500,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "AUTH_HANDOFF_REQUIRED",
      details: {
        reason: "handoff_release_pending",
        phase: "process_exited",
        ownershipRetained: true,
        profileLockFiles: expect.arrayContaining(["lock"]),
      },
    });
    expect(Date.now() - firstAttemptAt).toBeLessThan(2_000);
    expect(humanLauncher.launches).toHaveLength(0);
    expect(await controller.authStatus()).toMatchObject({
      state: "releasing_control",
      controlMode: "human_bootstrap",
      targetOrigin: `http://127.0.0.1:${port}`,
    });

    await rm(retainedLock);
    expect(await waitForProfileUnlock(config.profileDir, 30_000)).toBe(true);
    const resumed = await controller.requestLoginHandoff({
      url: null,
      timeoutMs: 5_000,
    });
    expect(resumed).toMatchObject({
      state: "awaiting_user",
      userActionRequired: true,
      humanBootstrap: {
        launchIdentity: { browser: "firefox", engine: "firefox" },
      },
    });
    expect(humanLauncher.launches).toHaveLength(1);
  });

  it("reattaches after a zero process exit even when Chromium retains a crashed marker", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><head><title>Login</title></head><body><h1>Login</h1></body></html>",
      );
    });
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/login`;
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-stale-exit-marker-"),
    );
    const config = browserConfig(temporaryRoot);
    humanLauncher = new FakeHumanBrowserLauncher();
    controller = new BrowserController(config, config.browser, humanLauncher);
    await controller.open({ url, newTab: false, timeoutMs: 5_000 });
    await requestFakeLoginHandoff(controller, config, {
      url,
      timeoutMs: 5_000,
    });
    await humanLauncher.finish(false, 0);

    const resumed = await controller.resumeAfterLogin({
      expected: null,
      timeoutMs: 5_000,
    });
    expect(resumed).toMatchObject({
      state: "ready_for_agent_verification",
      humanBootstrap: {
        running: false,
        profileShutdown: {
          state: "clean",
          exitType: "crashed",
          exitedCleanly: true,
          exitedCleanlySource: "process_exit",
          profileLocks: [],
          currentSessionEvidence: "clean_process_exit",
          reattachmentDecision: "allowed",
        },
      },
    });
  });

  it("offers one explicit unlocked-profile override after an abnormal human-browser exit", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><head><title>Login</title></head><body><h1>Login</h1></body></html>",
      );
    });
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/login`;
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-unclean-auth-"),
    );
    const config = browserConfig(temporaryRoot);
    humanLauncher = new FakeHumanBrowserLauncher();
    controller = new BrowserController(config, config.browser, humanLauncher);
    await controller.open({ url, newTab: false, timeoutMs: 5_000 });
    await requestFakeLoginHandoff(controller, config, {
      url,
      timeoutMs: 5_000,
    });
    await humanLauncher.finish(false);

    await expect(
      controller.resumeAfterLogin({ expected: null, timeoutMs: 2_000 }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "AUTH_HANDOFF_REQUIRED",
      details: {
        reason: "abnormal_human_browser_process_exit",
        exitType: "crashed",
        exitedCleanly: false,
        overrideAvailable: true,
        suggestedAction: expect.not.stringContaining(
          "Request a new login handoff",
        ),
      },
    });
    expect(await controller.authStatus()).toMatchObject({
      state: "awaiting_user",
      browserConnected: false,
      humanBootstrap: {
        running: false,
        profileShutdown: {
          state: "unclean",
          currentSessionEvidence: "abnormal_process_exit",
          reattachmentDecision: "override_available",
        },
      },
    });

    const resumed = await controller.resumeAfterLogin({
      expected: null,
      timeoutMs: 5_000,
    });
    expect(resumed).toMatchObject({
      state: "ready_for_agent_verification",
      humanBootstrap: {
        running: false,
        profileShutdown: {
          state: "unknown",
          profileLocks: [],
          reattachmentDecision: "explicit_unlocked_profile_override",
        },
      },
    });
  });

  it("rejects an origin-only authentication URL expectation before reattachment", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><head><title>Login</title></head><body><h1>Login</h1></body></html>",
      );
    });
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-origin-auth-"),
    );
    const config = browserConfig(temporaryRoot);
    humanLauncher = new FakeHumanBrowserLauncher();
    controller = new BrowserController(config, config.browser, humanLauncher);
    await controller.open({
      url: `${origin}/login`,
      newTab: false,
      timeoutMs: 5_000,
    });
    await requestFakeLoginHandoff(controller, config, {
      url: null,
      timeoutMs: 5_000,
    });
    await humanLauncher.finish(true);

    await expect(
      controller.resumeAfterLogin({
        expected: { url: origin, match: "prefix" },
        timeoutMs: 2_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "OPERATION_FAILED",
      details: {
        reason: "auth_url_expectation_too_weak",
      },
    });
    expect(await controller.authStatus()).toMatchObject({
      state: "awaiting_user",
      browserConnected: false,
    });
  });

  it("accepts an exact post-login route when the site appends an incidental query", async () => {
    server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (
        requestUrl.pathname === "/personal-profile" &&
        requestUrl.search === ""
      ) {
        response.writeHead(302, {
          location: "/personal-profile?checkpoint_src=any",
        });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><head><title>Profile</title></head><body><h1>Signed-in personal profile</h1></body></html>",
      );
    });
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    const expectedRoute = `${origin}/personal-profile`;
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-auth-query-"),
    );
    const config = browserConfig(temporaryRoot);
    const offlineInspections = [
      storageInspection(origin, []),
      storageInspection(origin, ["human-added-key"]),
    ];
    const controlledInspections = [
      storageInspection(origin, ["human-added-key"]),
      storageInspection(origin, ["human-added-key"]),
    ];
    humanLauncher = new FakeHumanBrowserLauncher();
    controller = new BrowserController(
      config,
      config.browser,
      humanLauncher,
      async () => {
        const inspection = offlineInspections.shift();
        if (inspection === undefined)
          throw new Error("Unexpected offline storage inspection.");
        return inspection;
      },
      async () => {
        const inspection = controlledInspections.shift();
        if (inspection === undefined)
          throw new Error("Unexpected controlled storage inspection.");
        return inspection;
      },
    );
    await controller.open({
      url: expectedRoute,
      newTab: false,
      timeoutMs: 5_000,
    });
    await requestFakeLoginHandoff(controller, config, {
      url: null,
      timeoutMs: 5_000,
    });
    await humanLauncher.finish(true);

    const resumed = await controller.resumeAfterLogin({
      expected: { url: expectedRoute, match: "exact" },
      timeoutMs: 2_000,
    });
    expect(resumed).toMatchObject({
      state: "ready_for_agent_verification",
      browserConnected: true,
      page: { url: `${expectedRoute}?checkpoint_src=any` },
      lastHandoffOutcome: {
        storageContinuity: {
          state: "preserved",
          lossBoundary: "none",
          humanSessionEvidenceObserved: true,
        },
      },
    });
    expect(resumed.verificationPreview.snapshot).toContain(
      "Signed-in personal profile",
    );
  });

  it("returns AUTH_NOT_PERSISTED when a human session cannot reach the non-root post-login route", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><head><title>Account</title></head><body><button>Sign in</button></body></html>",
      );
    });
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    const url = `${origin}/account`;
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-lost-auth-"),
    );
    const config = browserConfig(temporaryRoot);
    const offlineInspections = [
      storageInspection(origin, []),
      storageInspection(origin, ["human-added-key"]),
    ];
    const controlledInspections = [
      storageInspection(origin, ["human-added-key"]),
      storageInspection(origin, ["human-added-key"]),
    ];
    humanLauncher = new FakeHumanBrowserLauncher();
    controller = new BrowserController(
      config,
      config.browser,
      humanLauncher,
      async () => {
        const inspection = offlineInspections.shift();
        if (inspection === undefined) {
          throw new Error("Unexpected offline profile-storage inspection.");
        }
        return inspection;
      },
      async () => {
        const inspection = controlledInspections.shift();
        if (inspection === undefined) {
          throw new Error("Unexpected controlled profile-storage inspection.");
        }
        return inspection;
      },
    );
    await controller.open({ url, newTab: false, timeoutMs: 5_000 });
    await requestFakeLoginHandoff(controller, config, {
      url: null,
      timeoutMs: 5_000,
    });
    await humanLauncher.finish(true);

    await expect(
      controller.resumeAfterLogin({
        expected: { url: `${origin}/signed-in`, match: "exact" },
        timeoutMs: 500,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "AUTH_NOT_PERSISTED",
      details: {
        reason: "post_login_url_not_reached",
        storageContinuity: { humanSessionEvidenceObserved: true },
      },
    });
    expect(await controller.authStatus()).toMatchObject({
      state: "ready_for_agent_verification",
      browserConnected: true,
      lastHandoffOutcome: {
        launchIdentityMatched: true,
        storageContinuity: { humanSessionEvidenceObserved: true },
      },
    });
  });

  it("returns the exact storage-loss boundary before asking the user to repeat login", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><head><title>Account</title></head><body><button>Sign in</button></body></html>",
      );
    });
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    const url = `${origin}/account`;
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-storage-boundary-"),
    );
    const config = browserConfig(temporaryRoot);
    const offlineInspections = [
      storageInspection(origin, []),
      storageInspection(origin, ["human-added-key"]),
    ];
    const controlledInspections = [
      storageInspection(origin, ["human-added-key"]),
      storageInspection(origin, []),
    ];
    humanLauncher = new FakeHumanBrowserLauncher();
    controller = new BrowserController(
      config,
      config.browser,
      humanLauncher,
      async () => {
        const inspection = offlineInspections.shift();
        if (inspection === undefined) {
          throw new Error("Unexpected offline profile-storage inspection.");
        }
        return inspection;
      },
      async () => {
        const inspection = controlledInspections.shift();
        if (inspection === undefined) {
          throw new Error("Unexpected controlled profile-storage inspection.");
        }
        return inspection;
      },
    );
    await controller.open({ url, newTab: false, timeoutMs: 5_000 });
    await requestFakeLoginHandoff(controller, config, {
      url: null,
      timeoutMs: 5_000,
    });
    await humanLauncher.finish(true);

    await expect(
      controller.resumeAfterLogin({ expected: null, timeoutMs: 2_000 }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "AUTH_NOT_PERSISTED",
      details: {
        reason: "authentication_storage_lost",
        storageContinuity: {
          lossBoundary: "target_load",
          automationCorrelation: "loss_after_automation_exposure",
          humanSessionEvidenceObserved: true,
        },
      },
    });
    expect(await controller.authStatus()).toMatchObject({
      state: "ready_for_agent_verification",
      browserConnected: true,
      lastHandoffOutcome: {
        storageContinuity: { lossBoundary: "target_load", state: "lost" },
      },
    });
  });

  it("inspects and acts inside an observed cross-origin frame without coordinate guessing", async () => {
    frameServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><body>
        <h2>Embedded Groove Lab</h2>
        <label for="song">Song name</label><input id="song" />
        <button type="button" onclick="document.querySelector('#result').textContent='Frame clicked'">
          Download Boss Battle
        </button>
        <p id="result"></p>
      </body></html>`);
    });
    const framePort = await listen(frameServer);

    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Frame host</title></head><body>
        <h1>Outer application</h1>
        <iframe name="groove-lab" src="http://127.0.0.1:${framePort}/embedded?token=secret#fragment"></iframe>
      </body></html>`);
    });
    const hostPort = await listen(server);

    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-frame-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    for (const [index, browser] of (
      ["chromium", "firefox", "webkit"] as const
    ).entries()) {
      if (index > 0) {
        await controller.switchBrowser({ browser });
      }
      await controller.open({
        url: `http://127.0.0.1:${hostPort}/host`,
        newTab: false,
        timeoutMs: 5_000,
      });

      const inventory = await controller.frames();
      const embedded = inventory.frames.find(
        (frame) => frame.name === "groove-lab",
      );
      expect(embedded).toBeDefined();
      expect(embedded?.url).toBe(`http://127.0.0.1:${framePort}/embedded`);
      if (embedded === undefined) {
        throw new Error(
          `Cross-origin fixture frame was not observed in ${browser}.`,
        );
      }

      const snapshot = await controller.snapshot({
        depth: 8,
        boxes: false,
        frameId: embedded.id,
        timeoutMs: 5_000,
      });
      expect(snapshot.snapshot).toContain("Embedded Groove Lab");

      await controller.fillByRole({
        role: "textbox",
        name: "Song name",
        exact: true,
        frameId: embedded.id,
        value: "Boss Battle",
        timeoutMs: 5_000,
      });
      await controller.clickByRole({
        role: "button",
        name: "Download Boss Battle",
        exact: true,
        frameId: embedded.id,
        postcondition: null,
        timeoutMs: 5_000,
      });

      const after = await controller.snapshot({
        depth: 8,
        boxes: false,
        frameId: embedded.id,
        timeoutMs: 5_000,
      });
      expect(after.snapshot).toContain("Frame clicked");

      await controller.open({
        url: "about:blank",
        newTab: false,
        timeoutMs: 5_000,
      });
      await expect(
        controller.snapshot({
          depth: 8,
          boxes: false,
          frameId: embedded.id,
          timeoutMs: 5_000,
        }),
      ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
        code: "TARGET_NOT_FOUND",
      });
    }
  });

  it("reports sanitized lock-owner evidence and fails closed when automatic reattachment is unproven", async () => {
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-owned-lock-"),
    );
    const config = browserConfig(temporaryRoot);
    config.readinessTimeoutMs = 10;
    await mkdir(config.profileDir, { recursive: true });
    await writeFile(
      path.join(config.profileDir, "SingletonLock"),
      "owned-browser-fixture",
    );
    const inspectOwner = vi.fn(async () => ({
      evidence: {
        classification: "dedicated_browser_control_unavailable" as const,
        ownership: "proven" as const,
        lockOwnerProcess: "running" as const,
        expectedApplication: "Chromium",
        applicationIdentity: "matched" as const,
        loopbackControl: "absent" as const,
        authenticationHandoff: "unverified" as const,
        recovery: "close_dedicated_browser_normally" as const,
        suggestedAction:
          "Close only the dedicated Chromium application normally, then retry once.",
      },
      reconnectRecord: null,
    }));
    controller = new BrowserController(
      config,
      config.browser,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      inspectOwner,
    );

    const stopped = await controller.status();
    expect(stopped).toMatchObject({
      state: "stopped",
      profileLockState: "possible_external_owner",
      profileOwner: {
        classification: "dedicated_browser_control_unavailable",
        ownership: "proven",
        expectedApplication: "Chromium",
        recovery: "close_dedicated_browser_normally",
      },
    });
    await expect(controller.start()).rejects.toMatchObject<
      Partial<Stage5BrowserError>
    >({
      code: "BROWSER_NOT_READY",
      details: {
        reason: "profile_locked",
        ownershipReason: "dedicated_browser_control_unavailable",
        profileOwner: {
          loopbackControl: "absent",
          recovery: "close_dedicated_browser_normally",
        },
        suggestedAction:
          "Close only the dedicated Chromium application normally, then retry once.",
      },
    });
    const diagnostic = await controller.diagnostics();
    expect(diagnostic.profileOwner).toMatchObject({
      classification: "dedicated_browser_control_unavailable",
      ownership: "proven",
      lockOwnerProcess: "running",
      applicationIdentity: "matched",
    });
    expect(inspectOwner).toHaveBeenCalled();
  });

  it("reattaches through a reconstructed exact owned-process capability instead of launching into a lock", async () => {
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-reconnect-lock-"),
    );
    const config = browserConfig(temporaryRoot);
    config.readinessTimeoutMs = 10;
    await mkdir(config.profileDir, { recursive: true });
    await writeFile(
      path.join(config.profileDir, "SingletonLock"),
      "owned-browser-fixture",
    );
    const reconnectRecord: NativeControlRecord = {
      version: 1,
      kind: "chromium_cdp",
      browser: "chromium",
      state: "controlled",
      processId: 42_424,
      port: 29_123,
      createdAt: "2026-08-25T04:00:00.000Z",
    };
    const inspectOwner = vi.fn(async () => ({
      evidence: {
        classification: "reconnectable_stage5_browser" as const,
        ownership: "proven" as const,
        lockOwnerProcess: "running" as const,
        expectedApplication: "Google Chrome for Testing",
        applicationIdentity: "matched" as const,
        loopbackControl: "available" as const,
        authenticationHandoff: "absent" as const,
        recovery: "automatic_reattach" as const,
        suggestedAction: "Stage5 Browser can safely reattach automatically.",
      },
      reconnectRecord,
    }));
    controller = new BrowserController(
      config,
      config.browser,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      inspectOwner,
    );
    const internals = controller as unknown as {
      attachToNativeChromium: (
        record: NativeControlRecord,
        identity: BrowserLaunchIdentity,
        targetOrigin: string | null,
      ) => Promise<BrowserStatus>;
    };
    const attach = vi
      .spyOn(internals, "attachToNativeChromium")
      .mockImplementation(async (_record, identity) => ({
        browser: "chromium",
        state: "running",
        workerPid: process.pid,
        browserConnected: true,
        pages: [],
        activePageIndex: null,
        lastKnownUrl: null,
        launchIdentity: identity,
        runtimeProfile: null,
        profileLockState: "owned_browser_running",
        profileLockFiles: ["SingletonLock"],
        profileOwner: {
          classification: "owned_active",
          ownership: "proven",
          lockOwnerProcess: "running",
          expectedApplication: identity.applicationName,
          applicationIdentity: "matched",
          loopbackControl: "available",
          authenticationHandoff: "absent",
          recovery: "none",
          suggestedAction: null,
        },
      }));

    await expect(controller.start()).resolves.toMatchObject({
      state: "running",
      browserConnected: true,
      profileOwner: { classification: "owned_active" },
    });
    expect(attach).toHaveBeenCalledWith(
      reconnectRecord,
      expect.objectContaining({
        browser: "chromium",
        profile: expect.objectContaining({
          userDataDir: config.profileDir,
          profileDirectory: "Default",
        }),
      }),
      null,
    );
  });
});
