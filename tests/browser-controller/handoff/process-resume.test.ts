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

describe("BrowserController private browser process resume boundaries", () => {
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
      }, false),
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
});
