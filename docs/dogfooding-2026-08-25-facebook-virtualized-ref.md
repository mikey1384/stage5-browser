# Facebook virtualized-reference dogfooding: Stage5 Browser 0.6.2

## Finding

Stage5 Browser 0.6.1 correctly refused to dispatch an offscreen Facebook `See more` click, but its single native scroll-into-view attempt could not move the fresh observed reference into the viewport. The target remained visible and enabled in the semantic model, yet offscreen, and the operation ended safely with `actionDispatched: false` and `clickDispatched: false`.

The page reported no nested scroll-container candidate. The remaining boundary was therefore document/feed scrolling combined with virtualized DOM replacement: scrolling toward an older feed item can detach the exact element represented by the snapshot ref and render an equivalent replacement.

No click or Facebook mutation occurred during the failed run.

Privacy-safe evidence supplied by the dogfood agent:

- version operation: `2f439afb-e32a-43b6-abe9-deb25c01aa9b`
- snapshot operation: `febc38d4-c2ec-496f-8fca-08352a258bcd`
- snapshot ID: `61af2686-3182-4822-8c62-900de08dcf54`
- blocked click: `66b7726e-0558-42df-87d7-2729a109f54c`
- diagnostics: `9dafc691-5428-44f6-a631-79a186eb4f99`
- reported reason: `scroll_into_view_failed`

## 0.6.2 remedy

`browser_click_ref` now:

1. captures the exact observed DOM node and a privacy-fingerprinted, article-scoped semantic identity before scrolling;
2. advances toward it through bounded incremental movement of a visible nested scroll surface or the document surface;
3. checks the exact node after every step;
4. if feed virtualization detaches that node, accepts a replacement only when one article and one same-name/role/tag target match uniquely;
5. clicks the retained exact element handle, so a later locator re-evaluation cannot silently retarget the action; and
6. consumes the snapshot and reports a pre-dispatch failure when the replacement is absent, changed, over the bounded scan limits, or ambiguous.

The controller never performs a global accessible-name fallback. Article text used for comparison is normalized, bounded, converted to a process-local privacy fingerprint, and never returned or journaled.

The shared target-state inspector now treats a disconnected element handle as detached even when the browser can still evaluate that orphaned node.

## Regression acceptance

Automated browser regressions cover both sides of the safety boundary:

- an offscreen article is replaced during the first document scroll; the original button is inert, while the uniquely rebound replacement reveals the requested postcondition;
- two identical article replacements are rendered during scrolling; Stage5 rejects the action as `AMBIGUOUS_TARGET` with `actionDispatched: false` and `clickDispatched: false`; and
- a connected but impossible offscreen target still fails promptly before dispatch and consumes its snapshot capability.

## Update lifecycle

This is a compatible worker behavior fix. Stage5 Browser 0.6.2 retains worker protocol 5, tool catalog 5, and the 23-tool surface. The direct `stage5_browser` registration points to this checkout, so a live compatible host rolls its worker onto the completed build on the next browser operation. No deployment, marketplace reinstall, cachebuster, host reconnect, duplicate registration, or repeated login is required.

The paused agent must take a fresh snapshot because the failed attempt consumed the old reference, then retry once through `browser_click_ref`.
