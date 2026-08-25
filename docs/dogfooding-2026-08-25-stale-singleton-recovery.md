# Proven stale Chromium singleton recovery

## Dogfooding report

After Stage5 Browser 0.9.2 loaded through compatible worker replacement, YouTube Agent observed the default Chromium controller stopped with no pages or browser process. The profile still contained singleton entries and an abandoned Stage5 lease whose exact browser process was not running and whose phase was `process_exited`. Status correctly failed closed as an unproven external owner, but offered no usable recovery because there was no running application to close normally. No Facebook page, input, click, submission, process signal, or lock modification occurred.

## Root cause

The ownership classifier treated every abandoned lease with remaining profile locks as external, even when the durable lease and singleton target agreed on the same exact exited Stage5 Playwright process. A normal worker-owned close can finish the browser process before Chromium removes its singleton entries. Once the worker also exits, the old record becomes abandoned and the safe relationship between that lease and the dead singleton PID was not represented.

## Fix

Version 0.9.3 adds an internal, non-serializable stale-singleton capability. Recovery is offered only when all of these facts hold and are revalidated at mutation time:

- the lease matches the selected browser engine and exact profile fingerprint;
- the current executable's canonical-path fingerprint matches the lease;
- the former owner worker is not running;
- the exact leased browser process is not running;
- control mode is normal Playwright and phase is `process_exited`;
- every detected profile lock is a fixed Chromium `Singleton*` entry;
- `SingletonLock` is a symlink encoding that same exact dead browser PID;
- each entry's device, inode, mode, size, modification time, and symlink target is unchanged;
- the lease ID and all process/executable facts still match immediately before removal.

Only the observed `SingletonCookie`, `SingletonSocket`, and `SingletonLock` entries are removed, in that order. The exact abandoned Stage5 lease is then removed and a normal atomic ownership claim/start proceeds. Any changed, live, malformed, mismatched, non-singleton, private-handoff, or otherwise ambiguous state remains blocked. No PID, path, symlink target, or private browser value is exposed through MCP.

## Regression and validation

Disposable tests cover successful exact recovery, capability invalidation when one entry changes, and refusal for a live PID, mismatched PID, or foreign lock. A real project-pinned headless Chromium integration proves the recovered profile launches with exact process ownership and then stops with no stranded locks.

Validation on 2026-08-25:

- stale-singleton unit tests: 3 passed
- internal singleton PID parser: 2 passed
- focused real Chromium recovery: 1 passed
- browser-controller integration: 71 passed
- TypeScript build and build-stamp generation: passed

No native foreground activation test or live account action ran.

## Safe resume

Load worker 0.9.3 and call `browser_available`. Continue only if the Chromium profile is reported as `owned_orphaned`, `startable: true`, and `recoverable: true` with the proven exited-singleton guidance. Call `browser_start({ browser: "chromium" })` exactly once, then require running status with proven ownership. Inspect tabs without navigation. If the only page is the incident's empty `about:blank`, stop that profile once, explicitly start the intended Chrome profile, and take a fresh tab inventory and semantic snapshot before interaction. If any proof, page, profile, or ownership state differs, do not start, stop, switch, navigate, kill a process, or modify locks; report the changed evidence.
