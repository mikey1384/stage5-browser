import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("BrowserController tab capabilities", () => {
  it("inspects and selects one exact duplicate tab without background activation or index drift", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><head><title>Duplicate workspace</title></head><body>Workspace</body></html>",
      );
    });
    const port = await listen(server);
    const applicationUrl = `http://127.0.0.1:${port}/application`;
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-background-tab-inspection-"),
    );
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/placeholder`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    await controller.open({
      url: applicationUrl,
      newTab: true,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const internals = controller as unknown as {
      activePage: Page;
      context: { pages: () => Page[] };
    };
    const feedPage = internals.activePage;
    await feedPage.evaluate(() => {
      document.title = "Duplicate workspace";
      document.body.innerHTML = '<main><h1>Prior Page posts</h1><article><button type="button">See more</button><p>Earlier published context</p></article></main>';
    });
    await controller.open({
      url: applicationUrl,
      newTab: true,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    const draftPage = internals.activePage;
    await draftPage.evaluate(() => {
      document.title = "Duplicate workspace";
      document.body.innerHTML = '<div role="dialog" aria-modal="true"><h1>Create post</h1><button type="button">Preserve draft</button></div>';
    });

    const listed = await controller.tabs();
    const duplicateTabs = listed.pages.filter((page) => page.url === applicationUrl);
    expect(duplicateTabs).toHaveLength(2);
    expect(new Set(duplicateTabs.map((page) => page.tabId)).size).toBe(2);
    expect(duplicateTabs.every((page) => /^tab-[0-9a-f-]{36}$/u.test(page.tabId))).toBe(true);
    const feedIndex = internals.context.pages().indexOf(feedPage);
    const draftIndex = internals.context.pages().indexOf(draftPage);
    const feedTab = listed.pages.find((page) => page.index === feedIndex);
    const draftTab = listed.pages.find((page) => page.index === draftIndex);
    expect(feedTab).toBeDefined();
    expect(draftTab).toBeDefined();
    if (feedTab === undefined || draftTab === undefined) {
      throw new Error("Fixture did not expose both duplicate tab capabilities.");
    }
    expect(listed.activePageIndex).toBe(draftTab.index);

    const bringFeedToFront = vi.spyOn(feedPage, "bringToFront");
    const inspected = await controller.inspectTab({
      tabId: feedTab.tabId,
      depth: 8,
      temporaryActivation: false,
      waitFor: null,
      timeoutMs: 5_000,
    });
    expect(inspected).toMatchObject({
      scope: "document",
      refCount: 0,
      elementActionsAvailable: false,
      activationAttempted: false,
      visibleModalCount: 0,
      controllerSelectionUnchanged: true,
      warnings: [],
    });
    expect(inspected.snapshot).toContain("Prior Page posts");
    expect(inspected.snapshot).toContain("Earlier published context");
    expect(inspected.snapshot).not.toContain("Create post");
    expect(inspected.snapshot).not.toContain("[ref=");
    expect(bringFeedToFront).not.toHaveBeenCalled();
    expect((await controller.tabs()).activePageIndex).toBe(draftTab.index);

    const placeholderPage = internals.context.pages().find((page) => page.url().endsWith("/placeholder"));
    expect(placeholderPage).toBeDefined();
    await placeholderPage?.close();
    const selected = await controller.selectTab({ tabId: feedTab.tabId });
    expect(selected.page.tabId).toBe(feedTab.tabId);
    expect(selected.page.url).toBe(applicationUrl);
    expect(selected.page.index).toBe(feedTab.index - 1);
    expect(bringFeedToFront).toHaveBeenCalledTimes(1);
    const selectedSnapshot = await controller.snapshot({
      depth: 8,
      boxes: false,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(selectedSnapshot.scope).toBe("document");
    expect(selectedSnapshot.snapshot).toContain("Prior Page posts");
    expect(selectedSnapshot.snapshot).not.toContain("Create post");

    await feedPage.close();
    await expect(controller.inspectTab({
      tabId: feedTab.tabId,
      depth: 8,
      temporaryActivation: false,
      waitFor: null,
      timeoutMs: 5_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "TARGET_NOT_FOUND",
      details: {
        reason: "stale_tab_id",
        actionDispatched: false,
      },
    });
  });

  it("recovers one temporary visibility loss, fails on a second, and restores exact selection", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><head><title>Bounded tab fixture</title></head><body>Fixture</body></html>",
      );
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "stage5-browser-temporary-tab-activation-"),
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
      document.body.innerHTML = '<div role="dialog" aria-modal="true"><h1>Unpublished draft</h1></div>';
    });
    await feedPage.evaluate(() => {
      const fixtureWindow = window as typeof window & {
        __fixtureVisibility?: "visible" | "hidden";
        __fixtureVisibleTransitions?: number;
        __fixtureRepeatHide?: boolean;
        __setFixtureVisibility?: (state: "visible" | "hidden") => void;
      };
      fixtureWindow.__fixtureVisibility = "hidden";
      fixtureWindow.__fixtureVisibleTransitions = 0;
      fixtureWindow.__fixtureRepeatHide = false;
      fixtureWindow.__setFixtureVisibility = (state) => {
        fixtureWindow.__fixtureVisibility = state;
        document.dispatchEvent(new Event("visibilitychange"));
      };
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => fixtureWindow.__fixtureVisibility,
      });
      document.title = "Prior posts";
      document.body.innerHTML = '<main><div role="status">Loading...</div></main>';
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        fixtureWindow.__fixtureVisibleTransitions =
          (fixtureWindow.__fixtureVisibleTransitions ?? 0) + 1;
        if (
          fixtureWindow.__fixtureRepeatHide ||
          fixtureWindow.__fixtureVisibleTransitions === 1
        ) {
          window.setTimeout(() => fixtureWindow.__setFixtureVisibility?.("hidden"), 25);
          return;
        }
        window.setTimeout(() => {
          document.body.innerHTML = '<main><article><h1>Prior posts loaded</h1><p>Read-only context</p></article></main>';
        }, 100);
      });
    });

    const listed = await controller.tabs();
    const feedIndex = internals.context.pages().indexOf(feedPage);
    const draftIndex = internals.context.pages().indexOf(draftPage);
    const feedTab = listed.pages.find((page) => page.index === feedIndex);
    expect(feedTab).toBeDefined();
    if (feedTab === undefined) {
      throw new Error("Temporary-activation fixture did not expose the feed tab capability.");
    }
    const originalFeedBringToFront = feedPage.bringToFront.bind(feedPage);
    const originalDraftBringToFront = draftPage.bringToFront.bind(draftPage);
    const bringFeedToFront = vi.spyOn(feedPage, "bringToFront").mockImplementation(async () => {
      await originalFeedBringToFront();
      await feedPage.evaluate(() => {
        (window as typeof window & {
          __setFixtureVisibility?: (state: "visible" | "hidden") => void;
        }).__setFixtureVisibility?.("visible");
      });
    });
    const restoreDraftToFront = vi.spyOn(draftPage, "bringToFront").mockImplementation(async () => {
      await originalDraftBringToFront();
      await feedPage.evaluate(() => {
        (window as typeof window & {
          __setFixtureVisibility?: (state: "visible" | "hidden") => void;
        }).__setFixtureVisibility?.("hidden");
      });
    });

    const passive = await controller.inspectTab({
      tabId: feedTab.tabId,
      depth: 8,
      temporaryActivation: false,
      waitFor: null,
      timeoutMs: 5_000,
    });
    expect(passive).toMatchObject({
      activationAttempted: false,
      activationRestored: null,
      rendererVisibility: "hidden",
      rendererVisibilityAfterRestore: "hidden",
      loadingWait: null,
      controllerSelectionUnchanged: true,
    });
    expect(passive.snapshot).toContain("Loading...");
    expect(bringFeedToFront).not.toHaveBeenCalled();
    expect(restoreDraftToFront).not.toHaveBeenCalled();

    const activated = await controller.inspectTab({
      tabId: feedTab.tabId,
      depth: 8,
      temporaryActivation: true,
      waitFor: { condition: "either", timeoutMs: 2_000 },
      timeoutMs: 5_000,
    });
    expect(activated).toMatchObject({
      activationAttempted: true,
      activationRestored: true,
      rendererVisibility: "visible",
      rendererVisibilityAfterRestore: "hidden",
      loadingWait: {
        requested: true,
        satisfied: true,
      },
      refCount: 0,
      elementActionsAvailable: false,
      controllerSelectionUnchanged: true,
      warnings: [],
    });
    expect(activated.snapshot).toContain("Prior posts loaded");
    expect(activated.snapshot).toContain("Read-only context");
    expect(activated.snapshot).not.toContain("[ref=");
    expect(bringFeedToFront).toHaveBeenCalledTimes(2);
    expect(restoreDraftToFront).toHaveBeenCalledTimes(1);
    expect(await feedPage.evaluate(() => (
      window as typeof window & { __fixtureVisibleTransitions?: number }
    ).__fixtureVisibleTransitions)).toBe(2);
    expect((await controller.tabs()).activePageIndex).toBe(draftIndex);
    expect(await draftPage.evaluate(() => document.visibilityState)).toBe("visible");
    expect(await feedPage.evaluate(() => document.visibilityState)).toBe("hidden");

    await feedPage.evaluate(() => {
      const fixtureWindow = window as typeof window & {
        __fixtureVisibleTransitions?: number;
        __fixtureRepeatHide?: boolean;
      };
      fixtureWindow.__fixtureVisibleTransitions = 0;
      fixtureWindow.__fixtureRepeatHide = true;
      document.body.innerHTML = '<main><div role="status">Loading again...</div></main>';
    });
    await expect(controller.inspectTab({
      tabId: feedTab.tabId,
      depth: 8,
      temporaryActivation: true,
      waitFor: { condition: "either", timeoutMs: 2_000 },
      timeoutMs: 5_000,
    })).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      code: "OPERATION_FAILED",
      details: {
        reason: "temporary_tab_activation_visibility_lost",
        visibilityRecoveryAttempted: true,
        elementActionDispatched: false,
      },
    });
    expect(bringFeedToFront).toHaveBeenCalledTimes(4);
    expect(restoreDraftToFront).toHaveBeenCalledTimes(2);
    expect((await controller.tabs()).activePageIndex).toBe(draftIndex);
    expect(await draftPage.evaluate(() => document.visibilityState)).toBe("visible");
    expect(await feedPage.evaluate(() => document.visibilityState)).toBe("hidden");
  });
});
