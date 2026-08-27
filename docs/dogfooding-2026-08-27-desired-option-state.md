# Desired option-state dogfooding

Release contract: Stage5 Browser 0.16.0, MCP host behavior 5, worker protocol 13, tool catalog 14, 54 tools. The public option schema, worker command contract, and retained telemetry contract changed, so every MCP host must reconnect once. This release grants no browser or account authority.

## Reported boundary

A fresh passive inspection on 0.15.16 still reported a custom control as `multiple:false` with every option state unknown, although the same bounded semantic observation showed several selected chips. Sanitized fixture facts established the missing generic shape:

- each selected representation was a generic rendered node whose short label was a strict prefix of one longer option name;
- the chips and opener belonged to one local form-item group, but an internal textbox with the same accessible name as the opener sat between them;
- no removal affordance or separate action ref was exposed;
- the popup intentionally remained open because the control supported multiple choices.

The first 0.15.16 field boundary stopped at any competing field, so it could not cross the same-named textbox belonging to the composite widget. Even after recognizing the selected state, the public hand could only ensure an option was selected; it had no exact inverse motion.

## Generic correction

Inspection keeps its narrow field scope first. Only when that scope maps no options may it climb through competing fields, and only while every competing field has the same structural accessible name as the inspected opener. The representation inventory then maps an exact chip name or a strict short-prefix name only when it identifies one unique observed option. Ambiguous prefixes, unrelated fields, explicit-state conflicts, and absent evidence remain unknown. No business vocabulary, site name, or fuzzy semantic heuristic is used.

`browser_select_option` now accepts `selected:boolean`, defaulting to `true`. The same form manager and action phases therefore expose one composable desired-state primitive instead of a second site-shaped removal API:

- a choice already in the requested state completes through the phase manager with zero input;
- `selected:false` requires fresh authoritative `selected:true` evidence and independently toggleable multi-select semantics;
- unknown toggle state stops before input;
- native multi-select deselection preserves every peer selection;
- custom deselection dispatches once and requires explicit unselected state or disappearance of the exact retained field representation;
- popup closure never proves multi-select selection or deselection;
- possible input is never replayed.

Durable execution traces now retain only the boolean desired and observed option states in addition to the existing manager, phases, dispatch count, reconciliation checks, and outcome. Option names, field labels, URLs, selectors, values, and page content remain omitted. This additive retained field moves the host behavior contract to 5.

## Regression evidence

Disposable local fixtures cover:

- same-named composite fields with an intervening textbox;
- unique short-chip to longer-option mapping;
- framework replacement of the opener and popup retaining the same adaptive selected-chip evidence with zero input;
- ambiguous prefixes and unrelated fields remaining unknown;
- already-selected zero-dispatch behavior;
- exactly-once custom deselection proved by chip disappearance while the popup stays open;
- explicit checkbox-backed deselection;
- unknown-state deselection stopping before dispatch;
- native multi-select deselection preserving the other selected option;
- privacy-safe desired/observed direction in durable telemetry.

No live account, native focus-changing operation, submission, funding, trading, or private data was used for reproduction or validation.

Release validation completed with the file-size gate and TypeScript build passing, 53 focused control/protocol/telemetry tests passing, and the complete headless gate passing 280 tests with three intentional native-only skips across 79 test files.

## Safe adoption

Reconnect the MCP host once, rejoin its same stable Lounge identity, and call `browser_status`. Require MCP/worker/current version 0.16.0, host behavior 5, protocol 13, catalog 14, 54 tools, and `restartRequired:false`. Discard every old inspection, option, tab, and snapshot capability.

Historical operations remain non-retriable. A release notice or Lounge message does not authorize passive inspection, correction, form continuation, submission, or any account action. Any live resume requires direct controlling-thread authority that still covers the exact remaining action and a new exact inspection; a valid standing scope need not be re-granted solely because a zero-dispatch defect intervened. Deselect only an option reported `selected:true`; stop on null or conflicting state.
