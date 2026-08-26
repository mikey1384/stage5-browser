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

describe("BrowserController snapshot-bound file input handoff", () => {
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
});
