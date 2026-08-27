# Timeout phase handoff and late-transition dogfooding

Release contract: Stage5 Browser 0.15.10, MCP host behavior 4, worker protocol 12, tool catalog 13, 54 tools. The host-behavior change requires one MCP reconnect. It grants no browser authority and never authorizes replay.

## Custom-selection hard timeout

A separately authorized single-option selection reached the outer hard deadline. Recovery replaced the worker and preserved the controlled browser process, but the durable execution trace contained no action phases and could report only unknown dispatch. A fresh passive form summary then proved that the intended field remained empty, so the reporting agent correctly stopped without replay.

The failure had two generic causes. Custom selection used a locator-backed baseline representation read before entering the action-phase manager, allowing a stale or stalled read to consume the complete command budget. Completed phase telemetry also traveled only on the normal worker response, which cannot exist when the supervisor terminates a hung worker.

0.15.10 evaluates the baseline against the exact retained control handle for at most 500 ms. An unavailable baseline now returns explicit `actionDispatched:false` before the dispatch gate instead of consuming the hard deadline. If any later phase still hangs, the worker snapshots completed and active phase-manager state during shutdown; the host retains that late response for the exact timed-out request and records possible/dispatched state in the durable trace. An owning phase marked `possibly_dispatched` yields the categorical conclusion `actionDispatched:"unknown"`. No command arguments, labels, URLs, values, selectors, coordinates, or page content cross that boundary.

Regression coverage includes the stalled retained-control fixture, the in-flight action-phase snapshot, supervisor timeout/replacement, privacy-safe trace extraction, and a fresh stdio MCP host querying the terminal trace. Ordinary native and custom selection fixtures continue to prove one dispatch and authoritative effect reconciliation.

Validation evidence:

- affected host/manager gate: 6 files and 29 tests passed in 6.52 seconds;
- affected disposable browser gate: 2 files and 10 tests passed in 11.94 seconds;
- complete serial headless release gate: 72 files passed, 3 intentional native skips; 263 tests passed, 3 skipped, in 172.14 seconds;
- build, TypeScript, and file-size checks passed, with no native focus-changing or live-account test executed.

## Delayed publish transition

A separately authorized publish click dispatched exactly once and spent its complete 15-second postcondition window waiting for the exact publish control to become hidden. The control was still visible at the final check, so Stage5 returned `POSTCONDITION_FAILED` and correctly forbade replay. The reporting agent's immediate fresh passive snapshot then observed a post-publish upsell dialog with the draft controls absent.

This is a late application transition, not evidence of a second-input or timeout-recovery defect. The safe procedure is to keep the original click non-retriable, use a fresh passive observation or authoritative service state to confirm publication, and dismiss the upsell only within the reporting agent's existing user-authorized scope. A late modal is strong transition evidence but is not by itself proof of the durable published record.

## Adoption

Reconnect the MCP host once, rejoin the same stable Lounge identity, call `browser_status`, and require version 0.15.10, host behavior 4, protocol 12, catalog 13, 54 tools, and `restartRequired:false`. Discard all old refs and inspection IDs. Do not replay either historical operation. Any new selection requires a fresh inspection and separate live-action authority.
