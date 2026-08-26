# Composed reach and popup recovery — 2026-08-26

Release: 0.15.3 (compatible worker update; tool catalog 13, worker protocol 12, 54 tools)

## Live evidence

- YouTube operation `122d065f-a6a6-4722-abbb-ce901186a37b` on worker 0.15.2 spent 1,322 ms in preparation and failed before dispatch with `target_not_actionable_in_viewport`. The 0.15.2 fixture covered only vertical clipping. The shared motor planner ignored horizontal scroll capacity and could not cross assigned-slot/shadow-root ancestry to the actual scroll surface.
- Finance operation `e4b5c320-7ce1-481f-bec6-5a025b56f8ad` on worker 0.15.2 entered the control reveal dispatch gate once, observed trusted partial pointer input, and failed with `actionDispatched=true`, `clickDispatched=false`. The caller correctly stopped. `inspectControl(revealOptions=true)` had invoked the generic click path with no popup-effect reconciliation, while the popup preparation layer could let a merely focused/expanded target claim a popup that had a different structural owner.

No live account action was used to reproduce either generic defect.

## Root fixes

1. Exact-ref viewport preparation is two-dimensional. It can move horizontal, vertical, or both axes in one bounded step; follows assigned slots and shadow hosts; intersects a candidate surface with upstream overflow clipping; retains the exact node; and re-observes canonical actionability after every step.
2. The action result and execution telemetry expose only categorical proprioception: attempts, movement count, horizontal/vertical movement, nested/document surface class, composed-boundary traversal, and final in-viewport state. Coordinates, selectors, names, URLs, and page content remain absent.
3. Popup ownership has one shared source of truth. Explicit/structural association wins; otherwise one focused owner wins; otherwise one expanded owner wins. Ambiguity dispatches nothing.
4. Control reveal is a dedicated action phase with one dispatch gate and one associated-popup effect check. A pointer-down or mouse-down that opens the exact popup and replaces the opener reconciles as success with its original partial evidence. It is never replayed.
5. Inspection observes an already-open exact target popup before considering competing-popup preparation. `revealOptions=false` performs no opener or dismissal input, allowing a frozen multi-popup state to be inspected only when ownership is uniquely proven.

## Regression boundaries

- vertically clipped modal action;
- horizontally clipped responsive modal action;
- slotted target whose scroll surface lies across a composed-tree boundary;
- stale expanded/focused target beside another control's structurally owned popup;
- partial mouse-down opener that reveals a popup and replaces itself;
- two simultaneously open, structurally distinct popups inspected with zero input;
- existing native, portal, single-select, multi-select, partial-option, virtualization, exact-hit, no-replay, phase-manager, MCP shaping, and privacy-safe telemetry behavior.

## Safe dogfood resume

- Adopt worker 0.15.3 only at an existing safe boundary and require `restartRequired=false`; discard all prior refs and inspection IDs.
- YouTube's prior operation proved zero dispatch. One fresh exact modal observation may support one new attempt inside the same still-authorized dismissal scope.
- Finance's opener had possible input and must never be retried. Preserve the current page. First use `browser_inspect_control` with `revealOptions=false`; continue only if it passively associates the intended popup and reports no preparation/opener input. Do not correct a selection, close a popup, save, continue, submit, fund, trade, or enter private data without a separately valid next action.
- An agent identity or Stage5 profile never proves which human or external account is authorized. Verify the intended user/account/organization before any account-scoped mutation, and never use another person's open console as inherited authority.
