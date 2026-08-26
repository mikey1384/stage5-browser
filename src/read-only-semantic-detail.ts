import type { Locator } from "playwright";

const MAX_DETAIL_CANDIDATES = 20;
const MAX_DETAILS = 3;
const MAX_DETAIL_CHARACTERS = 30_000;
const DETAIL_DEPTH = 20;

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

function semanticLineKey(line: string): string {
  return line
    .replaceAll(/\s*\[ref=[^\]]+\]/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

export async function withReadOnlySemanticContentDetails(input: {
  root: Locator;
  snapshot: string;
  deadlineAt: number;
  filterInactivePopupSnapshot: (snapshot: string) => Promise<string>;
}): Promise<string> {
  if (remainingUntil(input.deadlineAt) <= 0) {
    return input.snapshot;
  }

  const candidates = input.root.locator('article, [role="article"], blockquote');
  const candidateIndexes = await boundedValue(
    candidates.evaluateAll((elements, limit) => {
      const candidateSet = new Set(elements);
      return elements
        .map((element, index) => {
          let ancestor = element.parentElement;
          while (ancestor !== null) {
            if (candidateSet.has(ancestor)) return null;
            ancestor = ancestor.parentElement;
          }
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const visible =
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0" &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth;
          if (!visible) return null;
          const clippedWidth = Math.max(
            0,
            Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0),
          );
          const clippedHeight = Math.max(
            0,
            Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0),
          );
          return { index, visibleArea: clippedWidth * clippedHeight };
        })
        .filter(
          (candidate): candidate is { index: number; visibleArea: number } =>
            candidate !== null,
        )
        .sort(
          (left, right) =>
            right.visibleArea - left.visibleArea || left.index - right.index,
        )
        .slice(0, limit)
        .map(({ index }) => index);
    }, MAX_DETAIL_CANDIDATES),
    Math.max(1, remainingUntil(input.deadlineAt)),
    [] as number[],
  );

  const baseLines = new Set(
    input.snapshot
      .split("\n")
      .map(semanticLineKey)
      .filter((line) => line.length > 0),
  );
  const sections: string[] = [];
  let detailCharacters = 0;
  for (const candidateIndex of candidateIndexes) {
    if (
      sections.length >= MAX_DETAILS ||
      detailCharacters >= MAX_DETAIL_CHARACTERS ||
      remainingUntil(input.deadlineAt) <= 0
    ) {
      break;
    }
    const rawDetail = await boundedValue(
      candidates.nth(candidateIndex).ariaSnapshot({
        mode: "ai",
        depth: DETAIL_DEPTH,
        boxes: false,
        timeout: Math.max(1, remainingUntil(input.deadlineAt)),
      }),
      Math.max(1, remainingUntil(input.deadlineAt)),
      null,
    );
    if (rawDetail === null) continue;
    const filtered = await input.filterInactivePopupSnapshot(rawDetail);
    const refFree = filtered.replaceAll(/\s*\[ref=[^\]]+\]/gu, "").trim();
    if (refFree.length === 0) continue;
    const hasNovelLine = refFree
      .split("\n")
      .map(semanticLineKey)
      .some((line) => line.length > 0 && !baseLines.has(line));
    if (!hasNovelLine) continue;

    const header = `# Visible semantic content detail ${sections.length + 1} (bounded, ref-free)`;
    const remainingCharacters = MAX_DETAIL_CHARACTERS - detailCharacters;
    const boundedLines: string[] = [];
    let sectionCharacters = header.length + 1;
    for (const line of refFree.split("\n")) {
      const additionalCharacters = line.length + 1;
      if (sectionCharacters + additionalCharacters > remainingCharacters) break;
      boundedLines.push(line);
      sectionCharacters += additionalCharacters;
    }
    if (boundedLines.length === 0) continue;
    sections.push(`${header}\n${boundedLines.join("\n")}`);
    detailCharacters += sectionCharacters;
  }

  return sections.length === 0
    ? input.snapshot
    : `${input.snapshot}\n\n${sections.join("\n\n")}`;
}
