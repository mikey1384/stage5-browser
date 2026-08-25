# Facebook click-dispatch dogfooding: Stage5 Browser 0.6.3

## Finding

Stage5 Browser 0.6.2 successfully moved and rebound a fresh Facebook `See more` reference. Its final actionability evidence was fully positive: the target was visible, enabled, in the viewport, able to receive pointer events, and uncovered.

The subsequent Playwright click nevertheless consumed the remaining deadline and returned `clickDispatched: unknown`. The caption stayed collapsed; neither of the expected expanded-caption markers appeared in rendered text. This isolated the remaining failure to the interval between Stage5's final exact-node check and Playwright's pointer dispatch. A continuously moving or re-rendering control can satisfy Stage5's point-in-time checks while never satisfying Playwright's additional stable-element wait.

No Facebook action completed during the failed run.

Privacy-safe evidence supplied by the dogfood agent:

- version operation: `296955af-95e0-47de-91fc-ffd5b3c3c390`
- snapshot operation: `b08f090f-5479-4b8c-962c-d7fcdec952d3`
- snapshot ID: `d4f09e7f-08bd-4095-838e-a2ae99aa9e09`
- timed-out click: `4dfe6d27-e6d0-480f-a1e5-7f61f242c480`
- diagnostics: `991a91a8-4df3-4110-8a11-6f0da11ccb65`
- post-click rendered-text check: `6652acd7-a2f4-4862-97ab-af63b49b8d50`

## 0.6.3 remedy

`browser_click_ref` now installs a bounded exact-target dispatch guard before asking Playwright to click. The guard records only privacy-safe facts about trusted pointer, mouse, and click events. It reports target connectivity before, at the first input event, and afterward; whether geometry changed before the first event; whether each input phase reached the exact target; and whether a misdirected or newly non-actionable event was blocked.

Dispatch proceeds in two stages:

1. A short normal exact-handle click retains Playwright's standard stability and hit-target checks.
2. If that attempt ends without any trusted input event and the same handle still passes Stage5's full actionability check, one guarded `force` attempt bypasses only Playwright's persistent stability wait.

This second stage is not an ambiguous retry: it is permitted only when the probe proves the first attempt emitted no trusted event. The window-level capture guard blocks an event whose path no longer contains the exact target or whose exact target became detached, hidden, disabled, or out of view. If any partial exact-target input was observed, if evidence is unavailable, or if the target changed, Stage5 does not force another click.

Error details and `browser_diagnostics.lastAction` now include the sanitized `dispatchEvidence`. A no-event timeout can therefore resolve to `actionDispatched: false`; a partial pointer sequence resolves to `actionDispatched: true` and `clickDispatched: false`; a confirmed exact click resolves to both true; and genuinely unavailable evidence remains unknown.

Normal Playwright clicks that complete and navigate remain valid even when the old document destroys its in-page probe before Stage5 can read it. Their requested URL or visible-state postcondition remains the authoritative workflow check.

## Regression acceptance

Automated browser regressions prove that:

- a continuously animated exact target first emits no event under the bounded stable-click attempt, then receives a trusted pointer/mouse/click sequence through the guarded fallback and satisfies its visible-state postcondition;
- an exact target replaced after guard installation but before pointer dispatch is classified detached with `actionDispatched: false`, `clickDispatched: false`, and no fallback; and
- navigation clicks, virtualized offscreen clicks, ambiguous replacement rejection, and one-use snapshot behavior continue to work.

## Update lifecycle

This is a compatible worker behavior and additive diagnostic update. Stage5 Browser 0.6.3 retains worker protocol 5, tool catalog 5, and the 23-tool surface. The direct `stage5_browser` registration loads the completed worker on the next browser operation. No deployment, marketplace reinstall, cachebuster, host reconnect, duplicate registration, or repeated login is required.

The paused agent must take a fresh snapshot because the timed-out attempt consumed the old reference, then retry once with the expected expanded-caption text as a click postcondition.
