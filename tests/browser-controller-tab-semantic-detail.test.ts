import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserController } from "../src/browser-controller.js";
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

describe("BrowserController ref-free tab semantic detail", () => {
  it("recognizes generic loading to quoted content and captures bounded deep detail", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><head><title>Read-only semantic detail</title></head><body>Fixture</body></html>",
      );
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-tab-semantic-detail-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/placeholder`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    await controller.open({
      url: `http://127.0.0.1:${port}/feed`,
      newTab: true,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const internals = controller as unknown as {
      activePage: Page;
      context: { pages: () => Page[] };
    };
    const feedPage = internals.activePage;
    await controller.open({
      url: `http://127.0.0.1:${port}/draft`,
      newTab: true,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const draftPage = internals.activePage;
    await draftPage.evaluate(() => {
      document.title = "Preserved draft";
      document.body.innerHTML =
        '<div role="dialog" aria-modal="true"><h1>Unpublished draft</h1></div>';
    });
    await feedPage.evaluate(() => {
      const fixtureWindow = window as typeof window & {
        __fixtureVisibility?: "visible" | "hidden";
        __setFixtureVisibility?: (state: "visible" | "hidden") => void;
      };
      fixtureWindow.__fixtureVisibility = "hidden";
      fixtureWindow.__setFixtureVisibility = (state) => {
        fixtureWindow.__fixtureVisibility = state;
        document.dispatchEvent(new Event("visibilitychange"));
      };
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => fixtureWindow.__fixtureVisibility,
      });
      document.body.innerHTML = "<main><div>Loading...</div></main>";
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        window.setTimeout(() => {
          const layers = Array.from(
            { length: 10 },
            (_, index) => `<div role="group" aria-label="Layer ${index + 1}">`,
          ).join("");
          document.body.innerHTML = `<main>${layers}<blockquote><p>Expanded public post context</p><button type="button">See more</button></blockquote>${"</div>".repeat(10)}</main>`;
        }, 100);
      });
    });

    const listed = await controller.tabs();
    const feedIndex = internals.context.pages().indexOf(feedPage);
    const draftIndex = internals.context.pages().indexOf(draftPage);
    const feedTab = listed.pages.find((page) => page.index === feedIndex);
    expect(feedTab).toBeDefined();
    if (feedTab === undefined) {
      throw new Error(
        "Semantic-detail fixture did not expose the feed tab capability.",
      );
    }

    const originalFeedBringToFront = feedPage.bringToFront.bind(feedPage);
    const originalDraftBringToFront = draftPage.bringToFront.bind(draftPage);
    const bringFeedToFront = vi
      .spyOn(feedPage, "bringToFront")
      .mockImplementation(async () => {
        await originalFeedBringToFront();
        await feedPage.evaluate(() => {
          (window as typeof window & {
            __setFixtureVisibility?: (state: "visible" | "hidden") => void;
          }).__setFixtureVisibility?.("visible");
        });
      });
    const restoreDraftToFront = vi
      .spyOn(draftPage, "bringToFront")
      .mockImplementation(async () => {
        await originalDraftBringToFront();
        await feedPage.evaluate(() => {
          (window as typeof window & {
            __setFixtureVisibility?: (state: "visible" | "hidden") => void;
          }).__setFixtureVisibility?.("hidden");
        });
      });

    const inspected = await controller.inspectTab({
      tabId: feedTab.tabId,
      depth: 4,
      temporaryActivation: true,
      waitFor: { condition: "either", timeoutMs: 2_000 },
      timeoutMs: 5_000,
    });
    expect(inspected).toMatchObject({
      activationAttempted: true,
      activationRestored: true,
      rendererVisibility: "visible",
      rendererVisibilityAfterRestore: "hidden",
      loadingWait: {
        satisfied: true,
        evidence: "article_count_growth",
        before: { articleCount: 0, loadingIndicatorCount: 1 },
        after: { articleCount: 1, loadingIndicatorCount: 0 },
      },
      refCount: 0,
      elementActionsAvailable: false,
      controllerSelectionUnchanged: true,
      warnings: [],
    });
    expect(inspected.snapshot).toContain(
      "# Visible semantic content detail 1 (bounded, ref-free)",
    );
    expect(inspected.snapshot).toContain("Expanded public post context");
    expect(inspected.snapshot).toContain("See more");
    expect(inspected.snapshot).not.toContain("[ref=");
    expect(bringFeedToFront).toHaveBeenCalledTimes(1);
    expect(restoreDraftToFront).toHaveBeenCalledTimes(1);
    expect((await controller.tabs()).activePageIndex).toBe(draftIndex);
    expect(await draftPage.evaluate(() => document.visibilityState)).toBe(
      "visible",
    );
    expect(await feedPage.evaluate(() => document.visibilityState)).toBe(
      "hidden",
    );

    await feedPage.evaluate(() => {
      const layers = Array.from(
        { length: 10 },
        (_, index) => `<div role="group" aria-label="Modal layer ${index + 1}">`,
      ).join("");
      document.body.innerHTML = `<div role="dialog" aria-modal="true"><h1>Preserved modal</h1></div><main>${layers}<blockquote><p>Underlying deep context</p></blockquote>${"</div>".repeat(10)}</main>`;
    });
    const modalInspection = await controller.inspectTab({
      tabId: feedTab.tabId,
      depth: 4,
      temporaryActivation: false,
      waitFor: null,
      timeoutMs: 5_000,
    });
    expect(modalInspection).toMatchObject({
      activationAttempted: false,
      activationRestored: null,
      visibleModalCount: 1,
      refCount: 0,
      elementActionsAvailable: false,
    });
    expect(modalInspection.snapshot).not.toContain(
      "# Visible semantic content detail",
    );
    expect(bringFeedToFront).toHaveBeenCalledTimes(1);
    expect(restoreDraftToFront).toHaveBeenCalledTimes(1);
  });
});
