# Twinkle runtime-friction dogfooding: Stage5 Browser 0.6.4

## Findings

A Twinkle workflow exposed four reliability boundaries in one run:

1. Chromium returned `profile_locked` while its current worker appeared stopped.
2. A role click returned `TARGET_NOT_FOUND` while the operator observed that the UI had changed.
3. A later exact-ref click timed out with an unknown dispatch state.
4. A managed image presentation appeared black even though the saved Stage5 screenshot was valid.

No consequential Twinkle action is inferred from a failed operation.

## Journal correlation

The privacy-safe operation journal resolves the sequence:

- `88ac340c-e37f-48f6-a111-5b18a0b228c6` failed to start Chromium with `profile_locked`; diagnostics `df79ae23-58a4-408e-a95c-c99c891b6bcc` followed, and a later start `50f0ef72-27e9-4d20-a2da-2b8fba1f22be` succeeded. Controller state and profile ownership were therefore temporarily different facts.
- `7700ff91-993c-43b1-8f49-c8bbe03e1ed4` was the successful exact-ref action that preceded the visible UI transition. The first role miss, `72109b81-3405-438e-af9a-e8616527815c`, occurred roughly 24 seconds later and completed in 21 ms; two more misses followed. Those zero-match operations did not dispatch input.
- exact-ref click `a0822c4f-d958-4cca-9dc5-241e2eec708b` timed out, and diagnostics `2de8b955-4e82-492a-824c-859abe89e0c2` retained the then-available unknown outcome. That run occurred before the 0.6.3 exact-target event probe and the 0.6.4 foreground/page-input boundary.
- screenshot `67e058dc-0a2e-4c04-843f-7d53df75d18d` saved a 377,099-byte PNG. Direct inspection of that source artifact showed the complete rendered Twinkle page and team-selection modal. The black result was a managed-view false negative, not a black source capture.

## 0.6.4 remedies

### Controller state versus profile ownership

`browser_status` now always reports `profileLockState` and `profileLockFiles` alongside `state` and `browserConnected`. A stopped worker with `possible_external_owner` no longer looks like a free profile. Fresh Chromium startup gives a prior owned process up to two seconds to release its locks and rechecks for a valid native-control record. Stage5 never deletes a lock, kills an unknown process, or labels a lock stale merely because the current worker is stopped.

### Transitioning role targets

`browser_click_by_role` now gives a zero match a bounded one-second transition window. If the target remains absent, the error explicitly returns `actionDispatched: false`, `clickDispatched: false`, the bounded wait duration, and an instruction to take a fresh snapshot. This makes an earlier or autonomous UI transition impossible to misattribute to the failed role action.

### Unknown exact-ref input

The later 0.6.3/0.6.4 exact-ref dispatch guard supersedes the older ambiguous timeout. It records whether trusted pointer/mouse/click events reached the exact node, activates the selected page before input, and permits lower-level fallbacks only after zero-event proof. Partial or unavailable evidence remains non-retriable.

### Managed capture false negative

`browser_screenshot` now activates and verifies the selected page before capture. Its `captureEvidence` returns only page-activation facts, PNG byte length, semantic-content presence, a conservative `contentful` or `possibly_uniform` classification, and whether one bounded recapture occurred. If semantic content exists and the first PNG compresses like a nearly uniform image, Stage5 waits briefly and captures once more. The private source path remains authoritative when an MCP client misrenders an otherwise contentful image.

The classification is deliberately conservative: it does not inspect, log, or return pixels or page text, and it does not claim that a legitimately dark scene is broken.

## Regression acceptance

Automated coverage now proves that:

- a stopped controller reports an existing profile lock as `possible_external_owner`;
- a lock released during the bounded startup interval permits normal launch without deletion;
- a semantic role inserted during a UI transition is found and clicked safely;
- screenshot capture records foreground activation and contentful artifact evidence;
- a semantically populated, highly uniform render receives exactly one bounded recapture; and
- the exact-target foreground and zero-event fallback regressions remain green.

This remains a compatible worker update: version 0.6.4 retains worker protocol 5, tool catalog 5, and 23 MCP tools. The direct registration loads the rebuilt worker on the next operation without deployment, reinstall, cachebusting, or host reconnection.
