# Late activation loss before exact-target dispatch

Date: 2026-08-26
Release: 0.10.2 (compatible behavior update; tool catalog 9, worker protocol 7, 31 tools)

## Dogfooding evidence

After one exact observed-dropdown scroll exposed the uniquely intended business-use option, Finance Agent attempted one ref click with an exact hidden-state postcondition. The target remained connected, visible, enabled, in the viewport, and pointer-receiving. The exact-target guard observed no trusted key, pointer, mouse, or click event, and neither guarded fallback ran. During the last pre-input check, however, renderer visibility changed from visible to hidden while controller selection remained correct. Stage5 failed closed with both dispatch booleans false, and Finance did not retry or mutate the form.

The earlier recovery note had also been too conservative about a truncated option snapshot. Bounded detail intentionally exposes only currently visible choices; the safe visibility path is one half-viewport scroll through the exact observed popup container, followed by a fresh snapshot and entirely new refs. It is not permission to guess an option or replay the opener.

## Root cause

Version 0.9.4 correctly removed unconditional dispatch-time refocusing. A second focus transition after final target binding could schedule a React replacement and detach the retained handle. The replacement was a read-only final visibility check.

That check had no zero-input recovery path when the renderer became hidden after preparation. Its diagnostic retained the earlier `not_required` native-window result even though visibility was now lost, so the operation was safe but could not progress.

## Fix

- Role and ref clicks still perform no second activation while the prepared page remains visible.
- If the final guard reports `page_not_active` and exact evidence proves both action and click dispatch false, Stage5 may use one recovery cycle within the original absolute deadline.
- The discarded prepared handle is never reused. Stage5 activates the controller-selected page, waits through the same bounded settlement window, and then repeats final target resolution.
- A ref may resolve only to its original live ARIA target or one uniquely matching snapshot-captured role/name semantic inside the retained modal/document scope. Role clicks likewise require exactly one live role/name target.
- The recovered target is rechecked for attachment, visibility, enabled state, viewport intersection, and pointer interception before the single input attempt.
- A second activation loss, scope replacement, missing or multiple semantic matches, deadline exhaustion, partial input, or unknown input stops without another recovery or replay.

No tool input/output shape changed. Tool catalog 9 and worker protocol 7 remain unchanged, so a compatible worker replacement can load 0.10.2 without closing the owned browser or reconnecting the MCP host.

## Regression coverage

Disposable headless fixtures cover three boundaries:

- a renderer becomes hidden after a fresh option ref is prepared; one activation schedules a React-style replacement, settlement completes, the unique semantic option is rebound, and exactly one click succeeds;
- the same late activation loss on a role target is reprepared and clicked exactly once;
- activation creates two in-scope semantic option matches, which returns `AMBIGUOUS_TARGET` with both dispatch booleans false and zero clicks.

Validation on 2026-08-26:

- focused late-activation regressions: 3 passed;
- complete exact-input suite: 40 passed;
- split BrowserController suites: 78 passed;
- complete repository suite: 25 files passed and 3 skipped; 172 tests passed and 3 skipped;
- TypeScript build and build-stamp generation: passed.

No native focus-changing test or live account action was part of this validation.

## Safe resume

Adopt worker 0.10.2 at a safe operation boundary and require `restartRequired: false`, the same owned backend/profile, and the preserved page. Because the reported operation proved zero dispatch, take one fresh semantic snapshot and discard the consumed option ref. Continue only if the same open popup exposes exactly one fresh ref for the already authorized intended choice. Use that ref once with the same bounded privacy-safe hidden-state postcondition. If activation, target identity, actionability, or dispatch becomes partial or unknown, do not retry, scroll, fill, save, submit, or use private data; hold and report the sanitized evidence.
