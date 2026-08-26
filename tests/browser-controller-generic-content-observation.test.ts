import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BrowserController } from "../src/browser-controller.js";
import { Stage5BrowserError } from "../src/errors.js";
import {
  browserConfig,
  cleanBrowserControllerTestState,
  listen,
} from "./browser-controller-fixture.js";

let server: Server | undefined;
let controller: BrowserController | undefined;
let temporaryRoot: string | undefined;

afterEach(async () => {
  await cleanBrowserControllerTestState({ controller, server, temporaryRoot });
  controller = undefined;
  server = undefined;
  temporaryRoot = undefined;
});

describe("BrowserController generic content observation", () => {
  it("does not infer generic loading-text disappearance from a capped scan", async () => {
    const complexMarkup = Array.from(
      { length: 5_001 },
      (_, index) => `<span>Decorative text ${index + 1}</span>`,
    ).join("");
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Bounded generic loading</title><style>
        body { margin: 0; min-height: 1800px; }
      </style></head><body>
        <div id="loader">Loading...</div>
        <div aria-hidden="true">${complexMarkup}</div>
        <script>
          addEventListener('scroll', () => document.querySelector('#loader')?.remove(), { once: true });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-generic-loading-cap-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    await expect(
      controller.scroll({
        direction: "down",
        amount: "half_viewport",
        count: 1,
        settleMs: 0,
        frameId: null,
        endMarker: null,
        target: null,
        waitFor: {
          condition: "loading_indicators_disappear",
          timeoutMs: 150,
        },
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "OPERATION_FAILED",
      details: {
        reason: "scroll_observation_incomplete",
        actionDispatched: true,
        stepsCompleted: 1,
      },
    });
  });
});
