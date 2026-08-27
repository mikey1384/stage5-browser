import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { BrowserController } from "../src/browser-controller.js";
import { Stage5BrowserError } from "../src/errors.js";
import {
  browserConfig,
  cleanBrowserControllerTestState,
  requestFakeLoginHandoff,
} from "./browser-controller-fixture.js";

describe("browser controller fixture lifecycle", () => {
  it("bounds a stalled controller teardown so it cannot poison the following test", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "stage5-browser-cleanup-bound-"));
    const controller = {
      stop: vi.fn(() => new Promise(() => undefined)),
    } as unknown as BrowserController;
    const startedAt = Date.now();

    await cleanBrowserControllerTestState({
      controller,
      temporaryRoot,
      cleanupGraceMs: 10,
    });

    expect(controller.stop).toHaveBeenCalledOnce();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("bounds retained close-phase continuations without replaying the private handoff", async () => {
    const result = { state: "awaiting_user" };
    const requestLoginHandoff = vi.fn()
      .mockRejectedValueOnce(new Stage5BrowserError(
        "AUTH_HANDOFF_REQUIRED",
        "The exact controlled process is still exiting.",
        { recoverable: true, details: { reason: "handoff_release_pending" } },
      ))
      .mockRejectedValueOnce(new Stage5BrowserError(
        "AUTH_HANDOFF_REQUIRED",
        "The exact controlled process is still exiting.",
        { recoverable: true, details: { reason: "handoff_release_pending" } },
      ))
      .mockResolvedValueOnce(result);
    const controller = { requestLoginHandoff } as unknown as BrowserController;
    const config = browserConfig(path.join(os.tmpdir(), "stage5-browser-fixture-contract"));
    const input = { url: null, timeoutMs: 5_000 };

    await expect(requestFakeLoginHandoff(controller, config, input)).resolves.toBe(result);
    expect(requestLoginHandoff).toHaveBeenCalledTimes(3);
    expect(requestLoginHandoff).toHaveBeenNthCalledWith(1, input);
    expect(requestLoginHandoff).toHaveBeenNthCalledWith(2, input);
    expect(requestLoginHandoff).toHaveBeenNthCalledWith(3, input);
    expect(config.headless).toBe(true);
  });

  it("stops after the retained close-phase continuation cap", async () => {
    const pending = new Stage5BrowserError(
      "AUTH_HANDOFF_REQUIRED",
      "The exact controlled process is still exiting.",
      { recoverable: true, details: { reason: "handoff_release_pending" } },
    );
    const requestLoginHandoff = vi.fn().mockRejectedValue(pending);
    const controller = { requestLoginHandoff } as unknown as BrowserController;
    const config = browserConfig(path.join(os.tmpdir(), "stage5-browser-fixture-cap"));

    await expect(requestFakeLoginHandoff(
      controller,
      config,
      { url: null, timeoutMs: 5_000 },
    )).rejects.toBe(pending);
    expect(requestLoginHandoff).toHaveBeenCalledTimes(4);
    expect(config.headless).toBe(true);
  });
});
