# Restored temporary tab inspection

Date: 2026-08-26
Release: 0.12.0 (tool catalog 11, worker protocol 9, 32 tools)

## Finding

Opaque tab identity and passive background inspection worked after the 0.11.0 reconnect, but the exact background document remained renderer-hidden and exposed only a dynamic loading status. Some applications suspend or defer feed work until that renderer becomes visible. Repeating passive inspection cannot make progress, while manually chaining tab selection and restoration leaves a larger failure window around a preserved draft.

## Explicit contract

`browser_inspect_tab` remains strictly passive by default. A caller may now set `temporaryActivation: true` and optionally provide the existing bounded article-growth/loading-disappearance expectation. Stage5 then:

1. Pins the exact target `tabId`, exact controller-selected page, and document version.
2. Observes the loading surface before activation.
3. Brings only the exact target renderer forward inside the already controlled browser, without calling Stage5's native application-activation path or changing the controller selection.
4. Waits within the caller's bounded generic expectation and captures a ref-free document view.
5. Restores the exact prior selected page in `finally` and proves its renderer visible before returning.

The result reports activation attempt/restoration, target visibility at capture and after restoration, bounded loading evidence, modal count, and controller-selection continuity. It still exposes no element or frame action refs. Missing/stale identity, document replacement, unsatisfied loading evidence, or unproven restoration fails or warns without a browser element action; it never falls back to URL, title, or index.

## Regression coverage

A disposable duplicate-tab fixture keeps an unpublished modal page selected while a background page shows `Loading...` until its renderer receives a visibility transition. Passive inspection proves no activation and no progress. Explicit temporary activation observes loader disappearance/article growth, captures the loaded ref-free document, restores the draft page exactly once, and proves the feed hidden and draft visible afterward.

## Safe resume

The schema and worker contract changed, so reconnect the MCP host once while leaving the owned browser open, rejoin the Lounge, and require version 0.12.0, catalog 11, protocol 9, 32 tools, `restartRequired: false`, and exact profile/page continuity. Call `browser_tabs` once and discard earlier IDs. Use `browser_inspect_tab` once on the exact background ID with `temporaryActivation: true`, `waitFor.condition: "either"`, and a bounded timeout. Continue read-only only when activation was restored, controller selection is unchanged, loading evidence is satisfied, no modal/identity warning exists, and the intended public document appears. Never close, dismiss, navigate, discard, Next, or Post merely to expose content.
