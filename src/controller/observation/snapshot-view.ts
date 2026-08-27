const TASK_SURFACE_ROLE =
  /^\s*-\s+(?:alert|button|checkbox|combobox|dialog|form|heading|link|listbox|menu|menuitem|menuitemcheckbox|menuitemradio|option|progressbar|radio|radiogroup|searchbox|slider|spinbutton|status|switch|tab|tablist|textbox|tree|treeitem)\b/u;
const TASK_NARRATIVE_ROLE =
  /^\s*-\s+(?:caption|definition|description|listitem|note|paragraph|text)\b/u;
const MAX_ADJACENT_NARRATIVE_LINES = 2;
const MAX_DESCENDANT_NARRATIVE_LINES = 4;

export interface SnapshotViewResult {
  snapshot: string;
  omittedLineCount: number;
}

export interface SelectedSnapshotView extends SnapshotViewResult {
  snapshotView: "task" | "full";
  fullSnapshotAvailable: boolean;
}

export function selectSnapshotView(
  snapshot: string,
  requested: "task" | "full" | undefined,
): SelectedSnapshotView {
  const snapshotView = requested ?? "full";
  const viewed =
    snapshotView === "task"
      ? compactTaskSnapshot(snapshot)
      : { snapshot, omittedLineCount: 0 };
  return {
    ...viewed,
    snapshotView,
    fullSnapshotAvailable: viewed.omittedLineCount > 0,
  };
}

export function compactTaskSnapshot(snapshot: string): SnapshotViewResult {
  const lines = snapshot.split("\n");
  const retained = new Set<number>();
  const informative = lines.flatMap((line, index) =>
    TASK_SURFACE_ROLE.test(line) || line.includes("[cursor=pointer]")
      ? [index]
      : [],
  );
  if (informative.length === 0) return { snapshot, omittedLineCount: 0 };

  for (const index of informative) {
    retained.add(index);
    let childIndent = indentation(lines[index]!);
    for (
      let candidate = index - 1;
      candidate >= 0 && childIndent > 0;
      candidate -= 1
    ) {
      const line = lines[candidate]!;
      if (line.trim().length === 0) continue;
      const candidateIndent = indentation(line);
      if (candidateIndent >= childIndent) continue;
      retained.add(candidate);
      childIndent = candidateIndent;
    }
    retainLocalNarrativeContext(lines, index, retained);
  }

  const compacted = lines.filter((_line, index) => retained.has(index));
  return {
    snapshot: compacted.join("\n"),
    omittedLineCount: Math.max(0, lines.length - compacted.length),
  };
}

export async function discardOmittedSnapshotCapabilities<
  Capability extends { handle: { dispose: () => Promise<void> } },
>(
  capabilities: Map<string, Capability>,
  retainedRefs: ReadonlySet<string>,
): Promise<void> {
  const disposals: Promise<void>[] = [];
  for (const [ref, capability] of capabilities) {
    if (retainedRefs.has(ref)) continue;
    capabilities.delete(ref);
    disposals.push(capability.handle.dispose());
  }
  await Promise.allSettled(disposals);
}

function retainLocalNarrativeContext(
  lines: readonly string[],
  surfaceIndex: number,
  retained: Set<number>,
): void {
  const surfaceIndent = indentation(lines[surfaceIndex]!);
  let descendantCount = 0;
  for (let index = surfaceIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    if (indentation(line) <= surfaceIndent) break;
    if (!TASK_NARRATIVE_ROLE.test(line)) continue;
    retained.add(index);
    descendantCount += 1;
    if (descendantCount >= MAX_DESCENDANT_NARRATIVE_LINES) break;
  }

  for (const direction of [-1, 1] as const) {
    let narrativeCount = 0;
    for (
      let index = surfaceIndex + direction;
      index >= 0 && index < lines.length;
      index += direction
    ) {
      const line = lines[index]!;
      if (line.trim().length === 0) continue;
      const candidateIndent = indentation(line);
      if (candidateIndent < surfaceIndent) break;
      if (candidateIndent === surfaceIndent && TASK_SURFACE_ROLE.test(line))
        break;
      if (candidateIndent === surfaceIndent && !TASK_NARRATIVE_ROLE.test(line))
        break;
      if (candidateIndent !== surfaceIndent || !TASK_NARRATIVE_ROLE.test(line))
        continue;
      retained.add(index);
      narrativeCount += 1;
      if (narrativeCount >= MAX_ADJACENT_NARRATIVE_LINES) break;
    }
  }
}

function indentation(line: string): number {
  return line.length - line.trimStart().length;
}
