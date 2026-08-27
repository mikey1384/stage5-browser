# Native exact-target reattachment settle

Date: 2026-08-27
Release: Stage5 Browser 0.19.7, MCP host behavior 10, worker protocol 15, tool catalog 17, 56 tools.

## Actual-use failure

Twinkle reported that a fresh 0.19.6 host classified its dedicated Chrome profile as startable and already owned, but two `browser_start` calls failed before dispatch with `selected_page_unavailable_after_reattach`. Operations `598397ee-a276-4849-ada7-99578ee6e6d6` and `8b3abbb0-dd1a-4f9f-899d-41aa297f94ab` returned after 286 ms and 53 ms. No pointer, keyboard, navigation, tab selection, or account input occurred, and the tester correctly stopped retrying.

The released traces proved exact 0.19.6 host/worker contracts and zero dispatch, but retained no target-discovery boundary. One privacy-safe read-only local probe was therefore necessary. It found the same proven owned Chrome process, a healthy private loopback endpoint, six live page targets, and the exact opaque selected target still present. No URL, title, target identifier, page content, or account data was returned. This evidence localized the defect to transient CDP/Playwright discovery during attachment rather than browser or page loss.

## Root invariant and correction

Native reattachment used one immediate `context.pages()` inventory and one CDP target-ID read per page. A temporarily incomplete inventory or transient `Target.getTargetInfo` failure was treated as proof that the retained target no longer existed, even though the same target could settle moments later.

The lifecycle manager now gives exact target discovery one read-only settle reserve of at most 750 ms. It repeatedly inventories only live pages and compares only the private retained opaque target identity. It never selects by URL, title, tab order, or similarity; never opens a replacement page while an exact target is recorded; and never emits browser input. If the identity remains unresolved, start still fails closed with `actionDispatched:false` and one safe bounded retry instruction. No historical action is replayed.

## Proprioception

The status result and schema-2 execution trace retain only:

- whether an exact selected target was recorded;
- bounded initial and final page counts;
- whether the exact identity was observed initially and by the end of settling;
- whether a settle wait was attempted and its bounded duration;
- `not_recorded`, `initial_exact`, `settled_exact`, or `unresolved`.

The host parser explicitly excludes target IDs, document IDs, URLs, titles, labels, endpoint details, process IDs, page content, and private values. Because this is a new host-owned durable trace conclusion, MCP host behavior changes from 9 to 10. The repository guide now also requires that any future ad-hoc diagnostic probe caused by missing released telemetry be replaced by the smallest privacy-safe categorical observation and regressions in the same fix.

## Regression boundary

- `tests/browser-controller/handoff/reattachment.test.ts` makes the first exact CDP target query fail and the second succeed against the same page, proving `settled_exact` without fallback or input.
- `tests/execution-telemetry-native-reattach.test.ts` proves the failure conclusion retains only the bounded allowlist and removes injected private target data.
- `tests/mcp-native-reattach-telemetry.test.ts` starts a fresh built MCP host and proves the successful settle conclusion survives worker transport and durable journaling without private strings.
- Existing same-process handoff, native worker handoff, supervisor, version, and legacy handoff-telemetry regressions prove the correction does not weaken process continuity, update deferral, or no-replay behavior.

No native foreground test and no live-account action is needed. The Twinkle Chrome process and page remain untouched by validation.

## Final validation

- focused exact-target, reattachment, host telemetry, privacy, same-process handoff, native worker handoff, supervisor, runtime, and version gates passed;
- the final complete serialized headless suite passed in 221.00 seconds: 89 test files passed and 3 skipped; 320 tests passed and 3 skipped;
- production TypeScript remains at most 497 lines and every hand-authored TypeScript file remains below the enforced 1,000-line ceiling;
- public MCP copy remains at 338 words, 94.2% below the recorded legacy baseline;
- native focus-changing tests, native headed handoff smoke, and live-account probes were deliberately excluded.
