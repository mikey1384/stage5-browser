import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";

import type { BrowserController } from "../src/browser-controller.js";
import { resolveBrowserLaunchTarget } from "../src/browser-provider.js";
import type { Stage5BrowserConfig } from "../src/config.js";
import { Stage5BrowserError } from "../src/errors.js";
import { processIsRunning } from "../src/native-control-channel.js";
import type {
  HumanBrowserLaunchInput,
  HumanBrowserLauncher,
  HumanBrowserProcessState,
  HumanBrowserSession,
} from "../src/human-auth-bootstrap.js";
import type { ProfileStorageInspection } from "../src/profile-binding.js";
import { launchIdentityForTarget } from "../src/profile-binding.js";
import {
  inspectProfileOwnershipLease,
  readProfileOwnershipLease,
} from "../src/profile-ownership-lease.js";

const DEFAULT_TEST_CLEANUP_GRACE_MS = 8_000;
const EXACT_PROCESS_EXIT_GRACE_MS = 2_000;
const MAX_RETAINED_RELEASE_CONTINUATIONS = 3;

export async function waitForDisposableDevToolsPort(
  profileDir: string,
  timeoutMs: number,
): Promise<number> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    try {
      const [portLine] = (await readFile(path.join(profileDir, "DevToolsActivePort"), "utf8")).split("\n");
      const port = Number.parseInt(portLine ?? "", 10);
      if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) return port;
    } catch {
      // Chromium creates this file only after the disposable endpoint is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Disposable Chromium did not publish its DevTools port.");
}

export async function waitForDisposableProcessExit(
  processId: number,
  timeoutMs: number,
): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (processIsRunning(processId) && Date.now() < deadlineAt) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function settlesWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    operation.then(() => true, () => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return settled;
}

function isDisposableTestRoot(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  const tempRoot = path.resolve(os.tmpdir());
  return resolved.startsWith(`${tempRoot}${path.sep}`)
    && path.basename(resolved).startsWith("stage5-browser-");
}

async function findOwnershipRoots(directory: string, depth = 0): Promise<string[]> {
  if (depth > 5) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const roots = entries.some((entry) => entry.isFile() && entry.name === ".stage5-browser-ownership.json")
    ? [directory]
    : [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    roots.push(...await findOwnershipRoots(path.join(directory, entry.name), depth + 1));
  }
  return roots;
}

async function waitForProcessExit(processId: number, timeoutMs: number): Promise<boolean> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    try {
      process.kill(processId, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    process.kill(processId, 0);
    return false;
  } catch {
    return true;
  }
}

async function terminateExactDisposableProcesses(temporaryRoot: string): Promise<boolean> {
  if (!isDisposableTestRoot(temporaryRoot)) return false;
  let signaled = false;
  for (const profileRoot of await findOwnershipRoots(temporaryRoot)) {
    const lease = await readProfileOwnershipLease(profileRoot);
    if (
      lease === null
      || lease.ownerWorkerProcessId !== process.pid
      || lease.browserProcessId === null
      || lease.browserProcessId === process.pid
    ) continue;
    let inspection;
    try {
      const target = await resolveBrowserLaunchTarget({
        browser: lease.browser,
        executablePath: null,
      });
      inspection = await inspectProfileOwnershipLease(
        profileRoot,
        launchIdentityForTarget(target, profileRoot),
        lease.leaseId,
      );
    } catch {
      continue;
    }
    if (
      inspection.state !== "current_owner"
      || !inspection.ownershipProven
      || inspection.browserProcess !== "matched"
    ) continue;
    try {
      process.kill(lease.browserProcessId, "SIGTERM");
      signaled = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
      throw error;
    }
    if (await waitForProcessExit(lease.browserProcessId, EXACT_PROCESS_EXIT_GRACE_MS)) continue;
    const current = await readProfileOwnershipLease(profileRoot);
    if (current?.leaseId !== lease.leaseId) continue;
    const target = await resolveBrowserLaunchTarget({
      browser: lease.browser,
      executablePath: null,
    });
    const rechecked = await inspectProfileOwnershipLease(
      profileRoot,
      launchIdentityForTarget(target, profileRoot),
      lease.leaseId,
    );
    if (
      rechecked.state === "current_owner"
      && rechecked.ownershipProven
      && rechecked.browserProcess === "matched"
    ) {
      try {
        process.kill(lease.browserProcessId, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
  return signaled;
}

export class FakeHumanBrowserSession implements HumanBrowserSession {
  private running = true;
  private exitCode: number | null = null;
  private readonly launchedAt = new Date().toISOString();

  constructor(private readonly launchInput: HumanBrowserLaunchInput) {}

  state(): HumanBrowserProcessState {
    return {
      running: this.running,
      processId: process.pid,
      exitCode: this.exitCode,
      exitSignal: null,
      launchedAt: this.launchedAt,
    };
  }

  identity() {
    return launchIdentityForTarget(
      this.launchInput.target,
      this.launchInput.profileDir,
    );
  }

  async waitForExit(_timeoutMs: number): Promise<boolean> {
    return !this.running;
  }

  async finish(clean = true, exitCode = clean ? 0 : 1): Promise<void> {
    await mkdir(path.join(this.launchInput.profileDir, "Default"), {
      recursive: true,
    });
    await writeFile(
      path.join(this.launchInput.profileDir, "Local State"),
      JSON.stringify({ profile: { last_used: "Default" } }),
    );
    await writeFile(
      path.join(this.launchInput.profileDir, "Default", "Preferences"),
      JSON.stringify({
        profile: clean
          ? { exit_type: "Normal", exited_cleanly: true }
          : { exit_type: "Crashed", exited_cleanly: false },
      }),
    );
    this.running = false;
    this.exitCode = exitCode;
  }
}

export class FakeHumanBrowserLauncher implements HumanBrowserLauncher {
  launches: HumanBrowserLaunchInput[] = [];
  session: FakeHumanBrowserSession | null = null;

  async launch(input: HumanBrowserLaunchInput): Promise<HumanBrowserSession> {
    this.launches.push(input);
    this.session = new FakeHumanBrowserSession(input);
    return this.session;
  }

  async finish(clean = true, exitCode = clean ? 0 : 1): Promise<void> {
    await this.session?.finish(clean, exitCode);
  }
}

export async function listen(candidate: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    candidate.once("error", onError);
    candidate.listen(0, "127.0.0.1", () => {
      candidate.off("error", onError);
      resolve();
    });
  });
  const address = candidate.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fixture server did not bind to TCP.");
  }
  return address.port;
}

export async function closeServer(
  candidate: Server | undefined,
): Promise<void> {
  if (candidate === undefined || !candidate.listening) {
    return;
  }
  candidate.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    candidate.close((error) =>
      error === undefined ? resolve() : reject(error),
    );
  });
}

export function browserConfig(root: string): Stage5BrowserConfig {
  return {
    browser: "chromium",
    browserExecutablePath: null,
    profilesDir: path.join(root, "profiles"),
    profileDir: path.join(root, "profile"),
    artifactsDir: path.join(root, "artifacts"),
    headless: true,
    operationTimeoutMs: 5_000,
    navigationTimeoutMs: 5_000,
    readinessTimeoutMs: 2_000,
    workerStartupTimeoutMs: 5_000,
    workerShutdownGraceMs: 500,
  };
}

export async function requestFakeLoginHandoff(
  candidate: BrowserController,
  config: Stage5BrowserConfig,
  input: Parameters<BrowserController["requestLoginHandoff"]>[0],
  continueRetainedRelease = true,
): ReturnType<BrowserController["requestLoginHandoff"]> {
  const originalHeadless = config.headless;
  config.headless = false;
  try {
    for (let continuation = 0; ; continuation += 1) {
      try {
        return await candidate.requestLoginHandoff(input);
      } catch (error) {
        if (
          !continueRetainedRelease
          || continuation >= MAX_RETAINED_RELEASE_CONTINUATIONS
          || !(error instanceof Stage5BrowserError)
          || error.code !== "AUTH_HANDOFF_REQUIRED"
          || error.details?.reason !== "handoff_release_pending"
        ) throw error;
        // Closing the already-owned process is not authentication input. Continue only
        // the retained release state, under a fixed cap, without relaunch or action replay.
      }
    }
  } finally {
    // The injected launcher is the only headed side of this unit-test boundary. Restoring
    // headless mode before any resume prevents a real Chrome-for-Testing window from opening.
    config.headless = originalHeadless;
  }
}

export function storageInspection(
  targetOrigin: string,
  keys: string[],
): ProfileStorageInspection {
  return {
    observedAt: new Date().toISOString(),
    targetOrigin,
    cookieDatabase: {
      supported: true,
      databaseKind: "chromium_legacy",
      relativePath: "Cookies",
      exists: true,
      modifiedAt: new Date().toISOString(),
      journalModifiedAt: null,
      locations: [],
      targetOriginCookiePresent: keys.length > 0,
      sessionCookiePresent: false,
      persistentCookiePresent: keys.length > 0,
      inspection: "aggregate_metadata",
    },
    keyTokens: new Set(keys),
  };
}

export interface BrowserControllerTestState {
  controller?: BrowserController;
  frameServer?: Server;
  humanLauncher?: FakeHumanBrowserLauncher;
  server?: Server;
  temporaryRoot?: string;
  cleanupGraceMs?: number;
}

export async function cleanBrowserControllerTestState(
  state: BrowserControllerTestState,
): Promise<void> {
  await state.humanLauncher?.finish().catch(() => undefined);
  const stop = state.controller?.stop().catch(() => undefined);
  if (
    stop !== undefined
    && !(await settlesWithin(stop, state.cleanupGraceMs ?? DEFAULT_TEST_CLEANUP_GRACE_MS))
    && state.temporaryRoot !== undefined
  ) {
    const signaled = await terminateExactDisposableProcesses(state.temporaryRoot);
    if (signaled) await settlesWithin(stop, EXACT_PROCESS_EXIT_GRACE_MS);
  }
  await Promise.all([
    closeServer(state.server),
    closeServer(state.frameServer),
  ]);
  if (state.temporaryRoot !== undefined) {
    await rm(state.temporaryRoot, { recursive: true, force: true });
  }
}
