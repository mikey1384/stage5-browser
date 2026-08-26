# Deep custom-option snapshot detail

Date: 2026-08-26
Release: 0.10.1 (compatible behavior update; tool catalog 9, worker protocol 7, 31 tools)

## Dogfooding boundary

After a safely recovered dedicated Chromium-family profile, one fresh-ref custom-control opener received a trusted keydown and detached before keyup or click. The caller had supplied no postcondition. Stage5 Browser correctly reported partial input, emitted no fallback or replay, and retained the exact activation/event evidence.

One fresh read-only snapshot then showed that the opener was gone and a second visible nested scroll surface existed, but the intended next controls were below the whole-document semantic depth budget. Only unnamed generic layout nodes were present at that depth, with no rendered-text suffix or pointer hint. The agent stopped without scrolling, selecting, filling, saving, submitting, or inspecting private values.

No live account action was used to reproduce or validate this defect. All implementation tests use localhost fixtures and disposable headless profiles.

## Coupled root causes

1. A state-changing opener was called with `postcondition: null`. One trusted keydown is partial input, so the controller could not infer whether the intended state appeared. The existing no-replay behavior was correct.
2. The main ARIA snapshot spent its caller-selected depth budget on deeply nested custom-control wrappers. Although the newly visible nested scroll container was observed as an exact capability, its rendered option descendants were not deep enough in the document snapshot to become identifiable refs.

## Compatible fix

- Every snapshot still begins with one modal- or document-scoped ARIA capture.
- Up to three in-viewport observed scroll containers receive a separately rooted semantic detail capture with a minimum depth of 16.
- Detail is bounded to 60 referenced candidates per container and 30,000 characters total.
- Every referenced detail subtree is retained only when its exact live target is uniquely resolved, CSS-visible, and in the viewport. Existing inactive-popup filtering is applied first. Offscreen or unverified refs and their descendants are omitted.
- Each bounded section is labeled with its existing opaque `scroll-*` capability. No selector, coordinate, raw DOM dump, arbitrary JavaScript interface, or service-specific rule is exposed.
- Refs discovered in the detail remain normal document-bound `browser_click_ref` capabilities. They receive the same exact-handle preparation, activation, dispatch probe, one-use consumption, postcondition reconciliation, and no-replay rules as refs in the main snapshot.
- State-changing openers and option selections must supply a privacy-safe bounded postcondition. A null postcondition cannot reconcile partial keyboard input.

The tool catalog, tool count, input/output types, and MCP-to-worker command contract are unchanged. Connected hosts can adopt this worker behavior without another catalog reconnect.

## Regression coverage

Disposable headless fixtures prove that:

- detached partial keyboard input with no postcondition remains failed and non-retriable;
- the same partial input becomes terminal success only when its caller-supplied visible-state postcondition is observed;
- one exact generic pointer-text ref can be selected with one bounded semantic postcondition;
- an option nested beyond the main document depth is exposed by the visible scroll-container detail and selected exactly once;
- offscreen popup semantics remain suppressed; and
- the split controller suites preserve all prior lifecycle, input, scrolling, attachment, authentication, and reattachment coverage.

## Safe resume contract

Adopt worker 0.10.1 at a safe operation boundary while preserving the exact owned browser and selected page. Take one fresh semantic snapshot; do not reuse the pre-update snapshot. Continue only if one visible scroll-container detail exposes exactly one fresh ref for the already-authorized intended option and a privacy-safe semantic postcondition can prove the resulting field state. If the bounded detail ends before the intended option, use one half-viewport `browser_scroll` step on the exact uniquely observed popup `scrollContainers` capability, then take one fresh snapshot and discard every prior ref. Repeat only through a newly observed exact popup capability after confirmed movement; stop on ambiguity, unchanged geometry, boundary, timeout, or unknown dispatch. Never guess, scroll the page instead of the popup, or replay the opener.

The protected untracked Coinbase report remains preserved. This fix documents and repairs the deep-option visibility defect, but it does not by itself prove that every defect represented in that report is resolved.
