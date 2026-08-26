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

describe("BrowserController profile ownership and orphan recovery", () => {
  it("reports an externally locked stopped profile and waits for a bounded owned release", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><head><title>Released profile</title></head><body>Ready</body></html>",
      );
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-transient-lock-"),
    );
    const config = browserConfig(temporaryRoot);
    await mkdir(config.profileDir, { recursive: true });
    const lockPath = path.join(config.profileDir, "SingletonLock");
    await writeFile(lockPath, "owned-by-prior-worker");
    controller = new BrowserController(config);

    await expect(controller.status()).resolves.toMatchObject({
      state: "stopped",
      browserConnected: false,
      profileLockState: "possible_external_owner",
      profileLockFiles: ["SingletonLock"],
    });
    expect(
      (await controller.availableBrowsers()).browsers.find(
        (entry) => entry.browser === "chromium",
      ),
    ).toMatchObject({
      available: false,
      installed: true,
      profileState: "external_owner",
      startable: false,
      recoverable: false,
    });
    const release = setTimeout(() => {
      void rm(lockPath, { force: true });
    }, 150);
    try {
      await expect(
        controller.open({
          url: `http://127.0.0.1:${port}/`,
          newTab: false,
          stabilizationMs: 0,
          timeoutMs: 5_000,
        }),
      ).resolves.toMatchObject({ responseStatus: 200 });
    } finally {
      clearTimeout(release);
    }
    const running = await controller.status();
    expect(running).toMatchObject({
      state: "running",
      browserConnected: true,
    });
    expect(running.profileLockState).not.toBe("possible_external_owner");
  });

  it("removes only exact dead-process singleton entries before restarting the owned profile", async () => {
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-stale-singleton-"),
    );
    const config = browserConfig(temporaryRoot);
    await mkdir(config.profileDir, { recursive: true });
    const target = await resolveBrowserLaunchTarget({
      browser: "chromium",
      executablePath: null,
    });
    const identity = launchIdentityForTarget(target, config.profileDir);
    const deadBrowserProcessId = 2_147_483_647;
    const deadWorkerProcessId = 2_147_483_646;
    const now = new Date().toISOString();
    const executable = await realpath(identity.executablePath);
    const staleLeaseId = randomUUID();
    await writeProfileOwnershipLease(config.profileDir, {
      version: 1,
      leaseId: staleLeaseId,
      browser: "chromium",
      engine: "chromium",
      profileFingerprint: profilePathFingerprint(config.profileDir),
      ownerWorkerProcessId: deadWorkerProcessId,
      ownerWorkerStartedAt: "exited-test-worker",
      browserProcessId: deadBrowserProcessId,
      browserProcessStartedAt: "exited-test-browser",
      browserExecutableFingerprint: createHash("sha256")
        .update(executable)
        .digest("hex"),
      controlMode: "playwright",
      phase: "process_exited",
      createdAt: now,
      heartbeatAt: now,
    });
    await Promise.all([
      symlink(
        `fixture-host-${deadBrowserProcessId}`,
        path.join(config.profileDir, "SingletonLock"),
      ),
      symlink("stale-cookie", path.join(config.profileDir, "SingletonCookie")),
      symlink(
        path.join(config.profileDir, "missing-socket"),
        path.join(config.profileDir, "SingletonSocket"),
      ),
    ]);
    controller = new BrowserController(config);

    await expect(controller.status()).resolves.toMatchObject({
      state: "stopped",
      browserConnected: false,
      profileLockState: "possible_external_owner",
      profileOwner: {
        classification: "owned_orphaned",
        ownership: "proven",
        recovery: "automatic_owned_restart",
        lease: {
          state: "abandoned",
          browserProcess: "not_running",
          controlMode: "playwright",
          phase: "process_exited",
        },
      },
    });
    expect(
      (await controller.availableBrowsers()).browsers.find(
        (entry) => entry.browser === "chromium",
      ),
    ).toMatchObject({
      available: true,
      profileState: "owned_orphaned",
      startable: true,
      recoverable: true,
    });
    await expect(controller.start()).resolves.toMatchObject({
      state: "running",
      browserConnected: true,
      profileOwner: {
        classification: "owned_active",
        ownership: "proven",
      },
    });
    expect(processIsRunning(deadBrowserProcessId)).toBe(false);
    await expect(controller.stop()).resolves.toMatchObject({
      state: "stopped",
      browserConnected: false,
      profileLockFiles: [],
    });
  });

  it("recovers a conclusively proven direct-Playwright orphan without stranding its profile", async () => {
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-owned-orphan-"),
    );
    const config = browserConfig(temporaryRoot);
    await mkdir(config.profileDir, { recursive: true });
    const target = await resolveBrowserLaunchTarget({
      browser: "chromium",
      executablePath: null,
    });
    const identity = launchIdentityForTarget(target, config.profileDir);
    const baselineDescendants = await snapshotOwnedDescendants(process.pid);
    const orphanContext = await playwrightBrowserType(
      "chromium",
    ).launchPersistentContext(config.profileDir, {
      headless: true,
      args: controlledProfileArguments(identity.profile),
    });
    try {
      const orphanProcess = await observeLaunchedBrowserProcess(
        identity,
        baselineDescendants,
        2_000,
      );
      expect(orphanProcess).not.toBeNull();
      if (orphanProcess === null)
        throw new Error("Fixture browser process identity was not observable.");
      const orphanProcessId = orphanProcess.processId;
      const [browserStartedAt, browserExecutable] = await Promise.all([
        processStartedAtToken(orphanProcessId),
        processExecutablePath(orphanProcessId),
      ]);
      expect(browserStartedAt).not.toBeNull();
      expect(browserExecutable).not.toBeNull();
      if (browserStartedAt === null || browserExecutable === null) {
        throw new Error("Fixture browser process identity was not observable.");
      }
      const canonicalExecutable = await realpath(browserExecutable);
      const now = new Date().toISOString();
      await writeProfileOwnershipLease(config.profileDir, {
        version: 1,
        leaseId: randomUUID(),
        browser: "chromium",
        engine: "chromium",
        profileFingerprint: profilePathFingerprint(config.profileDir),
        ownerWorkerProcessId: 2_147_483_000,
        ownerWorkerStartedAt: "unreachable-test-worker",
        browserProcessId: orphanProcessId,
        browserProcessStartedAt: browserStartedAt,
        browserExecutableFingerprint: createHash("sha256")
          .update(canonicalExecutable)
          .digest("hex"),
        controlMode: "playwright",
        phase: "owned_active",
        createdAt: now,
        heartbeatAt: now,
      });

      controller = new BrowserController(config);
      expect(
        (await controller.availableBrowsers()).browsers.find(
          (entry) => entry.browser === "chromium",
        ),
      ).toMatchObject({
        available: true,
        profileState: "owned_orphaned",
        startable: true,
        recoverable: true,
      });
      await expect(controller.start()).resolves.toMatchObject({
        state: "running",
        browserConnected: true,
        profileOwner: {
          classification: "owned_active",
          ownership: "proven",
        },
      });
      expect(processIsRunning(orphanProcessId)).toBe(false);
    } finally {
      await orphanContext.close().catch(() => undefined);
    }
  });
});
