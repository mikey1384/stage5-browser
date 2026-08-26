import { randomUUID } from "node:crypto";

import type { ElementHandle, Frame, Locator } from "playwright";

import { inspectTargetState } from "./page-diagnostics.js";
import type { ScrollContainerObservation } from "./protocol.js";

export interface ObservedScrollContainer {
  locator: Locator;
  handle: ElementHandle<HTMLElement>;
  observation: ScrollContainerObservation;
}

export const MAX_SCROLL_CONTAINERS_PER_SNAPSHOT = 20;

const MAX_SCROLL_CONTAINER_DETAILS_PER_SNAPSHOT = 3;
const MAX_SCROLL_CONTAINER_DETAIL_CHARACTERS = 30_000;
const MAX_SCROLL_CONTAINER_DETAIL_REFS = 60;
const SCROLL_CONTAINER_DETAIL_DEPTH = 16;

async function boundedValue<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function remainingUntil(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

export async function inspectScrollContainer(
  handle: ElementHandle<HTMLElement>,
): Promise<Omit<ScrollContainerObservation, "ref"> | null> {
  try {
    return await handle.evaluate((element) => {
      if (
        !(element instanceof HTMLElement) ||
        element === document.scrollingElement ||
        element === document.documentElement ||
        element === document.body
      ) {
        return null;
      }
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0";
      const verticalOverflowAllowsScrolling =
        style.overflowY === "auto" ||
        style.overflowY === "scroll" ||
        style.overflowY === "overlay" ||
        element.scrollTop > 0;
      const horizontalOverflowAllowsScrolling =
        style.overflowX === "auto" ||
        style.overflowX === "scroll" ||
        style.overflowX === "overlay" ||
        element.scrollLeft > 0;
      const maxX = Math.max(0, element.scrollWidth - element.clientWidth);
      const maxY = Math.max(0, element.scrollHeight - element.clientHeight);
      if (!visible || !(
        (verticalOverflowAllowsScrolling && maxY > 1) ||
        (horizontalOverflowAllowsScrolling && maxX > 1)
      )) return null;
      const inViewport =
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth;
      const semanticRole =
        element
          .getAttribute("role")
          ?.trim()
          .split(/\s+/)[0]
          ?.toLocaleLowerCase() ?? null;
      const containsPopupSemantics =
        semanticRole === "listbox" ||
        semanticRole === "menu" ||
        semanticRole === "tree" ||
        element.matches("select") ||
        element.querySelector(
          '[role="option"], option, [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="treeitem"]',
        ) !== null;
      if (!inViewport && containsPopupSemantics) return null;
      const labelledBy = (element.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      const rawLabel =
        [
          element.getAttribute("aria-label") ?? "",
          labelledBy,
          element.getAttribute("title") ?? "",
        ].find((candidate) => candidate.trim().length > 0) ?? "";
      const label = rawLabel.replace(/\s+/g, " ").trim().slice(0, 200);
      return {
        label: label.length === 0 ? null : label,
        role: element.getAttribute("role"),
        inViewport,
        position: {
          x: element.scrollLeft,
          y: element.scrollTop,
          maxX,
          maxY,
          viewportWidth: element.clientWidth,
          viewportHeight: element.clientHeight,
          contentWidth: element.scrollWidth,
          contentHeight: element.scrollHeight,
        },
      };
    });
  } catch {
    return null;
  }
}

export async function observeScrollContainers(
  root: Locator,
): Promise<{
  containers: Map<string, ObservedScrollContainer>;
  truncated: boolean;
}> {
  const descendants = root.locator("*");
  const candidateIndexes = await descendants.evaluateAll(
    (elements, limit) =>
      elements
        .map((element, index) => {
          if (!(element instanceof HTMLElement)) return null;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const visible =
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0";
          const verticalOverflowAllowsScrolling =
            style.overflowY === "auto" ||
            style.overflowY === "scroll" ||
            style.overflowY === "overlay" ||
            element.scrollTop > 0;
          const horizontalOverflowAllowsScrolling =
            style.overflowX === "auto" ||
            style.overflowX === "scroll" ||
            style.overflowX === "overlay" ||
            element.scrollLeft > 0;
          const verticallyScrollable = verticalOverflowAllowsScrolling &&
            element.scrollHeight - element.clientHeight > 1;
          const horizontallyScrollable = horizontalOverflowAllowsScrolling &&
            element.scrollWidth - element.clientWidth > 1;
          if (!visible || (!verticallyScrollable && !horizontallyScrollable)) {
            return null;
          }
          const inViewport =
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth;
          const role =
            element
              .getAttribute("role")
              ?.trim()
              .split(/\s+/)[0]
              ?.toLocaleLowerCase() ?? null;
          const containsPopupSemantics =
            role === "listbox" ||
            role === "menu" ||
            role === "tree" ||
            element.matches("select") ||
            element.querySelector(
              '[role="option"], option, [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="treeitem"]',
            ) !== null;
          if (!inViewport && containsPopupSemantics) return null;
          return {
            index,
            inViewport,
            visibleArea:
              Math.max(
                0,
                Math.min(rect.bottom, window.innerHeight) -
                  Math.max(rect.top, 0),
              ) *
              Math.max(
                0,
                Math.min(rect.right, window.innerWidth) -
                  Math.max(rect.left, 0),
              ),
          };
        })
        .filter(
          (
            candidate,
          ): candidate is {
            index: number;
            inViewport: boolean;
            visibleArea: number;
          } => candidate !== null,
        )
        .sort(
          (left, right) =>
            Number(right.inViewport) - Number(left.inViewport) ||
            right.visibleArea - left.visibleArea,
        )
        .slice(0, limit + 1)
        .map(({ index }) => index),
    MAX_SCROLL_CONTAINERS_PER_SNAPSHOT,
  );
  const containers = new Map<string, ObservedScrollContainer>();
  let rootCandidateCount = 0;
  try {
    const rootHandle =
      (await root.elementHandle()) as ElementHandle<HTMLElement> | null;
    if (rootHandle !== null) {
      const rootObservation = await inspectScrollContainer(rootHandle);
      if (rootObservation === null) {
        await rootHandle.dispose().catch(() => undefined);
      } else {
        const ref = `scroll-${randomUUID()}`;
        containers.set(ref, {
          locator: root,
          handle: rootHandle,
          observation: { ref, ...rootObservation },
        });
        rootCandidateCount = 1;
      }
    }

    const remainingCapacity =
      MAX_SCROLL_CONTAINERS_PER_SNAPSHOT - containers.size;
    for (const index of candidateIndexes.slice(0, remainingCapacity)) {
      const locator = descendants.nth(index);
      const handle =
        (await locator.elementHandle()) as ElementHandle<HTMLElement> | null;
      if (handle === null) continue;
      const observation = await inspectScrollContainer(handle);
      if (observation === null) {
        await handle.dispose().catch(() => undefined);
        continue;
      }
      const ref = `scroll-${randomUUID()}`;
      containers.set(ref, {
        locator,
        handle,
        observation: { ref, ...observation },
      });
    }
  } catch (error) {
    for (const { handle } of containers.values()) {
      await handle.dispose().catch(() => undefined);
    }
    throw error;
  }
  return {
    containers,
    truncated:
      candidateIndexes.length >
      MAX_SCROLL_CONTAINERS_PER_SNAPSHOT - rootCandidateCount,
  };
}

async function filterSnapshotToViewportRefs(
  frame: Frame,
  snapshot: string,
  deadlineAt: number,
): Promise<string> {
  const lines = snapshot.split("\n");
  const referencedLines = lines.flatMap((line, index) => {
    const ref = line.match(/\[ref=([^\]]+)\]/u)?.[1];
    if (ref === undefined) return [];
    return [{ index, indentation: line.match(/^\s*/u)?.[0].length ?? 0, ref }];
  });
  const renderedByLine = new Map<number, boolean>();
  const candidates = referencedLines.slice(0, MAX_SCROLL_CONTAINER_DETAIL_REFS);
  const observations = await Promise.all(
    candidates.map(async (entry) => {
      if (remainingUntil(deadlineAt) <= 0)
        return { index: entry.index, rendered: false };
      const locator = frame.locator(`aria-ref=${entry.ref}`);
      const count = await boundedValue(
        locator.count(),
        Math.max(1, remainingUntil(deadlineAt)),
        -1,
      );
      const state =
        count === 1
          ? await boundedValue(
              inspectTargetState(locator),
              Math.max(1, remainingUntil(deadlineAt)),
              null,
            )
          : null;
      return {
        index: entry.index,
        rendered: state?.visible === true && state.inViewport,
      };
    }),
  );
  for (const observation of observations) {
    renderedByLine.set(observation.index, observation.rendered);
  }
  for (const entry of referencedLines.slice(MAX_SCROLL_CONTAINER_DETAIL_REFS)) {
    renderedByLine.set(entry.index, false);
  }

  const filtered: string[] = [];
  let suppressedIndentation: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const indentation = line.match(/^\s*/u)?.[0].length ?? 0;
    if (suppressedIndentation !== null) {
      if (line.trim() === "" || indentation > suppressedIndentation) continue;
      suppressedIndentation = null;
    }
    if (renderedByLine.get(index) === false) {
      suppressedIndentation = indentation;
      continue;
    }
    filtered.push(line);
  }
  return filtered.join("\n");
}

export async function withScrollContainerSemanticDetails(input: {
  boxes: boolean;
  containers: Map<string, ObservedScrollContainer>;
  deadlineAt: number;
  filterInactivePopupSnapshot: (snapshot: string) => Promise<string>;
  frame: Frame;
  requestedDepth: number;
  snapshot: string;
}): Promise<string> {
  const sections: string[] = [];
  let detailCharacters = 0;
  let detailedContainers = 0;
  for (const container of input.containers.values()) {
    if (
      !container.observation.inViewport ||
      detailedContainers >= MAX_SCROLL_CONTAINER_DETAILS_PER_SNAPSHOT ||
      detailCharacters >= MAX_SCROLL_CONTAINER_DETAIL_CHARACTERS ||
      remainingUntil(input.deadlineAt) <= 0
    ) {
      continue;
    }
    const rawDetail = await boundedValue(
      container.locator.ariaSnapshot({
        mode: "ai",
        depth: Math.min(
          20,
          Math.max(input.requestedDepth, SCROLL_CONTAINER_DETAIL_DEPTH),
        ),
        boxes: input.boxes,
        timeout: Math.max(1, remainingUntil(input.deadlineAt)),
      }),
      Math.max(1, remainingUntil(input.deadlineAt)),
      null,
    );
    if (rawDetail === null) continue;
    const popupFiltered = await input.filterInactivePopupSnapshot(rawDetail);
    const renderedDetail = await filterSnapshotToViewportRefs(
      input.frame,
      popupFiltered,
      input.deadlineAt,
    );
    if (renderedDetail.trim() === "") continue;

    const header = `# Visible semantic detail for ${container.observation.ref} (bounded)`;
    const remainingCharacters =
      MAX_SCROLL_CONTAINER_DETAIL_CHARACTERS - detailCharacters;
    const boundedLines: string[] = [];
    let sectionCharacters = header.length + 1;
    for (const line of renderedDetail.split("\n")) {
      const additionalCharacters = line.length + 1;
      if (sectionCharacters + additionalCharacters > remainingCharacters) break;
      boundedLines.push(line);
      sectionCharacters += additionalCharacters;
    }
    if (boundedLines.length === 0) continue;
    sections.push(`${header}\n${boundedLines.join("\n")}`);
    detailCharacters += sectionCharacters;
    detailedContainers += 1;
  }
  return sections.length === 0
    ? input.snapshot
    : `${input.snapshot}\n\n${sections.join("\n\n")}`;
}
