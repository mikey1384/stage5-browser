# Framework popup stabilization dogfooding

Release contract: Stage5 Browser 0.15.14, MCP host behavior 4, worker protocol 12, tool catalog 13, 54 tools. This is a compatible worker update and grants no browser authority.

## Finding

Finance adopted 0.15.13 and followed a fresh inspect-then-select sequence under direct controlling-thread authority. Inspection operation `482f610d-e279-4fa6-a546-a13dfe17a777` succeeded with a complete, already-open popup, spatial ownership, a positioned option-group surface, and no opener input. Selection operation `53fcd559-460e-440a-ada0-eb93d3a777e7` then failed in `observe` with `reason=control_popup_changed`.

Privacy-safe telemetry proved worker 0.15.13/protocol 12, a 206 ms owning action, `dispatchState=not_attempted`, zero dispatch attempts, and `actionDispatched=false`. Coinbase remained frozen. The failed operations are non-retriable.

## Root cause and generic invariant

0.15.13 allowed a popup capability to be repaired, but sampled reassociation only once. A framework can replace an open portal through a short interval in which no replacement surface exists, or retain a hidden old surface while rendering the replacement. Both are ordinary web lifecycle variation, not new user intent.

The `select_option` observe phase now treats popup identity as positional state until the dispatch gate:

- it spends only the existing two-second observation budget and polls passively through a short replacement interval;
- it never clicks, focuses, scrolls, or replays the opener while stabilizing;
- selection association considers rendered surfaces, so a hidden retained surface cannot outrank one uniquely owned rendered replacement;
- one exact current control, one current document, one uniquely associated rendered popup, and one exact option are still required;
- a closed control, missing-at-deadline, ambiguous, unbounded, hidden, or document-replaced state fails before input;
- a successful read-only reposition remains one `target_changed_before_input` recovery with zero completed dispatch attempts.

Failure details now include only the existing privacy-safe association proof, surface proof, rendered-popup count, and categorical ownership record when available.

## Regression evidence

The disposable control fixture now proves both previously uncovered lifecycle shapes:

1. the popup disappears, reappears after 250 ms, and receives exactly one option click with no second opener click;
2. a hidden retained surface coexists with one uniquely owned rendered portal replacement, and only the rendered replacement is eligible;
3. control replacement, immediate popup replacement, selected-representation reconciliation, and categorical recovery telemetry still pass;
4. a genuinely closed popup fails before input and the opener count remains exactly one.

No live account was used to validate the fix.

## Validation

- build, TypeScript checking, and the file-size gate passed; changed production files remain 422 lines or fewer;
- eight focused control, action-phase, telemetry, timeout, and release-metadata files passed 42 tests;
- one complete 78-file headless run passed 272 tests with three intentional native skips. Its only failures were the new closed-popup test's overly specific error-category assertion under a 500 ms loaded-host deadline and an existing form-context shutdown test timing out amid an unrelated Translator package build and severe host contention;
- after changing the closed-popup test to assert its real invariant—zero dispatch plus unchanged opener/option counts—the complete rebinding file passed. After the competing package build exited, the isolated form shutdown boundary passed in 4.7 seconds;
- a later broad rerun was stopped when several unchanged handoff files hit their identical 15/30-second ceilings under a measured host load average near 69. Its exact disposable process tree was terminated normally and the process-free leftover fixture directory was removed. No product timeout or unrelated test timeout was loosened.

## Adoption and safe resume

At an existing safe boundary, keep the MCP connection and call `browser_status`. Require worker/current version 0.15.14, host behavior 4, protocol 12, catalog 13, 54 tools, and `restartRequired:false`; a compatible host may retain its prior loaded package label. Discard every old inspection ID and option capability.

This release notice grants no inspection, selection, save, continuation, submission, funding, trading, navigation, or private-data authority. If the Finance agent's direct controlling-thread authorization remains current and covers the exact non-private field, it may take one fresh inspection, validate the returned current capability, and use that capability once. It must stop on any new ambiguity or possible-dispatch result and must not infer authority from the Lounge.
