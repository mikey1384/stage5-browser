# Framework-replaced control rebind dogfooding

Release contract: Stage5 Browser 0.15.12, MCP host behavior 4, worker protocol 12, tool catalog 13, 54 tools. This is a compatible worker update and grants no browser authority.

## Finding

Finance inspected one exact custom multi-select. Inspection used one trusted reversible opener input, retained a uniquely associated popup, and returned one exact option. The later selection operation failed before dispatch with `reason=control_selection_baseline_unavailable`, `actionDispatched=false`, and no action-phase record.

Privacy-safe telemetry confirmed that the failure belonged to `form_manager`, occurred before element input, and ran on worker 0.15.11. A disposable fixture reproduced the exact boundary: a framework replaced the opener DOM node after inspection while preserving its exact role/name, the same document, and the already-open owned popup. The old retained handle was definitively detached, so its representation baseline returned unavailable.

## Generic invariant

A retained semantic capability may survive framework node replacement only when all of these facts are proven before input:

- the retained control is definitively detached rather than merely slow or unknown;
- one current visible/enabled control has the same exact observed role and accessible name;
- one currently rendered popup is uniquely associated with that current control;
- the current control, popup, field-local representation scope, and pre-dispatch representation baseline are all observed within a bounded read-only phase;
- the intended option is still one exact semantic match inside that popup at final preparation.

Ambiguity, missing state, a stalled retained-handle probe, document replacement, or unavailable popup visibility fails before dispatch. Rebinding never replays the opener.

## Implementation

- Exact control resolution now has one shared source in `src/controller/controls/resolution.ts`.
- `src/controller/controls/selection-baseline.ts` owns bounded baseline acquisition and the one allowed read-only stale-node rebind.
- Custom selection acquires that baseline inside the canonical action engine's `observe` phase, so zero-input failures retain owning-manager telemetry instead of producing an empty action list.
- The action engine can finish an already-satisfied observation through `finalize` with authoritative zero-dispatch evidence.
- Final option preparation still rebinds only one exact semantic option inside the retained popup, and the dispatch gate remains single-attempt/no-replay.

## Regression evidence

Focused fixtures prove:

1. a framework-replaced opener rebinds read-only, then the exact option receives one click and one new field-local chip proves success;
2. an unknown/stalled retained control fails in under the bounded probe with zero input and a failed `select_option` observe-phase trace;
3. a control that already represents the option completes successfully with zero dispatch;
4. open multi-select, cross-field isolation, popup-closure-only, and unknown-visibility behavior remain unchanged.

No live account was used to validate the fix.

## Adoption and safe resume

At the current safe boundary, keep the MCP connection and call `browser_status`. Require `worker.version:0.15.12`, `mcp.currentVersion:0.15.12`, host behavior 4, protocol 12, catalog 13, 54 tools, and `restartRequired:false`. A compatible already-running host may retain its prior loaded `mcp.version`; do not reconnect solely for that label.

Discard all old inspection IDs. Operations `36b04f52-3f09-4ab8-86da-f8fe2509027d` and `3e9fa60b-8000-4499-b9c5-457104b9f221` must not be replayed. This release authorizes no live inspection, option selection, save, continuation, submission, funding, trading, or private entry. A live resume requires fresh direct controlling-thread authority and a new authoritative inspection.
