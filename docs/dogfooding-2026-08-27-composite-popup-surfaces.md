# Composite popup surfaces and passive no-replay recovery

Release contract: Stage5 Browser 0.16.2 with unchanged MCP host behavior 5, worker protocol 13, tool catalog 14, and 54 tools. This is a compatible worker correction and grants no browser or account authority.

## Reproduction

A privacy-safe Lounge report identified a second custom multi-select on the preserved business-form page. One control-inspection operation dismissed one exact competing popup and dispatched the intended opener once, but post-input association returned `ambiguous_control_popup_after_reveal`. The durable trace retained a single action phase with possible input and therefore made the opener permanently non-retriable. Its surface-count and owner-category fields were unavailable in the terminal failure, obscuring the structural cause.

Disposable fixtures reproduced the generic boundary without any live account, private value, URL, label, or form content:

- one competing widget rendered nested menu/listbox surfaces owned by the same exact opener;
- one target multi-select rendered nested surfaces after a single opener input;
- one already-open multi-select exposed two disjoint explicit panels owned by the same exact control;
- two visible popups owned by different controls remained ambiguous with zero input; and
- an ambiguous post-opener spatial association retained bounded categorical telemetry and exactly one input.

## Root invariant

A popup is a semantic control capability, not necessarily one DOM node. The old one-rendered-node condition confused framework wrappers and split panels with multiple widgets.

The canonical popup association now returns a bounded surface set:

- nested surfaces belonging to the same exact owner collapse to their outer retained root;
- disjoint surfaces remain together only when explicit, structural, focused, expanded, or spatial ownership resolves them to that same exact control;
- selection lookup, option collection, scrolling, selected-representation exclusion, rebinding, rendering checks, and disposal all consume the same retained set; and
- surfaces with different owners, unbounded discovery, or unresolved ownership still fail before input.

If the intended popup set is already open, inspection adopts it passively and never closes or reopens it. If the opener may have received input, Stage5 reconciles only the resulting state and never retries that motion. A remaining ambiguous failure now includes only the bounded rendered-surface count and categorical ownership evidence; labels, geometry, selectors, values, and page content are still excluded.

## Validation and safe adoption

The focused matrix covers composite ownership, popup reveal recovery, option collection, representation reconciliation, capability rebinding, and execution telemetry. Release validation also includes TypeScript/build checks, file-size policy, and the complete headless suite. No native focus-changing test or live account action is part of acceptance.

An MCP host already on the 0.16.0 contract does not reconnect. At a safe boundary call `browser_status`, require worker/current 0.16.2 with host behavior 5, protocol 13, catalog 14, 54 tools, and `restartRequired:false`, then discard the failed inspection capability. The reported opener is never replayed. Only a separately authorized passive `browser_inspect_control(revealOptions=false)` may inspect the current state; if the intended popup set is absent or ownership remains ambiguous, stop without input.
