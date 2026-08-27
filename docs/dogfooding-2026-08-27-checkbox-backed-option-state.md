# Checkbox-backed option-state dogfooding

Release contract: Stage5 Browser 0.15.15, MCP host behavior 4, worker protocol 12, tool catalog 13, 54 tools. This is a compatible worker update and grants no browser or account authority.

## Report and telemetry

Finance adopted 0.15.14 and used one freshly inspected exact custom option under its existing user-authorized scope. Operation `f388d81d-dac7-403d-b12a-3e8d2f6b1fed` dispatched one click, then spent 19,159 ms in reconciliation before returning `control_option_selection_not_observed`. Its durable trace `e42ef05b-1adf-4e23-8a7d-739f8555b31a` recorded one dispatch, no replay, no selected representation, unknown selected state, and a popup that remained open. The preceding control inspection classified the widget as `multiple:false` and the exact option as `selected:null`.

No live follow-up observation or input was performed. Because the trusted click may have changed the site, the historical operation remains non-retriable.

## Root cause

The control inspector and selection reconciler recognized state only when the option row itself exposed native or ARIA selection attributes. Some component systems expose an accessible `role=option` row while storing the authoritative toggle in a nested native checkbox or explicit framework state carrier. The popup intentionally remaining open is normal multi-select behavior, not evidence of failure.

That created two coupled errors:

- inspection missed the nested checkbox and misclassified the control as single-select;
- reconciliation queried the generic clicked-node state reader, which inspected ancestors but not state-bearing descendants.

## Generic repair

One browser-evaluable option-state source of truth now serves both inspection and post-dispatch reconciliation. It examines the exact option plus a bounded set of descendants for explicit native, ARIA, and common framework state channels. A checkbox channel also marks the option surface as multi-select. Conflicting explicit state remains unknown.

The evaluator deliberately ignores CSS class names, focus, hover, visual styling, and popup closure. It therefore expands ordinary widget compatibility without weakening target identity, user authority, or no-replay semantics. An already-selected option is returned as satisfied without dispatch; an unchecked option receives at most one normal selection input and must then expose authoritative checked/selected state or a new field-local representation.

## Regression boundary

`tests/browser-controller/core/control-option-state.test.ts` proves that:

1. a nested unchecked checkbox makes a `role=option` surface multi-select and reconciles one click while the popup stays open;
2. a nested checked checkbox prevents a destructive second toggle;
3. explicit framework checked/unchecked state is accepted, while appearance-only `selected`, `checked`, or `active` classes remain non-authoritative.

The existing control-option, open-popup representation, framework rebind, timeout, form-workflow, phase-manager, and telemetry suites remain the adjacent invariant gate.

## Safe adoption

At an existing safe boundary, keep the MCP host connected and call `browser_status`. Require worker/current version 0.15.15, host behavior 4, protocol 12, catalog 13, 54 tools, and `restartRequired:false`, then discard every old inspection ID and option capability. Never replay operation `f388d81d-dac7-403d-b12a-3e8d2f6b1fed`. Any passive state verification or later account action still requires fresh authority from the controlling user thread.
