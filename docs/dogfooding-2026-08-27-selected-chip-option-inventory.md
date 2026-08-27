# Selected-chip option inventory dogfooding

Release contract: Stage5 Browser 0.15.16, MCP host behavior 4, worker protocol 12, tool catalog 13, 54 tools. This is a compatible worker update and grants no browser or account authority.

## Passive report and telemetry

After adopting 0.15.15, Finance received fresh controlling-thread authority for passive state reconciliation only. Status operation `a73c0b2d-dc1a-42ad-bb3f-ff63a8a8a206` proved the 0.15.15 runtime contract, and supported orphan reattachment preserved the intended pages. Form summary `c0721c40-7c6d-4a2e-91ad-ba5244b49cf5` and semantic snapshot `f55c9ce9-7449-405e-8257-c47264b256d2` were read-only; the snapshot exposed three rendered selected chips in the field. Fresh passive control inspection `9a6e3a30-65fa-4b74-a4a1-1da2acc9814f` associated one exact popup but returned `multiple:false` and eight `selected:null` options.

The durable traces corroborate the form and snapshot as read-only observations and the inspection as zero completed dispatch attempts. Finance made no correction, selection, save, continuation, submission, navigation, tab change, or private entry.

## Root cause

Release 0.15.15 correctly unified option-row and descendant state, but this widget stores current selection only as chips in the containing field. The existing reconciliation manager already treated a new exact field-local representation as authoritative after input, yet inspection did not inventory representations that existed before input. That split source of truth hid current state and could invite an unnecessary toggle.

## Generic repair

Inspection and reconciliation now use the same exact field-representation evaluator. During custom-control inspection it evaluates every unique observed option name in one browser pass, inside the adaptively isolated field scope, while excluding the owned popup and competing fields. Positive exact representations map back to their options; absence alone remains unknown. More than one mapped option is authoritative multi-select evidence.

The representation scope is retained with the one-use inspection capability. If a caller asks to select an already represented option, the action manager revalidates that exact representation in its observe phase and finishes with zero dispatch attempts. Duplicate option names are not mapped, unrelated same-text fields are excluded, CSS appearance is never evidence, and a field representation that conflicts with explicit option state produces `control_option_state_conflict` before input.

This removes repeated per-option DOM scans and another framework assumption without weakening exact targeting, phase ownership, or no-replay behavior.

## Regression boundary

`tests/browser-controller/core/control-option-state.test.ts` now proves that:

1. several pre-existing chips map to exact stateless options in one passive inspection;
2. multiple mapped options classify the widget as multi-select without ARIA help;
3. unrelated same-text content across a competing field does not map;
4. reselecting a represented option runs through action phases with zero dispatch attempts;
5. contradictory explicit and field-representation state fails before input.

The existing option-state, representation, control, form, capability-rebind, action-phase, telemetry, and runtime-contract suites remain the adjacent gate.

## Safe adoption

At an existing safe boundary, keep the MCP host connected and call `browser_status`. Require worker/current 0.15.16, host behavior 4, protocol 12, catalog 13, 54 tools, and `restartRequired:false`, then discard every old inspection ID and option capability. Operation `f388d81d-dac7-403d-b12a-3e8d2f6b1fed` still dispatched once and must never be replayed. The passive 0.15.15 observations authorize no correction or later action; resume only from fresh direct authority and current exact state.
