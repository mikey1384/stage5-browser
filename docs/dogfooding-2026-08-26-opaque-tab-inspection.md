# Opaque duplicate-tab selection and background inspection

Date: 2026-08-26
Release: 0.11.0 (tool catalog 10, worker protocol 8, 32 tools)

## Dogfooding findings

A preserved social-page draft and a separate inspection page exposed the same sanitized URL and title. `browser_tabs` returned only positional indices, so page churn could make a later index refer to a different page and the agent could not prove which duplicate it selected. Normal `browser_snapshot` also targets the controller-selected page and automatically narrows a unique visible modal, leaving no read-only way to inspect an exact background document without activating it or risking the draft.

A separate report attributed lost Lounge membership to a compatible browser-worker replacement. The Lounge is owned by the parent MCP process, not the browser worker. A disposable MCP regression now replaces the compatible worker, proves the worker PID changes while the MCP PID remains fixed, and sends through the original joined Lounge session. `lounge_not_joined` now reports `boundary: "mcp_connection"` and explicitly states that browser-worker replacement preserves membership. A real MCP host reconnect still creates a new connection and therefore requires `lounge_join` with the same stable identity.

## Contract

- `browser_tabs` returns a random session-scoped opaque `tabId` for every live page. It is not the private Chromium/CDP target identity and is never derived from URL or title.
- `browser_select_tab` requires one fresh observed `tabId`. It never falls back to URL, title, enumeration order, or positional index. A closed, replaced, or unknown page fails before selection with `stale_tab_id` and `actionDispatched: false`.
- `browser_inspect_tab` captures the exact observed page's main-document accessibility view without selecting it, calling `bringToFront`, or activating the browser application. Every element and frame action ref is withheld and no snapshot capability is retained (`refCount: 0`, `elementActionsAvailable: false`, `activationAttempted: false`).
- Background inspection reports renderer visibility, modal count, and whether the controller-selected page remained unchanged. A modal warning states that underlying accessibility content may be suppressed; it never recommends closing preserved state.
- Raw native target IDs remain private and continue to serve only compatible worker continuity.

## Regression coverage

The disposable duplicate-tab fixture gives two pages the same URL and title but different DOM state: one prior-post document and one preserved composer modal. It proves that background inspection returns only the intended prior-post document, exposes no refs, makes no foreground call, and keeps the composer tab selected. After an earlier tab closes and positional indices shift, the original opaque capability still selects the exact page. Closing that exact page makes the capability fail closed.

The MCP regression proves a compatible worker replacement leaves the original Lounge join usable, and separately verifies the diagnostic distinction for a genuinely unjoined MCP connection.

## Safe resume

This release changes both the public MCP schema and the MCP-to-worker command contract, so each running host must reconnect once. Preserve every owned browser process, profile, page, and unpublished draft during reconnect. After rejoining the Lounge, require `browser_status` to report version 0.11.0, catalog 10, protocol 8, 32 tools, and `restartRequired: false` before browser work.

For duplicate pages, call `browser_tabs` once and discard all prior indices and tab IDs. Keep the draft tab untouched. Use `browser_inspect_tab` once on the exact fresh candidate background `tabId`; treat its output as ref-free read-only evidence. If it shows the intended document with no identity/selection warning, deliberately select that same fresh `tabId` only when interaction is still within existing user authority. If both exact pages contain a modal, underlying content is suppressed, identity is stale, or controller selection changes, do not close, dismiss, navigate, post, or discard anything; hold and report the sanitized evidence.
