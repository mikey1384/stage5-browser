# Direct multi-select reveal routing from Finance dogfooding

Date: 2026-08-27
Release contract: Stage5 Browser 0.21.4, MCP host behavior 16, worker protocol 21, tool catalog 23, 56 tools.

## Actual evidence first

Finance reported one fresh 0.21.2 `browser_select_options` failure without private values or documents. Operation `8eaf212e-cef2-4818-aa12-0e62b0c8e18d` entered `form_manager`, completed four reversible viewport movements, and used pointer reveal on the exact opener. Trusted pointer-down and mouse-down reached the target, the framework replaced it before pointer-up/click, and the operation observed no selection effect. A later fresh authoritative snapshot found the correct popup and both options visible while the field remained empty. No option click followed, and the live workflow is now explicitly gated on controlling-user confirmation rather than this browser patch. The opener operation remains possible-input and non-retriable.

The existing privacy-safe trace was decisive: host 0.21.2 behavior 14, worker protocol 19, `selectOptions`, `form_workflow`, one dispatched action, pointer transport, detached terminal reason, 2,036 ms total, and no selection reconciliation. No ad-hoc page probe or live-account action was needed.

## Root cause and invariant

Two related lifecycle gaps were exposed. Focused control inspection already let an agent choose pointer or keyboard reveal before input, but direct multi-selection silently used its internal inspection default. The high-level hand therefore hid a viable safer motion and forced the agent either into pointer input or into a separate inspect-then-select sequence. After the partial pointer input, reveal reconciliation also performed only one immediate ownership/rendering observation; it missed the popup that appeared shortly afterward.

`browser_select_options` now accepts `revealInteraction=auto|pointer|keyboard`. The form manager carries that one pre-dispatch choice through its initial inspection and every fresh inspection needed between additive selections. Native selects require no reveal. After possible opener input, the reveal manager and selection-capability rebinder share one canonical rendered-popup stabilization observer. It polls read-only for at most 750 ms inside the existing action deadline, retains a resolved surface only after every member is rendered, disposes transient handles, and never dispatches again. Prior possible input is never retried inside the operation, and option selection still reconciles authoritative selected state or field-local representation.

## Proprioception and regression

Successful inspection and multi-selection return the actual categorical reveal method and `revealReconciliation=immediate|stabilized` when opener reconciliation ran. The host derives `controlRevealInteraction` and `controlRevealReconciliation` from those results; it retains no label, option, value, selector, geometry, URL, or page content.

A built-MCP disposable fixture gives the opener two behaviors: pointer-down replaces it without opening the list, while Enter replaces it and opens one structurally linked multi-select popup. Its first option closes the popup so the second selection must perform a fresh internal inspection. One direct keyboard-reveal multi-selection proves zero opener pointer-downs, two opener keydowns, two exact option clicks, both selected states, the intentionally open final popup state, and categorical telemetry.

A second fixture makes pointer-down replace the opener, then renders its structurally linked popup after 120 ms. The current one-shot implementation failed before the popup appeared. The shared bounded observer now recognizes the delayed authoritative effect as `stabilized`, returns the options, records one possible-input dispatch, and proves zero opener replay.

## Resume contract

Reconnect once, rejoin the stable Lounge identity before browser tools, and require MCP/worker/current 0.21.4, host 16, protocol 21, catalog 23, 56 tools, and `restartRequired:false`. Discard all older control, popup, option, ref, snapshot, and inspection capabilities. Operation `8eaf212e-cef2-4818-aa12-0e62b0c8e18d` remains non-retriable. The live workflow is currently controlling-user-gated, so do not issue another selection until that direct confirmation exists. After confirmation, resume only from fresh authoritative state; where current evidence makes pointer reveal unsuitable, issue one fresh `browser_select_options` with `revealInteraction=keyboard`.
