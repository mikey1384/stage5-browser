# Form fast paths from Finance dogfooding

Date: 2026-08-27
Release contract: Stage5 Browser 0.21.0, MCP host behavior 12, worker protocol 17, tool catalog 19, 56 tools.

## Actual evidence first

Finance reported that ordinary country selection eventually worked as “type United States → Enter,” but Stage5 first spent several calls on popup ownership and a large virtualized option inventory. Privacy-safe traces localized the path:

- control inspection `db4368bc-f5b0-4dfe-b1ca-fb6a76a760d4` ended at `ambiguous_control_popup_after_reveal`;
- exact semantic fill `33b043fe-d195-43e7-8727-f5e6dbf01461` entered the query once;
- option selection `88d95bbe-d3fa-43e0-a1f6-4e39fdcf335b` stopped before dispatch at `ambiguous_control_popup`;
- one exact Enter motion `b9895b64-b872-4d08-9731-e061889119dd` completed the selection.

The State/ZIP plan `2431c9c8-f267-469f-a8a2-21dea2041e39` filled the first field once, then failed the untouched ZIP preflight after the page replaced its DOM node. The trace proved the second step emitted no input. A later screenshot was needed only because summary output exposed presence instead of a verified ordinary selected label. No developer live-account action, native foreground test, credential, address, tax value, document, payment value, or historical replay was used.

## Root invariants

An editable exact combobox is a motion, not an option-inventory problem. The selection manager may use the keyboard fast path only when:

1. the direct control and requested option are exact;
2. the control is one unique enabled, editable, single-select combobox or searchbox;
3. an already-proven exact value returns without input; otherwise the query is entered once;
4. the focused control proves the exact active option through `aria-activedescendant` or focus inside an explicitly linked popup;
5. Enter is pressed once; and
6. selected state, or the exact requested value plus popup closure, is authoritatively observed.

If step 4 fails, the query may already be present, so the operation returns possible input and never presses Enter. If step 6 fails, Enter is never replayed. `aria-activedescendant` also becomes a first-class popup association proof, excluding unrelated rendered lists.

A staged form plan may repair only a pending step. Before each step it compares the retained field with the current DOM identity. A replaced node may rebind once only when the same document and retained original `<form>` element contain one unique exact role/name/kind/input-type/multiplicity match. A whole-form replacement fails closed and requires a fresh summary. Completed, partial, or unknown-dispatch steps never enter this path.

## Agent-visible result

Routine successful actions now omit page/frame lifecycle machinery and low-level event evidence. Selection returns the verified requested label, dispatch conclusion, interaction used, popup state, multiplicity, and one next action. Form plans retain exact completed step IDs and categorical field-resolution evidence because those facts prevent replay. The full privacy-safe canonical result stays in the operation registry and is available explicitly through `browser_operation_status(includeResult=true)`. Failures remain detailed.

Native `<select>` summaries expose `selectedOptionNames` only as a subset of the already exposed bounded option labels. Free-form values remain presence-only. Searchable selection echoes and verifies the exact caller-supplied option name, so confirming an ordinary selection no longer requires a screenshot.

## Proprioception

Execution traces add only categorical allowlisted conclusions:

- `selectionInteraction`;
- active-option proof, query/commit dispatch conclusions, and terminal selection proof; and
- whether form-field rebinding was attempted, how many pending steps rebound, and whether rebinding failed.

Names, values, selectors, URLs, IDs, page content, and arguments remain excluded. `tests/mcp-form-fast-path.test.ts` exercises the built MCP/worker and requires the durable trace to report `searchable_keyboard` and `reboundSteps: 1`.

## Regression and resume contract

Focused coverage includes the exact active-descendant success, already-selected zero-input success, missing-proof zero-Enter stop, unrelated-popup exclusion, React-style sibling replacement, cross-form refusal, one-time ZIP fill, selected native-option labels, compact success delivery with full pull recovery, and telemetry privacy.

Release validation: `npm test` completed once against the final code with 92 test files passed, 3 repository-defined skips, 337 tests passed, and 3 skipped in 215.06 seconds. The run included the built MCP/worker boundary and used only headless disposable fixtures.

Existing agents reconnect the MCP host once, rejoin their stable Lounge identity before any browser operation, and require MCP/worker/current 0.21.0, host 12, protocol 17, catalog 19, 56 tools, and `restartRequired:false`. All earlier form, control, popup, ref, and snapshot capabilities are stale. The release grants no new account authority. A tester may resume only within its own still-current controlling-thread scope, from one fresh form summary or direct exact selection, and must not replay any historical possible input.
