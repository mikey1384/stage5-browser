# Partial effects, focus, and connected-state continuity

Date: 2026-08-25
Release: 0.7.0 (tool catalog 6, worker protocol 6)

This release adds one MCP tool and one worker command. Existing 0.6.x hosts therefore report `MCP_RESTART_REQUIRED` until their MCP connection is restarted once; this is a real contract change, not a build-fingerprint update.

## Dogfooding failures

A React validation control accepted trusted pointer-down and mouse-down input, initiated its requested validation effect, and replaced the opener before pointer-up/click. Stage5 Browser correctly refused to replay the partial sequence, but reported the operation as a failure even after the requested success state became visible. A caller could therefore mistake an externally successful consequential action for a failed one.

The same workflow also exposed four independent generic reliability gaps:

- every input activation called `bringToFront`, unnecessarily pulling the browser and macOS Space even when the selected renderer was already visible;
- compatible worker replacement could close a direct-Playwright context and reconstruct only its last URL, discarding unsaved form state;
- reconnecting native Chromium selected the last enumerated page instead of the exact prior tab, which was unsafe with duplicate same-URL application tabs;
- actionability hit-tested an element's raw center rather than its visible overflow-clipped portion, so a containing dialog could be mislabeled as a cover;
- popup postconditions did not treat `aria-expanded` as selected state, forcing brittle assumptions about a custom menu's rendered semantic role.
- an active composer exposed an unnamed snapshot textbox ref while role-based fill required a non-empty accessible name, leaving no safe way to fill the exact editor.

No live account, profile, form, or third-party service was inspected or operated while implementing the fixes.

## Fix

- After partial or ambiguous exact-target input, a supplied postcondition is reconciled inside the reserved finalization deadline. If the requested effect is observed, the operation returns terminal success while diagnostics retain `clickDispatched: false` or `unknown` and the exact trusted event phases. No input is replayed. If the effect is absent, the original non-retriable partial-input failure remains authoritative.
- Page activation first observes the controller-selected renderer. An already-visible renderer receives input without `bringToFront` or native application activation. Hidden renderers retain the exact owned-window recovery and final visibility gate.
- Connected direct-Playwright sessions defer compatible worker replacement until explicit stop. Proven native-CDP sessions may update in place because the browser remains running.
- The private native-control record stores one bounded opaque CDP target identity. Reattachment restores that exact live tab and never exposes or journals the identifier.
- Actionability and page-mouse fallback use the intersection of the target rectangle, viewport, and every clipping/scrolling ancestor.
- `expectedSelected` recognizes `aria-expanded` in addition to selected, checked, pressed, current, native option, checkbox, and radio state.
- `browser_fill_ref` fills an exact fresh textbox, textarea, or contenteditable capability without requiring an accessible name. It revalidates the current document/frame/modal scope, consumes the ref once, keeps the supplied value out of results and journals, and returns input/change plus exact value-match evidence.

## Regression gates

Disposable fixtures now prove that:

1. a validation effect triggered on mouse-down and followed by React opener replacement returns success only when its requested visible postcondition is observed, records partial dispatch truthfully, and never clicks the replacement;
2. an already-visible selected page is clicked with zero `bringToFront` calls;
3. a mostly clipped but genuinely hit-testable control is not falsely covered by its dialog;
4. accessible popup opening is verified through `aria-expanded` despite custom menu structure;
5. a connected direct-Playwright context holds its worker during a compatible update, then adopts the build after explicit stop;
6. native-control records preserve and resolve an exact opaque Chromium target among duplicate same-URL tabs.
7. an unnamed active contenteditable inside a modal can be filled once through its fresh ref, returns privacy-safe event/value confirmation, and rejects stale replay.
