# Positioned popup and exact hit-test evidence

Release contract: Stage5 Browser 0.15.5, MCP host behavior 2, tool catalog 13, worker protocol 12, 54 tools.

This is a privacy-safe engineering record. The live reporting pages were not mutated during investigation. No account identifier, URL, label, option text, draft, form value, coordinate, credential, financial value, or page content was copied into fixtures, telemetry, or this document.

## Observed boundaries

Two independent dogfood reports exposed generic gaps:

1. A passive custom-control inspection preserved two already-open option surfaces but returned no associated popup because the portals had option roles without a semantic listbox/menu/tree root. Replaying either opener was forbidden because earlier input could already have changed the page.
2. An exact visible link was rejected before dispatch because a small `overflow:hidden` ancestor was treated as a containing clip even though the positioned target painted outside it and the browser could hit the target directly. Every reported attempt retained zero dispatch evidence.

These were controller-model defects, not requests for site adapters. The fixes therefore extend the hand's position and proprioception rather than matching a site, label, or URL.

## Generic remedy

`src/controller/controls/popup-surfaces.ts` is the single bounded popup-surface discovery owner. It enumerates semantic list/menu/tree surfaces first. A role-free group is admitted only when rendered option descendants lead to a positioned, popover, or dialog overlay boundary; the innermost real scroll surface is retained when present. Discovery is capped by surface, option, and ancestry limits. Ownership stays in the canonical resolver and proceeds through explicit/structural, focused, expanded, and unique spatial evidence. Equal candidates or incomplete discovery fail before input.

`src/page-diagnostics/target-state.ts` is the single exact-target geometry owner for actionability and hit-point selection. It begins with the conservative element/viewport/overflow intersection. When that CSS ancestry inference collapses or disagrees, it samples a fixed bounded grid inside at most twenty of the target's own viewport-clipped client rectangles. Only `document.elementFromPoint` returning the exact target or its proven composed-tree descendant can establish `exact_hit_test_override`; a sibling, ancestor, cover, or unrelated overlay remains blocked. The synchronous pre-input guard uses the same evaluator, so preparation and dispatch cannot disagree.

`src/execution-telemetry.ts` retains the resulting categorical proprioception through an explicit allowlist:

- target visible/enabled/in-viewport state;
- `clipped_geometry`, `exact_hit_test_override`, or `none` viewport evidence;
- pointer reception and center/alternate hit class;
- popup association proof, surface proof, and bounded rendered-surface count;
- existing reach, dispatch, reconciliation, timing, and terminal facts.

It never stores names, selectors, roles that identify page content, URLs, values, options, text, geometry, coordinates, command arguments, or private data. Telemetry I/O remains best-effort and cannot replace the canonical browser result.

## No-replay and adoption boundary

The popup fix can inspect a proven already-open surface without closing, reopening, selecting, or otherwise changing it. Discovery or ownership ambiguity stays zero-input. The exact-hit fix changes only pre-dispatch actionability proof; it does not turn a non-target hit into permission and does not add a second transport after input.

Because trace extraction runs in the long-lived MCP process, 0.15.5 increments host behavior from 1 to 2. Every agent reconnects the MCP host once, rejoins its same stable Lounge identity, verifies version 0.15.5/host behavior 2/catalog 13/protocol 12/54 tools with `restartRequired: false`, and discards all old refs and inspection IDs. A frozen partial-input popup page receives only the separately authorized passive inspection. A zero-dispatch exact-link report may receive one fresh exact attempt only after current authorized state and a bounded postcondition are re-observed.

## Regression and release evidence

- Generic positioned two-portal association and equal-anchor failure: `tests/browser-controller/core/control-reveal-recovery.test.ts`.
- Exact target painted outside a falsely inferred clip, plus covered/slotted/offscreen protections: `tests/browser-controller-hit-point.test.ts`.
- Categorical trace extraction and privacy exclusion: `tests/execution-telemetry.test.ts`.
- Exact ref capability ownership remains split into `src/controller/input/reference-capabilities.ts`; production TypeScript remains at or below 497 lines and every hand-authored TypeScript file remains below the 1,000-line hard ceiling.
- Focused release-candidate validation passed 6 files and 24 tests, including the complete click transaction and popup/telemetry boundaries.
- Complete headless release gate: `npm test` passed build, typecheck, file-size enforcement, 71 test files, and 254 tests in 172.13 seconds; 3 native-boundary files/tests remained intentionally skipped (74 files and 257 tests total).
- Native focus-changing and live-account tests are deliberately excluded; neither boundary is needed to prove these generic fixes.
