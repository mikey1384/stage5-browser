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

describe("BrowserController authentication URL and storage continuity", () => {
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
});
