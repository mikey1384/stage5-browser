# Alternate exact-target hit point for partially covered controls

Date: 2026-08-26
Release: 0.11.0

## Finding

An authorized custom selector opener was visible, enabled, and inside the viewport, but its clipped visible-region center was occupied by a pointer-enabled non-target `span`. The previous actionability probe tested only that center and failed before dispatch with `target_covered_after_scroll`, even though another bounded point inside the exact target remained directly hit-testable. The operation truthfully reported `actionDispatched: false` and `clickDispatched: false`; no retry occurred.

## Fix and safety boundary

Exact-target actionability now samples a fixed bounded nine-point grid inside the viewport-and-overflow-clipped visible region. It prefers the center and otherwise records only the privacy-safe fact `pointerHitPoint: "alternate"`; coordinates remain worker-internal and never enter tool results, diagnostics, journals, or the Lounge.

When an alternate point is required, both normal and guarded exact-handle transports receive a freshly recomputed exact position. The page-level fallback uses the same bounded exact-target search. Every candidate must hit the exact target or one of its actual DOM descendants. A sibling, ancestor, overlay, detached replacement, cross-frame target, or fully covered target remains blocked. The existing trusted-event probe still requires the exact target in the event's composed path and blocks any misdirected or post-state-change event, so partial or ambiguous input is never replayed.

The native-control parser accepts older retained diagnostics that predate `pointerHitPoint`; this additive diagnostic fact cannot invalidate an otherwise exact owned Chromium control record during the 0.11.0 reconnect.

## Regression coverage

A disposable headless fixture places a pointer-enabled sibling span over only the center of a non-native ARIA button. It proves that the center is not used, one alternate point reaches the exact target, exactly one trusted pointer/mouse/click sequence is observed, the selected-state postcondition passes, and neither forced nor page-mouse fallback is needed. Existing full-cover overlay coverage remains fail-closed.

## Safe resume

Because the reported operation proved zero dispatch, preserve the page and discard its consumed snapshot/ref across the required 0.11.0 MCP reconnect. After the coordinator's version/profile/tab continuity gates pass, take one fresh snapshot and continue only if the same intended opener is unique. Invoke it once with the same bounded state-change postcondition. Require trusted exact-target evidence, no misdirection/state block, and a passed postcondition. A fully covered, stale, detached, ambiguous, partial, or unknown result must stop without retry, fill, save, submit, or private data.
