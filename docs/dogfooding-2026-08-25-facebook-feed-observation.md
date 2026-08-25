# Stable feed loading observations

Date: 2026-08-25
Release: 0.6.11 (compatible runtime update; tool catalog 5, worker protocol 5)

## Observed failure

After Stage5 Browser 0.6.10 reattached the existing owned Chrome process, the signed-in Facebook session remained intact but the selected `Other posts` surface exposed only two article-shaped loading placeholders. One bounded document scroll moved from `y=0` to `y=430.5`, then correctly timed out waiting for article growth and classified the surface as `dynamic_content_stalled`.

The evidence feeding that classification was internally inconsistent:

- the initial sample reported two articles and zero loading indicators;
- the final sample reported zero articles and zero loading indicators; and
- fresh semantic snapshots before and after the scroll still exposed the same two visible `status "Loading..."` placeholders.

Relevant operations:

- worker/status verification: `61501137-0b0a-4309-91d0-0ae71dba180a`
- initial snapshot: `cf1bd7b7-9c8a-4325-80d1-8caa6be53e4e`
- bounded scroll: `55c321f2-481e-4213-acb1-7df2ce1ce436`
- post-scroll snapshot: `ce497b39-5d83-4b4e-9aff-fa340b9e0df9`
- diagnostics: `fee1a137-fe23-4108-9997-5d8d475163c6`

No signed-in profile, Facebook action, Coinbase action, or external post was used during development.

## Root causes

Three generic defects combined:

1. Scroll content sampling did not treat semantic `role="status"` loading placeholders as loading evidence. Its animation fallback also skipped elements containing text, so `status "Loading..."` necessarily became zero loaders.
2. Every article-shaped node counted as loaded content, even when its only substantive content was an unresolved loading status. Placeholder replacement could therefore look like no article growth.
3. Document sampling independently rediscovered a uniquely visible semantic feed on every poll. A viewport or virtualized-DOM change could compare the document or one feed before the scroll with a different feed afterward, producing incomparable article counts.

There was also a dispatch precondition gap: `browser_scroll` could change document geometry while the controller-selected renderer remained browser-hidden. Background rendering and intersection-driven loading can be throttled in that state, so movement alone did not prove that the intended feed received a meaningful visible scroll.

## Remedy

Version 0.6.11 keeps the existing tool and worker contracts and changes only compatible worker behavior:

1. The controller activates and verifies the selected renderer before collecting the baseline and immediately before every scroll step. If it cannot become visible, the operation fails closed as `page_not_active` before dispatch. If visibility is lost between steps, completed steps are reported and never replayed.
2. One content-observation root is selected before scrolling and pinned for the entire bounded wait. A later feed entering the viewport cannot silently change the counting scope.
3. An explicitly loading semantic status outside an article, or statuses that are the sole substantive content of an article shell, become unresolved loading evidence. This remains generic and localization-tolerant without classifying status controls embedded in otherwise rendered posts as placeholder articles.
4. Loading-only article shells are excluded from `articleCount`; they remain represented by `loadingIndicatorCount` until substantive content arrives.
5. If React replaces the pinned feed, the detached handle cannot become false loader-disappearance evidence. The operation returns immediately with `scroll_observation_surface_unavailable`, the exact completed-step/dispatch facts, and no replay.
6. If the selected surface exceeds an internal semantic candidate limit, the operation returns `scroll_observation_incomplete` instead of inferring growth or loader disappearance from truncated counts.
7. The optional animated-empty-element heuristic tracks completeness separately. A large unrelated DOM cannot block semantic article growth or disappearance of an explicitly observed loader, while animation-only disappearance is never inferred from a truncated heuristic scan.
8. Scroll movement and content waiting stop before a reserved result-finalization window, leaving bounded time for final geometry, diagnostics, summaries, and capability cleanup.

The final stall/end classification remains unchanged. A timed-out wait or remaining loader is still evidence of unresolved dynamic content, never proof that the feed ended.

## Regression gate

Local Playwright fixtures prove that:

- two visible loading-only status articles remain `articleCount: 0` and `loadingIndicatorCount: 2` before and after an unrelated element appears as a semantic feed;
- hidden/template content does not turn a visible loading-only shell into a substantive article, while an in-post status does not become a feed-level loader when the article has rendered content;
- exceeding the bounded article candidate limit fails closed before dispatch with structured incomplete-observation evidence;
- more than 5,000 otherwise irrelevant descendants do not block explicit semantic loader disappearance or substantive article growth when the optional animation scan is capped;
- animation-only disappearance returns structured incomplete-observation evidence when that optional scan is capped;
- replacing the pinned feed returns structured surface-loss evidence promptly instead of falsely satisfying `loading_indicators_disappear` or burning the remaining wait budget;
- a browser-hidden selected renderer causes zero scroll dispatch with structured `page_not_active` evidence;
- visibility loss after one completed step blocks the next step, reports exactly one completed step, and does not replay it; and
- existing nested-container growth, feed-scoped progressbar disappearance, fractional-boundary, and MCP scroll behavior remain intact.

The release is a compatible worker update. No MCP host reconnect is required because tool catalog and worker protocol remain at version 5.
