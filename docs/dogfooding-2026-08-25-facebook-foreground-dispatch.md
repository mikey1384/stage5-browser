# Facebook foreground dispatch dogfooding: Stage5 Browser 0.6.4

## Finding

Stage5 Browser 0.6.3 proved that a fresh Facebook `See more` target remained connected, visible, enabled, in the viewport, able to receive pointer events, and uncovered throughout dispatch. Its guard stayed live and its forced exact-handle fallback ran, yet no trusted pointer, mouse, or click event reached the target. The requested `See less` postcondition was not reached and Facebook did not change.

This moves the failure below Stage5's actionability and exact-handle layers. The missing evidence was whether the controller-selected Facebook page was also the browser's genuinely foreground tab at the instant input was sent, and whether direct page input could reach the already-proven target when both handle transports could not.

No Facebook action completed during the failed run.

Privacy-safe evidence supplied by the dogfood agent:

- status: `fa8c3f9d-2361-40c4-a772-26cea6d06248`
- fresh snapshot: `fd0cd15f-043d-4265-ba94-9733cc6f332a`
- failed click: `35d4481b-6a22-46f0-aa42-e07e2473b3ce`
- diagnostics: `35fdac7a-034e-4689-be2a-3b70311ebf1a`

## 0.6.4 remedy

Immediately before every exact-ref input path, Stage5 Browser now calls `bringToFront` on the controller-selected page and records only privacy-safe activation facts:

- whether the page is still the controller's selected page;
- whether foreground activation was attempted and succeeded;
- `document.visibilityState` before and after activation; and
- `document.hasFocus()` before and after activation.

Input fails closed with `page_not_active` when the selected page cannot become visible. Page URLs, titles, coordinates, and browser-window geometry are not added to this evidence.

Exact-target dispatch now has a third and final transport boundary:

1. the bounded normal exact-handle click;
2. one forced exact-handle click only after the first path timed out with zero trusted events; and
3. one page-level mouse click only after both handle paths emitted zero trusted events, the guard remains live, the same node remains fully actionable, and the selected page has just been activated.

The third path recomputes a hit-tested point from the exact element's fresh bounding box. It is currently restricted to the main frame because page-level coordinates across frame boundaries could otherwise target an unguarded parent overlay. The coordinate exists only inside the worker for the duration of dispatch; it is never returned, logged, journaled, or included in an error. The original capture guard remains active, so misdirected or state-changed input is blocked. Any partial or uncertain input stops the sequence without another attempt.

`dispatchEvidence` now includes `pageActivation` and the booleans `forcedFallbackUsed` and `pageMouseFallbackUsed`, allowing an agent to distinguish controller-selection drift, failed foreground activation, two silent handle paths, and a completed exact-target click.

## Regression acceptance

Automated browser regressions prove that:

- an auxiliary tab may be open while Stage5 retains the intended controller-selected page;
- the intended page is brought forward and observed as visible immediately before input;
- when both exact-handle transports are deterministically made to emit zero events, one page-level dispatch reaches the guarded exact target, produces the trusted pointer/mouse/click sequence, and satisfies the visible-state postcondition;
- continuously animated targets still use only the guarded forced-handle path when it succeeds; and
- detached, ambiguous, partial, cross-frame, inactive-page, and unavailable-evidence paths remain fail-closed.

## Update lifecycle

This is a compatible worker behavior and additive diagnostic update. Stage5 Browser 0.6.4 retains worker protocol 5, tool catalog 5, and the 23-tool surface. The direct `stage5_browser` registration loads the completed worker on the next browser operation. No deployment, marketplace reinstall, cachebuster, host reconnect, duplicate registration, or repeated login is required.

The paused agent must take a fresh snapshot because the prior click consumed the old reference, then retry once with the expected `See less` state as its postcondition.
