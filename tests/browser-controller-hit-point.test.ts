import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import type { Locator, Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import { BrowserController } from "../src/browser-controller.js";
import { inspectTargetState } from "../src/page-diagnostics.js";
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

describe("BrowserController exact hit points", () => {
  it("uses a fresh alternate point when a non-target span covers only the center", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Partially covered control</title><style>
        #wrap { position: relative; width: 240px; height: 60px; }
        #target { display: block; width: 240px; height: 60px; background: #ddd; }
        #internal-overlay { position: absolute; z-index: 2; left: 60px; top: 0; width: 120px; height: 60px; pointer-events: auto; }
      </style></head><body>
        <div id="wrap">
          <div id="target" role="button" aria-selected="false" tabindex="0"
            onclick="this.setAttribute('aria-selected', 'true'); document.querySelector('#counter').textContent = 'clicks:1'">
            Annual revenue
          </div>
          <span id="internal-overlay" aria-hidden="true"></span>
        </div>
        <p id="counter">clicks:0</p>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-alternate-hit-point-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const page = (controller as unknown as { activePage: Page }).activePage;
    expect(await inspectTargetState(page.locator("#target") as Locator)).toMatchObject({
      visible: true,
      enabled: true,
      inViewport: true,
      receivesPointerEvents: true,
      pointerHitPoint: "alternate",
      coveredBy: null,
    });

    const observed = await controller.snapshot({
      depth: 6,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    const targetRef = observed.snapshot.match(
      /button "Annual revenue"[^\n]*\[ref=([^\]]+)\]/,
    )?.[1];
    expect(targetRef).toBeDefined();
    if (targetRef === undefined) {
      throw new Error("Alternate-hit-point fixture did not expose the exact button ref.");
    }
    await expect(controller.clickRef({
      snapshotId: observed.snapshotId,
      ref: targetRef,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: true,
        expectedVisible: null,
        expectedHidden: null,
        timeoutMs: 2_000,
      },
      timeoutMs: 5_000,
    })).resolves.toMatchObject({ postcondition: { passed: true } });
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      outcome: "succeeded",
      actionDispatched: true,
      clickDispatched: true,
      targetState: { pointerHitPoint: "alternate" },
      dispatchEvidence: {
        forcedFallbackUsed: false,
        pageMouseFallbackUsed: false,
        trustedEventObserved: true,
        pointerDownOnTarget: true,
        mouseDownOnTarget: true,
        pointerUpOnTarget: true,
        mouseUpOnTarget: true,
        clickOnTarget: true,
        misdirectedEventBlocked: false,
      },
    });
    expect(await page.locator("#counter").innerText()).toBe("clicks:1");
  });

  it("accepts a slotted composed-tree descendant that covers a native button", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Slotted native control</title></head><body>
        <stage5-native-control><span id="slotted-cover" slot="label">Annual revenue</span></stage5-native-control>
        <p id="counter">clicks:0</p>
        <script>
          customElements.define('stage5-native-control', class extends HTMLElement {
            constructor() {
              super();
              const root = this.attachShadow({ mode: 'open' });
              root.innerHTML = \`<style>
                button { position: relative; display: block; width: 240px; height: 60px; }
                ::slotted(span) { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: auto; }
              </style><button type="button" aria-expanded="false"><slot name="label"></slot></button>\`;
              root.querySelector('button').addEventListener('click', (event) => {
                event.currentTarget.setAttribute('aria-expanded', 'true');
                document.querySelector('#counter').textContent = 'clicks:1';
              });
            }
          });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-slotted-hit-point-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const page = (controller as unknown as { activePage: Page }).activePage;
    const target = page.getByRole("button", { name: "Annual revenue" });
    expect(await target.evaluate((element) =>
      element.contains(document.querySelector("#slotted-cover")))).toBe(false);
    expect(await inspectTargetState(target as Locator)).toMatchObject({
      visible: true,
      enabled: true,
      inViewport: true,
      receivesPointerEvents: true,
      pointerHitPoint: "center",
      coveredBy: null,
    });

    await expect(controller.clickByRole({
      role: "button",
      name: "Annual revenue",
      exact: true,
      frameId: null,
      postcondition: {
        expectedUrl: null,
        expectedSelected: true,
        expectedVisible: null,
        timeoutMs: 2_000,
      },
      timeoutMs: 5_000,
    })).resolves.toMatchObject({ postcondition: { passed: true } });
    expect((await controller.diagnostics()).page?.lastAction).toMatchObject({
      outcome: "succeeded",
      actionDispatched: true,
      clickDispatched: true,
      targetState: { pointerHitPoint: "center" },
      dispatchEvidence: {
        keyDownOnTarget: true,
        trustedEventObserved: true,
        clickOnTarget: true,
        misdirectedEventBlocked: false,
        targetStateChangeBlocked: false,
      },
    });
    expect(await page.locator("#counter").innerText()).toBe("clicks:1");
  });
});
