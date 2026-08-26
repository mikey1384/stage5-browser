# Popup partition and bounded all-hidden proof

Release contract: Stage5 Browser 0.15.6, MCP host behavior 2, tool catalog 13, worker protocol 12, 54 tools. This is a compatible worker update; the 0.15.5 MCP host stays connected.

This record contains only generic controller facts and disposable fixtures. No live account value, URL, option meaning, form value, draft, page content, coordinate, credential, payment/tax value, or private data is retained.

## Canonical dogfood evidence

A passive control inspection on 0.15.5 failed in 419 ms with `ambiguous_control_popup`, `renderedPopupCount=1`, no action phases, and `actionDispatched=false`. The reporting agent preserved the exact native browser, page, and existing popup state and did not retry.

A separate snapshot-ref expansion click dispatched exactly once on 0.15.5. Its trace recorded one dispatch attempt followed by the full bounded reconciliation window; `expectedHidden` remained unknown. The next fresh authoritative observation showed that the intended expansion effect had occurred, so the agent correctly continued from the observed state without replaying the click.

## Root classes and positional remedies

One positioned portal may be only a transport/layout wrapper around several logical option groups. `src/controller/controls/popup-surfaces.ts` now partitions a strict DOM option branch only when bounded rendered geometry proves a real gap from every outside option under that portal. The outermost rendered strict branch is retained, or its inner real scroll surface when available. Contiguous per-option wrappers remain one popup, preventing a normal list from becoming several false surfaces. Semantic popup roles still take precedence, and ambiguous ownership remains zero-input.

An exact hidden postcondition asks whether the named semantic surface is visible, not whether its DOM representation is unique. `src/controller/input/postconditions.ts` now evaluates at most fifty exact `includeHidden` matches. Zero matches or every bounded match hidden yields `observed:false`; any visible match yields `observed:true`; a larger set, missing frame, or observation failure remains `observed:null`. Only booleans/null reach results and telemetry. This proves an effect boundary, never a persisted value or later submission.

## Regression and adoption gate

- Shared broad portal with two separated logical branches: `tests/browser-controller/core/control-reveal-recovery.test.ts`.
- Contiguous wrapped options remain one surface and equal owner anchors still fail closed in the same file.
- One visible trigger plus a semantically identical hidden duplicate becomes all-hidden after one ref click: `tests/browser-controller/click/postconditions.test.ts`.
- Multiple visible exact matches still fail the hidden postcondition: `tests/browser-controller/click/role-activation.test.ts`.
- Focused regression gate: 3 files and 14 tests passed before the contiguous-wrapper adversarial case; the final popup file then passed all 6 cases.
- Complete headless release gate: `npm test` passed build, typecheck, file-size enforcement, 71 test files, and 257 tests in 173.35 seconds; 3 native-boundary files/tests remained intentionally skipped (74 files and 260 tests total).

At a safe boundary, an existing 0.15.5 host calls `browser_status` once and requires worker 0.15.6 with host behavior 2/protocol 12/catalog 13/54 tools and `restartRequired:false`, then discards old refs and inspection IDs. The passive popup report may receive one new read-only `revealOptions=false` inspection only after explicit coordinator release. The already-successful expansion click is never replayed; the fix is validated on a fresh disposable fixture or a future independently authorized state transition.
