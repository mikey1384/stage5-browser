# Postconditioned native-button keyboard activation

Date: 2026-08-26
Release: 0.12.1 (compatible worker update)

## Finding

A fresh observed native HTML button was connected, visible, enabled, and inside the viewport, but a role-less sibling `span` covered every bounded pointer hit point. Stage5 Browser correctly reported `receivesPointerEvents: false`, `pointerHitPoint: null`, `actionDispatched: false`, and `clickDispatched: false`. No retry or account input followed.

The generic pre-dispatch actionability gate treated pointer interception as fatal before considering the already-selected transport. That was correct for pointer controls, but unnecessarily blocked a native button that Stage5 deliberately activates through one guarded keyboard input to avoid split pointer sequences.

## Compatible fix

Role and ref target preparation now choose the exact target's transport before applying pointer-interception failure. Pointer coverage may be bypassed only when all of these conditions hold:

- the retained exact element is a native `HTMLButtonElement`;
- the caller supplied a non-null bounded postcondition;
- Stage5 preselected the guarded Enter or Space transport before input;
- the exact target remains attached, visible, enabled, inside the viewport, and on the controller-selected visible page.

Pointer controls and every null-postcondition action remain blocked by an unrelated cover. The keyboard path still installs the exact-target trusted-event probe, sends one preselected key, requires a trusted click or reconciles partial key input against the requested postcondition, and never changes transport or replays input.

## Regression coverage

A disposable local page places a pointer-enabled sibling `span` over the full bounded area of a native button. The test proves pointer actionability is false, then invokes the fresh ref once with an accessible selected-state postcondition. It requires one trusted target keydown and click, a passed postcondition, no forced or page-mouse fallback, no misdirected event, and exactly one resulting state change. Existing covered-button coverage with a null postcondition remains fail-closed.

## Safe resume

Release 0.12.1 keeps tool catalog 11, worker protocol 9, and 32 tools, so an already-running 0.12.0 MCP host does not reconnect. Preserve the exact owned browser/profile/page and call `browser_status` once to adopt the compatible worker. Require worker version 0.12.1, `restartRequired: false`, and exact ownership/page continuity. Discard the consumed snapshot/ref, take one fresh snapshot, and continue only if the intended native button is unique. Invoke it at most once with the same privacy-safe bounded postcondition. Require trusted exact-target key/click evidence and a passed postcondition; stop without retry, fill, save, submit, or private input on any stale, ambiguous, partial, misdirected, or unknown result.
