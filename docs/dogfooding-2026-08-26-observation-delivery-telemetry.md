# Observation, delivery, custom-selection, and telemetry — 2026-08-26

Release contract: Stage5 Browser 0.15.0, tool catalog 13, worker protocol 12, MCP-host behavior 1, 54 MCP tools.

## Sanitized dogfooding findings

Two active Lounge workflows exposed generic browser-hand failures without requiring any live-account replay:

1. Passive exact-tab inspection returned a very large whole-document semantic result even though one unique visible modal existed. The decisive modal state survived, but client truncation put it beyond the visible result boundary and briefly produced a false lost-draft inference.
2. Exact custom-option selection could physically open or change a portal-backed control while the generic click postcondition looked only for selected state on the opener. A custom multiselect could also represent success by adding an exact chip while keeping its popup open and omitting `aria-selected`.
3. A bounded internal click failure could be followed by a caller-visible result so large that the operation ID, dispatch evidence, and terminal conclusion were absent from the retained client context. The reporter correctly refused to retry, but could not audit the completed operation.

No Facebook, Coinbase, YouTube, payment, publication, submission, or other live account action was used to reproduce these defects. Disposable localhost fixtures cover the governing browser boundaries.

## Root fixes

- Passive tab inspection now uses the same canonical modal-root resolver as normal semantic snapshots. One unique visible modal becomes the bounded root; ambiguous modals fail back to the document with an explicit warning.
- MCP results are priority ordered and bounded to 24 KiB. Operation identity, outcome, recovery, action dispatch, postcondition, and evidence precede page/frame/snapshot detail. Oversized strings and arrays retain bounded head and tail sections with an explicit omission marker, and the result says that absence inference is forbidden.
- Custom popup preparation no longer asks the opener itself to prove selected state. The form manager associates the one prepared or uniquely rendered popup, then owns option reconciliation.
- Custom option selection observes semantic selected state, exact newly represented control value/chip, and single-select popup closure. A multiselect requires selected or represented evidence; popup closure alone is insufficient. Partial or possible input is observed and never replayed.
- Every terminal supervised browser/recovery operation writes a bounded private `0600` trace keyed by `operationId`. It records the stable Lounge agent ID when bound plus only canonical manager, phase system, dispatch class, replay rule, worker contract, phase timing/attempts when emitted, categorical reconciliation, error code/reason, duration, and outcome. Display names, providers, URLs, selectors, accessible names, values, page content, coordinates, arguments, headers, bodies, queries, fragments, credentials, and private handoff data are structurally omitted.

## Regression boundaries

- a document with hundreds of underlying articles and one composer modal returns compact `scope: "modal"` evidence and excludes underlying content;
- a portal popup that moves focus away from an opener and lacks explicit ownership remains structurally associable after the one opener input;
- a custom multiselect that adds an exact chip without `aria-selected` succeeds once while its popup remains open;
- an oversized result remains at or below 24 KiB while retaining operation ID, action conclusion, postcondition, and both bounded ends of diagnostic text;
- execution traces survive a journal round trip, expose click phases and safe conclusions, and provably omit deliberately planted private URL/title/choice/value strings;
- the real built MCP surface queries both a scroll manager record and a click record with observe/dispatch/reconcile phases.

## Safe migration and resume

0.15.0 changes the MCP tool catalog and worker response protocol. Reconnect each host exactly once without reinstalling the existing registration, rejoin the same Lounge identity, and require version 0.15.0/catalog 13/protocol 12/54 tools with `restartRequired: false`. Leave an exact owned native Chromium-family browser open; adopt only one uniquely proven intended recoverable profile. Then discard all prior refs/capabilities, read status, tabs, durable page events, and a fresh compact semantic snapshot before continuing.

Do not replay an action merely because an older client omitted its tail. Query `browser_operation_status` for the terminal result and `browser_execution_traces` for the Stage5-owned audit record. Possible or confirmed input remains observation-only until authoritative state proves the next safe step.
