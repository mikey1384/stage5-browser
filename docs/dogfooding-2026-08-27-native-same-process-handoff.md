# Native same-process private handoff

Date: 2026-08-27
Release: Stage5 Browser 0.19.6, MCP host behavior 9, worker protocol 15, tool catalog 17, 56 tools.

## Actual-use failure

Finance requested an authorized private-input handoff from its preserved Stage5 Brave profile. Three operations ended after roughly 29.5 seconds with `handoff_release_pending`, `phase=close_requested`, `closeRequestCompleted=true`, and retained ownership. A fresh status showed `releasing_control`, no attached page, and no human bootstrap. No private value was sent and no account action was retried.

Finance later reported that the form was empty after the private step. Its canonical status recorded `compatible_worker_replaced`, `allReferencesInvalid=true`, `pageStatePreserved=false`, and `browser_stopped`. That transition is sufficient proof that Stage5 did not preserve the browser page boundary; it must not be dismissed as ordinary site behavior or retried on the live form.

Privacy-safe live evidence proved that the cached browser PID still matched its start identity, still owned all Chromium singleton locks, and still exposed the exact Stage5 loopback endpoint. The durable native-control record was `controlled`, matched that PID, and retained the exact selected target and document. The process was not stuck exiting: it was a healthy native-CDP browser whose Playwright connection had closed.

## Root invariant and correction

The old release path treated every controlled browser like a direct Playwright launch: close the context, wait for the exact process to exit, wait for profile unlock, then launch a native browser. That is correct for a direct Playwright process and for Firefox, but wrong after compatible worker adoption has already converted Chromium to a verified native-CDP process.

The handoff manager now chooses one explicit release strategy:

- `process_relaunch`: preserve the existing close → exact process exit → profile unlock gate;
- `native_same_process`: prove the current control record, singleton owner, executable identity, loopback endpoint, selected target, and document; add an exact Stage5 marker; detach only the automation connection; change the durable record to `awaiting_user`; and retain the same process, profile, tabs, and unsaved DOM.

Both strategies converge on one canonical human-handoff state. A worker replacement can recover either side of the two-file record/lease transition only with the same exact process plus marker evidence. The supervisor also derives update eligibility from the durable ownership lease: `close_requested`, `process_exited`, `profile_unlocked`, `human_input`, or `human_handoff` freezes a compatible update even when its in-memory browser-connected bit is false. It never guesses another target, kills a process, deletes a lock, relaunches the page, or replays input.

## Proprioception

Authentication status and schema-2 execution traces now retain only:

- release strategy and phase;
- whether control detachment completed;
- whether the browser process was reused;
- whether ownership remained retained.

URLs, labels, target IDs, document IDs, endpoint ports, field values, and page content remain excluded. This host-owned allowlist changes MCP host behavior from 8 to 9.

## Regression boundary

`tests/browser-controller/handoff/native-same-process.test.ts` uses a disposable headless Chromium endpoint and proves all of the following in one flow: adoption of the exact pre-fix `native_cdp/close_requested` orphan, private handoff without a launcher call, process continuity, marker presence, selected-target continuity, unsaved textarea preservation, recovery across the record/lease crash window, and exact same-process resume.

`tests/supervisor.test.ts` reproduces the second failure boundary directly: the host believes the browser is stopped, a compatible build appears, and the durable lease remains `native_cdp/close_requested`. The worker PID and loaded fingerprint must remain unchanged and no runtime transition may be emitted.

`tests/mcp-native-private-handoff.test.ts` starts a fresh built MCP host with a disposable worker and proves the host trace contains the categorical handoff facts and none of the injected private strings. Existing durable-recovery, worker-handoff, request/resume, execution-telemetry, version, and supervisor tests remain part of the focused gate.

No native foreground test and no live account action is needed. The preserved Finance Brave process remains untouched until Finance reconnects the released host and follows the coordinator's safe resume sequence.

## Final validation

- build, TypeScript, file-size, diff-whitespace, version-alignment, lifecycle, request/resume, durable recovery, worker handoff, host trace, telemetry privacy, and MCP copy-budget gates passed;
- the final complete serialized headless suite passed in 221.41 seconds: 87 test files passed, 3 skipped; 317 tests passed, 3 skipped;
- production TypeScript is at most 497 lines and every hand-authored TypeScript file remains below the enforced 1,000-line ceiling;
- public MCP copy remains under the existing 10%-of-legacy budget;
- native focus-changing tests, native headed handoff smoke, and live-account probes were deliberately excluded.
