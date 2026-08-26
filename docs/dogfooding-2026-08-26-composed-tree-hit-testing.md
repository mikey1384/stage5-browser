# Composed-tree exact-target hit testing

Date: 2026-08-26
Release: 0.12.0

## Finding

A native selector button remained fully covered at every bounded hit point by a role-less `span`. Version 0.11.0 correctly accepted ordinary DOM descendants but still reported `pointerHitPoint: null` because a slotted rendered child can be in the button's composed tree without satisfying `button.contains(span)`. The live operation failed before transport selection with `actionDispatched: false` and `clickDispatched: false`; no retry occurred.

## Fix and safety boundary

Exact hit testing now walks assigned slots and shadow hosts to prove composed-tree ancestry. This matches the existing trusted-event guard, which accepts input only when the exact target appears in the event's composed path. A true light-DOM child, slotted child, or shadow child may therefore supply the center or one bounded alternate hit point.

Unrelated siblings, ancestors, external overlays, disabled targets, detached replacements, cross-frame nodes, and fully covered targets outside the exact composed path remain blocked. Coordinates remain worker-private. Native buttons still use one guarded keyboard activation after preparation; partial or ambiguous input is never replayed.

## Regression coverage

A disposable custom-element fixture renders a slotted `span` over the full native button. It proves ordinary DOM containment is false, composed hit testing succeeds, the native button receives one trusted guarded activation, and the selected-state postcondition passes. The existing pointer-enabled sibling/full-overlay coverage remains fail-closed.

## Safe resume

Preserve the exact browser/profile/page and discard the consumed ref across the required 0.12.0 reconnect. After version and continuity gates pass, take one fresh snapshot. Continue only if the intended native button is unique, then invoke it once with the same bounded postcondition. Require trusted exact-target evidence and a passed postcondition. Stop without retry, fill, save, submit, or private action on any stale, external-cover, partial, ambiguous, or unknown result.
