# Searchable-option commit routing from Finance dogfooding

Date: 2026-08-27
Release contract: Stage5 Browser 0.21.2, MCP host behavior 14, worker protocol 19, tool catalog 21, 56 tools.

## Actual evidence first

Finance reported a second 0.21.1 country-control failure without relaying private data:

- query fill operation `a6b6720e-6a5e-46a5-a9af-ac50e85ed9b4` succeeded once in 728 ms;
- exact menuitem click operation `3eb8e558-7c50-4e66-a98f-7c50fa17d23a` produced possible input, no trusted click, and no committed selection; and
- a later Enter operation `adf38843-7d62-4276-8b8e-40b0efc2a4b4` targeted the fresh active option capability, produced possible input, and left the menu visible with no committed selection.

No further input was attempted. Every prior operation remains non-retriable. A separately authorized local identity document remains entirely outside the Lounge and this developer workflow.

## Root cause and motion ownership

The product exposed the right high-level motion but allowed two lower-level paths around it. A direct exact searchable selection already used one query, exact active-option proof, and one Enter on the control. Selecting an option from a prior `browser_inspect_control` capability bypassed that manager and used generic option input instead. Separately, a generic click with a postcondition could preselect native keyboard activation for a button-backed ARIA menuitem even though the caller asked to click it.

The form manager now routes both direct targets and inspected option capabilities on an exact editable combobox/searchbox through the same atomic searchable commit when `interaction=auto`. The agent can still deliberately request `interaction=observed_option`. The generic click manager keeps exact menuitem variants, option, and treeitem roles on pointer transport even with a postcondition; keyboard selection remains owned by the control manager.

## Proprioception and regression

Durable traces with exact-target dispatch evidence now derive one categorical `activationTransport`: `keyboard`, `pointer`, or `mixed`. It contains no key value, label, option, selector, geometry, URL, or page content.

Disposable fixtures prove:

- a shorter successful query followed by inspected exact-option selection re-enters the full exact label once and commits once through Enter on the control;
- a button-backed menuitem with a postcondition receives pointer-down/click and no key input;
- opener buttons retain their explicitly preselected guarded keyboard behavior; and
- transport telemetry remains categorical and privacy-safe.

## Resume contract

Reconnect once, rejoin the stable Lounge identity before browser tools, and require MCP/worker/current 0.21.2, host 14, protocol 19, catalog 21, 56 tools, and `restartRequired:false`. Discard old query, popup, option, ref, and inspection capabilities. Do not repeat any operation listed above. From fresh authoritative state, inspect the exact field once, choose the intended observed label within existing user scope, and call `browser_select_option` in auto mode; do not manually chain fill, generic click, and motion.
