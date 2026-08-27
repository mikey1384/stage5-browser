import { describe, expect, it } from "vitest";

import {
  compactTaskSnapshot,
  discardOmittedSnapshotCapabilities,
} from "../src/controller/observation/snapshot-view.js";

describe("task-focused semantic snapshot view", () => {
  it("keeps structural ancestors and actionable surfaces while reporting omitted content", () => {
    const viewed = compactTaskSnapshot(`- document:
  - generic [ref=e1]:
    - heading "Business application" [level=1] [ref=e2]
    - article [ref=e3]:
      - paragraph [ref=e4]: Long unrelated marketing copy
    - form [ref=e5]:
      - paragraph [ref=e9]: Use the legal address held by the company
      - textbox "Business address" [ref=e6]
        - description: This field accepts the registered street address
      - button "Continue" [ref=e7]
    - status [ref=e8]: Saved`);

    expect(viewed.snapshot).toContain('heading "Business application"');
    expect(viewed.snapshot).toContain("form [ref=e5]");
    expect(viewed.snapshot).toContain('textbox "Business address"');
    expect(viewed.snapshot).toContain(
      "Use the legal address held by the company",
    );
    expect(viewed.snapshot).toContain(
      "This field accepts the registered street address",
    );
    expect(viewed.snapshot).toContain('button "Continue"');
    expect(viewed.snapshot).toContain("status [ref=e8]");
    expect(viewed.snapshot).not.toContain("Long unrelated marketing copy");
    expect(viewed.omittedLineCount).toBeGreaterThan(0);
  });

  it("returns the complete observation when no structural task surface is present", () => {
    const snapshot = "- document:\n  - paragraph: Read-only article";
    expect(compactTaskSnapshot(snapshot)).toEqual({
      snapshot,
      omittedLineCount: 0,
    });
  });

  it("disposes capabilities whose refs were omitted from the selected view", async () => {
    const retained = { handle: { dispose: async () => undefined } };
    let omittedDisposed = false;
    const omitted = {
      handle: {
        dispose: async () => {
          omittedDisposed = true;
        },
      },
    };
    const capabilities = new Map([
      ["kept-ref", retained],
      ["omitted-ref", omitted],
    ]);

    await discardOmittedSnapshotCapabilities(
      capabilities,
      new Set(["kept-ref"]),
    );

    expect([...capabilities.keys()]).toEqual(["kept-ref"]);
    expect(omittedDisposed).toBe(true);
  });
});
