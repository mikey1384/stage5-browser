# Ref-free semantic content detail

Date: 2026-08-26
Release: 0.12.2 (compatible worker update)

## Finding

The 0.12.1 live retest proved the exact temporary renderer stayed visible at capture and that the prior draft tab was restored. The remaining bounded wait still returned `articleCount: 0`, `loadingIndicatorCount: 0`, and a timeout even though the ref-free snapshot contained one post-shaped shell and generic loading placeholders. The expanded public copy needed for read-only format comparison remained absent from that whole-document depth-limited result. The reporting agent stopped after that one inspection and performed no selection, click, scroll, navigation, dismissal, close, or post.

Two generic gaps were coupled:

Repository inspection confirmed the matching generic gaps:

1. Content growth recognized only native/ARIA articles, so a standalone semantic quotation could never advance the legacy article-growth counter.
2. `browser_inspect_tab` used only the caller-depth whole-document capture, while ordinary snapshots already had a bounded deeper-detail pattern for visible semantic surfaces.

## Compatible fix

- Outermost standalone `blockquote` roots now join native/ARIA articles as article-shaped content units. Quotations nested inside an article or another quotation are not double-counted.
- When no explicit semantic loader exists, a visible leaf whose complete rendered text is exactly a generic loading phrase can count as a loader. The scan is capped at 5,000 text nodes; disappearance is accepted only if that scan remained complete. Explicit semantic loaders retain precedence, and the generic scan is skipped when they exist.
- With no visible modal, exact-tab inspection may append novel details for at most three visible outermost article/standalone-quotation roots. Each detail is rooted at depth 20, the combined addition is capped at 30,000 characters, every ref is stripped, no handle is retained, and the result remains wholly read-only.
- Candidate enumeration, renderer visibility, exact tab/document identity, selected-tab restoration, and the operation deadline remain bounded. The helper never selects by service, URL, title, text, or index.

The tool catalog, tool count, and worker protocol remain 11, 32, and 9. Existing 0.12.x MCP hosts can adopt the completed worker without reconnecting.

## Regression coverage

A disposable duplicate-tab fixture preserves an unpublished draft while a hidden background document initially exposes only a plain generic `Loading...` leaf. On exact temporary activation, the fixture replaces that leaf with a standalone quotation nested below ten semantic groups. The test proves:

- before/after evidence advances from zero content plus one loader to one content unit plus zero loaders;
- the bounded wait is satisfied without a scroll or element action;
- a depth-4 document request receives the depth-20 ref-free detail containing the deep public copy and `See more` control semantics;
- no `[ref=...]` survives, `refCount` stays zero, and element actions remain unavailable; and
- the exact draft tab is restored once and the inspected feed renderer is hidden afterward.

Existing scroll, loader, semantic-limit, modal, and repeated-visibility-loss regressions remain in the focused and full reliability suites.

## Safe resume

Preserve Chrome, the draft, and every existing page. Do not reconnect the MCP host. Call `browser_status` once and require worker version 0.12.2, protocol 9, catalog 11, 32 tools, `restartRequired: false`, and exact owned profile/page continuity. Call `browser_tabs` once and discard every earlier tab ID. Use `browser_inspect_tab` once on the exact fresh background ID with the prior explicit temporary activation, bounded `either` wait, depth, and overall timeout.

Continue read-only only when renderer visibility at capture is visible, loading/content evidence is satisfied, the intended public detail is present, restoration is proven, controller selection is unchanged, modal count is zero, warnings are empty, ref count is zero, and element actions remain unavailable. Any timeout, absent detail, stale identity, second visibility loss, modal ambiguity, or restoration failure stops without another inspection, selection, click, scroll, close, navigation, dismissal, Next, or Post.
