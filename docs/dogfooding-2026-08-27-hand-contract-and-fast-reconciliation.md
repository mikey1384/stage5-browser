# Hand contract and fast reconciliation

Date: 2026-08-27

Release: Stage5 Browser 0.20.0, MCP host behavior 11, worker protocol 16, tool catalog 18, 56 tools.

## Actual-use evidence first

Finance operation `92fbb2b7-ebea-4f90-b932-024766a9ef41` dispatched its exact option click after 91 ms, then spent 14,301 ms in reconciliation and failed after 14,531 ms even though the site had applied the selection. The custom React field replaced its old control, retained the selected representation elsewhere in the same field, and intentionally left the multi-select popup open. A later fresh operation succeeded in 117 ms and correctly reported `popupOpen: true`, confirming that physical input was not the expensive boundary.

The unfiltered trace read used during investigation produced 47,292 bytes before the generic MCP envelope reduced it to 24,576 bytes. Repeated full semantic snapshots, screenshots, and Lounge status bodies compounded that delivery cost. No live account action, native focus change, or historical input replay was used to investigate or validate the generic failure.

Twinkle operation `a973e6fe-c081-4850-82b8-c55b8519dfe1` independently failed a passive snapshot after 1,357 ms with `WORKER_DISCONNECTED/runtime_artifact_changed` while a compatible 0.19.7 artifact was rebuilt. The supervisor had correctly deferred worker replacement to preserve the connected page, but the old worker's own artifact monitor treated the diagnostic fingerprint change as an incompatible contract. This was a control-plane contradiction, not a page or site failure.

The earlier Twinkle start failure is operation `96c6bc82-334a-44d6-982f-080ebd2b8cad`. Its v0.19.7 trace retained only `profile_locked`; it did not retain the categorical lease/owner proof that made automatic recovery unavailable. The process was not terminated by Stage5, which was the correct fail-closed boundary without proven launch identity. Release 0.20.0 adds the missing ownership conclusion so the next incident can be diagnosed without a process ID, path, executable name, application name, window title, or command line.

## Product contract

Stage5 Browser is the agent's browser-control hand. Current user authorization and the calling model/provider govern whether a known value may be entered. Stage5 does not infer a second semantic policy from a field type or value meaning. Exact role fills where the page exposes the requested role, plus staged form plans for all observed editor kinds, can therefore fill password-shaped and other semantically private inputs when upstream-authorized. Optional private handoff remains available for caller-selected human-only input, unavailable values, passkeys, CAPTCHAs, identity capture, and similar interactions.

This removes only semantic policing. Values remain structurally excluded from observations, results, error details, telemetry, durable context, work notes, and Lounge messages. Snapshot refs still omit raw password editors because the browser's accessibility snapshot can expose current values; exact role/form capabilities provide input without turning that unsafe observation into a requirement.

## Generic corrections

- Custom selection reconciliation now observes from the retained field owner even when the old React control disconnects. If the field itself changed, it may perform one exact read-only control/popup/option rebind. It never dispatches a second input.
- Reconciliation has its own 1,500 ms evidence budget instead of consuming an arbitrary remaining action deadline. Terminal evidence records attempts, duration, target resolution, and one categorical proof: selected state, representation change, popup closure, or unresolved.
- A successful selection leads with `selectionSucceeded`, dispatch state, `popupOpen`, multi-select state, and compact viable next motions. An intentionally open menu is no longer described as a failed selection.
- `browser_snapshot` defaults to a structurally task-focused action view, preserves nearby instructions and control/option descriptions, and reports exactly how many semantic lines were omitted. `view: "full"` remains explicit and authoritative when reading page content is the task.
- `browser_execution_traces` defaults to a compact phase-duration summary and filters by operation, stable Lounge agent, worker command, and outcome. Full phase transitions are pull-only.
- Lifecycle traces retain a strict categorical profile-ownership conclusion: classification, ownership proof, worker liveness, heartbeat, browser-process match, control mode, and phase. Identifying process and application data remain omitted.
- `lounge_status` defaults to compact membership, notice metadata, and the caller's work note. `detail: "full"` preserves manager access to sent-message delivery and all current member notes. Unchanged `lounge_wait` results no longer repeat the pinned notice body.
- Native select mechanics were extracted from the custom-selection coordinator. Production TypeScript remains at or below 500 lines, with one owner per behavior.
- A running worker now distinguishes diagnostic artifact identity from its worker protocol contract. Fingerprint-only rebuilds remain usable until the supervisor's next safe replacement boundary; a real protocol change still disconnects before the next command.

## Regression boundary

Disposable tests prove:

- one React-style replacement selection succeeds in under 2.5 seconds with one dispatch while the multi-select remains open;
- the selected representation is isolated to the exact retained field and popup closure alone cannot satisfy a multi-select;
- exact staged form work can fill an upstream-authorized password-shaped value while every result remains value-free;
- categorical reconciliation telemetry persists and rejects adjacent private strings;
- a profile-lock failure retains only categorical ownership facts and rejects adjacent process, path, and application identity;
- trace and Lounge compact defaults retain recovery facts while full views remain explicit;
- task snapshots retain actionable roles, structural ancestors, and bounded nearby instructions/descriptions while reporting omitted content;
- unchanged Lounge waits do not resend pinned prose;
- a connected worker accepts a fingerprint-only rebuild but rejects a changed worker protocol contract.

Focused changed-boundary acceptance passed 20 files and 66 tests before the final module split; the final snapshot/selection boundary then passed 15 tests across 3 files. After compact snapshots were hardened to discard omitted ref capabilities, that boundary passed 6 tests across 4 files. The definitive serialized release gate passed build, typecheck, file-size enforcement, 90 test files and 328 tests, with 3 platform/native-smoke files and 3 tests skipped, in 209.94 seconds. Production TypeScript is at most 500 lines and every hand-authored TypeScript/JavaScript file remains below 1,000 lines.

The disposable untracked Coinbase scratch report is intentionally not retained. Its three critical failures, six misleading states, and requested capability families are mapped to governing owners and regressions in `docs/action-system-acceptance-2026-08-26.md`; this release record adds the later reconciliation, context-cost, and semantic-policy findings. The tracked historical 0.6.6 release note remains only as release history.

## Safe resume

Every existing host reconnects once, rejoins `stage5-lounge` as its stable identity, and requires MCP/worker/current `0.20.0`, host behavior `11`, protocol `16`, catalog `18`, 56 tools, and `restartRequired:false`. Discard every pre-reconnect snapshot, ref, inspection, form, tab, and popup-owner capability. Do not replay operation `92fbb2b7-ebea-4f90-b932-024766a9ef41` or any other historical possible input. Resume only from a fresh task snapshot, form summary, or exact control inspection within the controlling user's existing authority.
