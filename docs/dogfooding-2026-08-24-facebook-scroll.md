# Facebook feed dogfooding: Stage5 Browser 0.6.0

## Workflow evidence

A private Chrome authentication handoff preserved the Facebook session and allowed the agent to identify the intended personal profile. The first public post was readable, but Facebook's “Other posts” timeline remained on skeleton loaders. The workflow correctly paused before inspecting the Stage5 page.

- Stalled scroll: `e74686aa-f9d9-4128-a25f-43974ac5210c`
- Loading-only snapshot: `b07f140f-2dc3-49aa-b87e-de513602bc27`
- Screenshot: `60cab2fe-01db-496f-bf47-002958c8e50d`
- Diagnostics: `ab759f4f-abb1-4956-a771-c4b33f99315b`

The root document reported `y: 2443.5` and `maxY: 2444`, but 0.5.1 required exact equality and therefore returned `documentBoundaryReached: false` and `endState: not_at_boundary`. A second scroll made no progress. Diagnostics contained 227 successful requests with no failures or HTTP errors, but scroll was not represented as `lastAction`, so those requests could not be isolated to the scroll window. The snapshot also offered no safe way to identify or target a possible inner feed scroller, and there was no bounded semantic wait for article growth or loader disappearance.

## 0.6.0 remedy

Semantic snapshots now inventory up to 20 visible vertical scroll surfaces inside the active scope, including a modal when that modal is itself scrollable. Each `scrollContainers` entry returns an opaque ref plus a bounded label, role, viewport status, and geometry. The controller retains the exact element handle. `browser_scroll.target` accepts only the latest snapshot ID/ref from the same frame and document, revalidates that the element is still attached and scrollable, consumes the capability once, and never accepts a selector.

`browser_scroll.waitFor` adds three generic bounded conditions:

- `article_count_growth`
- `loading_indicators_disappear`
- `either`

The result reports aggregate before/after article and visible loading-indicator counts, elapsed time, and explicit evidence. It does not return selectors, classes, article text, or raw network data. Fixed semantic/loading selectors are supplemented by a bounded animated-empty-element heuristic so inaccessible skeletons can still be observed without service-specific Facebook code.

Boundary comparison now allows one CSS pixel, correctly treating `2443.5 / 2444` as the current geometric boundary. A downward surface at that boundary with no final movement or growth is `dynamic_content_stalled` when earlier growth was seen, a requested content wait expires, or a loader remains visible. This still does not set `endReached: true`; only an explicit end marker or confirmed upward start does that.

Every scroll now opens and closes the same sanitized page-action window used by click diagnostics. `browser_diagnostics.page.lastAction.action` is `scroll`, `actionDispatched` records dispatch certainty, and `lastActionNetworkEvents` isolates bounded HTTP success, redirect, error, and failure classifications associated with that action.

## Regression acceptance

The fixture suite proves that:

1. A nested feed is detected and exposed without an accessible click target.
2. An unchanged document scroll reports the number of nested candidates and a structured warning.
3. A fresh container ref scrolls only the intended surface and fails closed when replayed.
4. A bounded `either` wait observes article growth and loader removal.
5. The feed request appears under scroll-correlated diagnostics.
6. A root document pinned half a CSS pixel below its maximum is boundary-reached and `dynamic_content_stalled` when its loader never resolves.
7. A unique modal that is itself scrollable is exposed even though it is the semantic snapshot root rather than a descendant.
8. The MCP catalog carries the new target and wait inputs through the supervisor/worker boundary.

## Host pickup

This release changes the existing `browser_scroll` input/output schema and the snapshot/diagnostic worker payload. It therefore intentionally keeps 23 tools while incrementing tool-catalog version to 5 and worker protocol to 5. An agent host that loaded 0.5.1 must reconnect once before these fields are available. This is a real contract change, not a compatible worker patch.

The direct `stage5_browser` MCP registration already points to this checkout's built launcher. No deployment, marketplace reinstall, cachebuster, duplicate registration, or manual code patch is required. After reconnecting, the original Facebook agent should call `browser_status`, verify version 0.6.0 with 23 tools and `restartRequired: false`, verify the existing Chrome session with a fresh snapshot, then resume exclusively through the new scroll workflow. It should not repeat login unless visible Facebook state proves the session was lost.
