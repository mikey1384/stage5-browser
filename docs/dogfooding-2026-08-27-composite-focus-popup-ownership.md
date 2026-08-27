# Composite-focus popup ownership from Finance dogfooding

Date: 2026-08-27
Release contract: Stage5 Browser 0.21.2, MCP host behavior 14, worker protocol 19, tool catalog 21, 56 tools.

## Actual evidence first

Finance reconnected to 0.21.1 and performed one fresh `browser_inspect_control(revealOptions=true)` on the exact country searchbox. Operation `9d9e5549-2c0d-4255-9b4d-87f1f88ede24` dispatched one pointer action, returned `AMBIGUOUS_TARGET/ambiguous_control_popup_after_reveal`, and was not replayed. A single read-only recovery showed the requested semantic searchbox active with its rendered menu directly beneath it. No form value or option was entered.

The privacy-safe host trace records a 1,324 ms operation and shows pointer reveal, possible dispatch, no confirmed click, no ownership result, and a global owner inventory overflow. Finance described 10.0 seconds at the caller boundary; whether that was observed wall clock or the configured timeout is awaiting clarification and is not attributed to the worker without evidence.

## Root cause and invariant

0.21.1 evaluated target-first focus only when the exact semantic target itself was `document.activeElement`. Real composite controls may retain the accessibility role and name on a wrapper while focus moves to an internal editor. The wrapper is still the exact requested control, but the shortcut fell through to the unrelated global owner cap.

Target-first ownership now accepts focus on or inside the retained exact semantic target. It still requires spatial adjacency and a bounded proof that no different element structurally owns the surface. A detected structural competitor also disables the weaker `post_dispatch_unique` causal fallback. The runtime therefore gains the real-world composite motion without letting a focused wrapper steal another control's menu.

## Proprioception and regression

Failure diagnostics and durable traces may now include one categorical `targetFirstMiss`: `target_unavailable`, `relation_unavailable`, `insufficient_focus_or_expansion`, `not_spatial`, or `competing_structural_owner`. No label, option, value, selector, geometry, URL, or page content is retained.

Disposable fixtures prove that:

- focus inside an exact composite searchbox resolves its adjacent menu despite 120 unrelated owner-shaped controls;
- a different structural owner vetoes both contained-focus ownership and post-dispatch causal fallback;
- direct structural, exact-focus, expanded, spatial, composite, and agent-judgment behavior remains compatible; and
- telemetry retains only the categorical miss reason and dispatch evidence.

## Resume contract

Reconnect the MCP host once, immediately rejoin the stable Lounge identity, and require MCP/worker/current 0.21.2, host 14, protocol 19, catalog 21, 56 tools, and `restartRequired:false`. Discard every older form, control, popup, ref, and snapshot capability. Operation `9d9e5549-2c0d-4255-9b4d-87f1f88ede24` remains non-retriable. Resume only from fresh authoritative state and only inside the tester's existing direct controlling-user scope.
