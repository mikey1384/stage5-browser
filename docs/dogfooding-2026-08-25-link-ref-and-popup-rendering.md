# Destination-bound link refs and rendered popup state

Date: 2026-08-25

Release: 0.9.1 (tool catalog 8, worker protocol 7, 29 tools)

## Reports

Two independent dogfooding reports exposed related semantic-trust gaps:

- A fresh unnamed public link ref could be rejected as ambiguous when sibling unnamed links had different destinations. The snapshot's accessibility name was empty, but a later DOM text heuristic saw decorative `aria-hidden` text and discarded the exact ref before broadening to an ambiguous role/name lookup.
- A closed custom selector retained a CSS-visible portal outside the viewport. Playwright's ordinary visibility predicate exposed the portal's option/status subtree and allowed an exact option `expectedVisible` postcondition to pass even though a screenshot proved that no popup was rendered to the user. The dormant portal's internal scroll surface was also advertised as a capability.

No live account action was used to investigate either report. Both failures were reproduced with disposable local pages.

## Governing invariants

1. A fresh exact ref is authoritative only while its snapshot-observed semantics still identify the same node. For a direct link, that identity includes its already-observed destination.
2. Rebinding may narrow an exact target after a pre-input replacement; it may never broaden an unnamed link into a same-role/name sibling with another destination.
3. A popup option or selection surface is rendered only when its clipped visible region intersects the current viewport. CSS visibility outside the viewport is not evidence that an opener succeeded.
4. Dormant popup DOM must not create actionable-looking refs or scroll capabilities. Ordinary offscreen document content remains observable so the existing bounded exact-node scroll path still works.
5. A dispatched click whose rendered-state postcondition fails is recorded once and never replayed.

## Fix

- Semantic snapshots retain each direct link's `/url` child as worker-internal exact-target identity. Exact-ref activation, same-scope replacement, and article-scoped virtualization recovery require that destination to remain equal.
- Exact-ref validation now compares Playwright's own AI accessibility snapshot for the live locator instead of mixing an accessibility name with DOM `innerText`.
- Snapshot output removes offscreen or overflow-clipped `listbox`, `menu`, `tree`, `option`, `menuitem*`, and `treeitem` branches after exact-ref rendered-state inspection. An inactive surface also removes its nested stale status content.
- Offscreen scroll containers that are popup surfaces or contain popup-option semantics are withheld. Normal offscreen page refs are unchanged.
- `expectedVisible` for popup surfaces/options now requires both CSS visibility and viewport/overflow intersection. Failure remains `POSTCONDITION_FAILED` with confirmed one-time dispatch evidence and the existing do-not-repeat instruction.

The link destination and rendered-state probes never enter action diagnostics or journals. This is a compatible worker behavior fix: the MCP schema, tool catalog, and worker protocol are unchanged, so an already-connected 0.9 host does not require a reconnect.

## Regression coverage

The controller suite now proves that:

- two unnamed sibling links with decorative hidden text are disambiguated by `/build` versus another destination;
- the same link can be uniquely rebound after a pre-input clone replacement without broadening the target;
- a CSS-visible offscreen popup, its option/status subtree, and its nested scroller are absent from a snapshot;
- an ordinary offscreen link remains present in that same snapshot;
- an offscreen option cannot satisfy `expectedVisible`, the opener click is dispatched exactly once, and the operation fails closed without replay;
- moving the same popup onscreen makes its semantics and scroll capability observable and allows the exact option postcondition to pass.

## Safe resume

After the compatible worker reports 0.9.1 with `restartRequired: false`, discard every pre-fix snapshot/ref and take one fresh read-only snapshot. A closed selector must not expose its dormant options or popup scroller. Resume only the already-authorized next action from that fresh state; do not repeat an earlier opener or option click whose dispatch was ambiguous or whose postcondition failed.

This release documents only these two semantic defects. The separate untracked Coinbase dogfooding report remains preserved until every defect it represents is demonstrably fixed and documented elsewhere.
