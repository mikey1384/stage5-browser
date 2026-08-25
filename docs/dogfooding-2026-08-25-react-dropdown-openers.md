# React dropdown opener dogfooding

Date: 2026-08-25
Release: 0.6.12 (compatible runtime update; tool catalog 5, worker protocol 5)

## Observed failure

Two unrelated React-style custom dropdowns reproduced the same generic failure: the uniquely observed native button was connected, visible, enabled, in view, and uncovered, but the application replaced the opener after trusted pointer down and mouse down and before pointer up or click. The exact-ref guard correctly prevented a click on the replacement, yet the result was labeled `pointer_intercepted` and its suggested action allowed another attempt. Earlier role attempts could also retain a handle that scrolling had just replaced before input began.

No live service was opened or operated while developing this fix. All reproduction and validation used disposable localhost pages and isolated temporary browser profiles.

## Root cause

The shared click engine treated every actionable button as a pointer target. That is unnecessarily fragile for an accessible native popup button because HTML already defines Enter as a single semantic activation. Separately, role targeting had no bounded re-resolution boundary between a scroll-triggered React replacement and dispatch. Finally, failure classification prioritized a blocked misdirected event over evidence that the original exact node had detached, and retry guidance considered only whether a final click was observed rather than whether partial input had already occurred.

## 0.6.12 remedy

- A uniquely matched role target may be resolved one additional time when it detaches during pre-input viewport preparation. This happens only before any input and still rejects a missing or ambiguous replacement.
- A native HTML button with `aria-haspopup` or `aria-expanded` uses one exact Enter activation through the same role/ref transaction and exact-target guard. A successful browser-generated trusted click remains required.
- The keyboard transaction never falls through to pointer input. If it detaches, times out, or returns without a trusted target click, Stage5 reports partial or ambiguous dispatch and requires authoritative inspection.
- Pointer input that reaches the exact opener before React replaces it is classified as `detached`, preserves `actionDispatched: true` with `clickDispatched: false`, and never enters forced-handle or page-mouse fallback.
- Retry guidance now permits a new attempt only when both input and click are definitely false. Partial or ambiguous input explicitly says not to retry or replay the opener.

## Regression gate

Disposable Chromium fixtures prove that:

- role and exact-ref paths activate a replace-on-pointerdown accessible popup exactly once without emitting pointer events;
- a role target replaced by scroll is uniquely re-resolved once before input and then activated once;
- a popup that detaches during Enter activation receives no pointer fallback or replacement click; and
- a non-popup opener replaced between mouse down and pointer up returns detached partial-input evidence, consumes the ref, dispatches no fallback, and cannot be replayed with the stale capability.

The existing OneTrust, stable/forced handle, page-mouse, native-window activation, and detached-before-input regressions remain green.

## Update lifecycle

This is a compatible worker behavior fix. Stage5 Browser 0.6.12 retains worker protocol 5, tool catalog 5, and the 23-tool surface. The registered launcher reads this checkout directly; a live compatible host rolls the worker onto the completed build on its next operation. No deployment, reinstall, cachebuster, or MCP host reconnect is required.
