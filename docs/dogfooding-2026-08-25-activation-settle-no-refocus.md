# Activation settlement without dispatch-time refocus

Date: 2026-08-25
Release: 0.9.4 (tool catalog 8, worker protocol 7)

## Dogfooding evidence

Finance Agent used one fresh modal-scoped ref for the visible “Use Coinbase for business operations” button. The selected page crossed a hidden-to-visible activation boundary. Immediately before input, the exact retained handle detached; the exact-target probe proved that no trusted key, pointer, mouse, or click event reached the target, no fallback ran, and both dispatch booleans were false. The page itself reported a hidden-to-visible and unfocused-to-focused activation transition. No form value, private information, save, navigation, or account mutation occurred, and the live page was preserved without retry.

## Root cause

Stage5 correctly activated the selected page before resolving the fresh ref, but it could bind the final handle before a deferred React render caused by that activation had settled. The dispatch engine then activated the selected page a second time immediately before input. On activation-sensitive pages, that second focus boundary could schedule or synchronously cause another replacement of the already-retained handle. The guard failed closed, but a valid action could not progress.

## Fix

- A role or ref click performs its only activating page-selection step before final target resolution.
- If activation changed renderer visibility, document focus, `bringToFront` state, or native-window state, the controller requires a full bounded 500 ms settlement window before final target binding.
- After settlement it read-only observes the controller selection and renderer visibility. Losing either fails before target resolution or input.
- Immediately before normal input and each zero-event guarded fallback, the dispatch engine performs the same read-only selection/visibility observation. It does not call `bringToFront`, activate the native application, or rebind the target.
- Exact-handle state and trusted-event guards remain authoritative. Detachment or any partial/uncertain event still stops without replay.

## Regression and validation

A disposable localhost fixture schedules a semantically identical React-style button replacement 25 ms after the necessary activation returns. Before the fix, dispatch performed a second activation and failed on a detached `ElementHandle` with definite zero-dispatch evidence. The regression now proves the replacement settles before final ref binding, the target is activated exactly once, the intended button receives exactly one click, and the operation succeeds.

Focused validation on 2026-08-25:

- deferred activation regression: 1 passed
- related activation/rebinding regressions: 5 passed
- guarded fallback/native-activation regressions: 4 passed after updating the expected single activation count
- TypeScript build and build-stamp generation: passed

All browser validation used project-pinned headless browsers, disposable loopback fixtures, and temporary profiles. No native foreground activation test or live account action ran.

## Safe resume

Load worker 0.9.4 through the compatible worker boundary and require `browser_status` to report 0.9.4 before interacting. Preserve the existing page and take one fresh semantic snapshot. Continue only if the same modal and intended control are still uniquely visible. Use that fresh ref once with an explicit visible/selected postcondition, then inspect the returned exact-target evidence and a fresh snapshot. If the page, modal, target, profile, or ownership state differs—or dispatch is partial or unknown—do not retry, refocus, navigate, fill private information, save, or submit; hold and report the changed evidence.
