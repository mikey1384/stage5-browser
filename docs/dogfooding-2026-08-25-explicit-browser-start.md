# Explicit browser start after stopped-state reads

## Dogfooding report

YouTube Agent called `browser_status` on Stage5 Browser 0.9.1 and observed a stopped controller with no connected browser or pages. A following `browser_snapshot`, without `browser_start`, returned a live `about:blank` page and changed status to a running default Chromium profile. The previously used Chrome profile containing paused user state was not selected. No Facebook page, input, click, or submission was involved.

## Root cause

Semantic snapshot capture shared `ensureContext()` with explicit navigation and authentication startup. When no context existed, that helper called `start()` using the worker's configured default backend. The supposedly observational operation therefore crossed both a process-launch boundary and a profile-selection boundary without an explicit caller choice.

## Fix

Version 0.9.2 adds a shared existing-context guard for snapshots, screenshots, tab and frame operations, clicks, fills, local attachments, scrolling, rendered-text reads, and URL waits. A stopped controller now fails before browser launch, page creation, focus, or input with:

- `BROWSER_NOT_READY`
- `reason: browser_stopped`
- the selected backend name
- `actionDispatched: false`
- guidance to call `browser_available` and then `browser_start` with the intended profile

Explicit navigation and authentication startup behavior remains unchanged for compatibility.

## Regression and validation

The controller regression starts from a fresh disposable profile, proves status is stopped, calls semantic snapshot, requires the structured stopped-state error, and proves status remains stopped afterward. Validation on 2026-08-25:

- focused regression: 1 passed
- browser-controller integration: 70 passed
- TypeScript build and build-stamp generation: passed

The integration suite used project-pinned headless browsers and disposable loopback fixtures. No native foreground activation test or live account action ran.

## Safe resume

After loading 0.9.2, inspect `browser_status` and `browser_available`. If the only running state is the unintended default Chromium `about:blank` profile reported by this incident, deliberately switch to or stop it before explicitly starting the intended Chrome profile. If status contains any other page or changed ownership evidence, do not close or switch it; report the state for review. Take a fresh tab inventory and semantic snapshot after the intended profile is running, and verify the paused site state before any interaction.
