import { mkdir, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";

import type { BrowserController } from "../src/browser-controller.js";
import type { Stage5BrowserConfig } from "../src/config.js";
import type {
  HumanBrowserLaunchInput,
  HumanBrowserLauncher,
  HumanBrowserProcessState,
  HumanBrowserSession,
} from "../src/human-auth-bootstrap.js";
import type { ProfileStorageInspection } from "../src/profile-binding.js";
import { launchIdentityForTarget } from "../src/profile-binding.js";

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
): ReturnType<BrowserController["requestLoginHandoff"]> {
  const originalHeadless = config.headless;
  config.headless = false;
  try {
    return await candidate.requestLoginHandoff(input);
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
}

export async function cleanBrowserControllerTestState(
  state: BrowserControllerTestState,
): Promise<void> {
  await state.humanLauncher?.finish().catch(() => undefined);
  await state.controller?.stop().catch(() => undefined);
  await Promise.all([
    closeServer(state.server),
    closeServer(state.frameServer),
  ]);
  if (state.temporaryRoot !== undefined) {
    await rm(state.temporaryRoot, { recursive: true, force: true });
  }
}
