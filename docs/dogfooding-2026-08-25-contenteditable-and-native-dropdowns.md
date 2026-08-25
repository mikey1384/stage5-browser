# Contenteditable deadlines and native custom-dropdown activation

Date: 2026-08-25
Release: 0.7.1 (tool catalog 6, worker protocol 6)

This is an ordinary compatible worker update. It does not add or change an MCP tool schema or worker command contract, so a connected 0.7.0 host does not require an MCP reconnect.

## Dogfooding failures

Facebook exposed one unnamed active contenteditable through a valid fresh snapshot ref. `browser_fill_ref` accepted it but exceeded the supervisor deadline, returned only generic `OPERATION_TIMEOUT`, triggered worker recovery, and left no page-action diagnostic. A fresh snapshot proved the editor remained empty, its placeholder remained visible, and its continuation control remained disabled.

A separate Coinbase custom-dropdown button accepted trusted pointer-down and mouse-down, then React detached the exact node before pointer-up/click. Stage5 correctly reported partial input and prohibited replay, but the workflow was stranded in an incomplete transition. The button did not advertise the popup ARIA attributes used by the earlier keyboard-activation guard.

No live Facebook or Coinbase action was used to develop or validate these fixes.

## Root causes and fixes

- Snapshot validation resolved the correct editor, but dispatch returned to the `aria-ref` locator. Focus-time application mutations could therefore strand Playwright in ref re-resolution. The fill now pins and dispatches through the already validated exact element handle.
- Preparation and dispatch previously received independent full timeouts. Fill now uses one absolute deadline with a reserved evidence-finalization window.
- `browser_fill_ref` now journals a privacy-safe `fill_ref` action and reports the terminal phase: `target_preparation`, `page_activation`, `fill_dispatch`, `event_verification`, `value_matching`, or `completed`. Target state and input/change/value-match evidence are retained without the supplied value.
- Multiline contenteditables are compared as logical block and line-break text. This handles browser-created paragraph markup without weakening the exact-value postcondition.
- Every native HTML button now uses the existing exact guarded Enter transaction. This preserves standard button semantics while avoiding React replacement between pointer down and pointer up, including custom dropdowns that omit popup ARIA. Non-native ARIA buttons remain on the guarded pointer path, preserving partial-input evidence and no-replay behavior.

## Regression acceptance

Disposable browser fixtures prove that:

1. an unnamed modal contenteditable accepts multiline Korean text plus a URL through its fresh ref and returns no supplied text in results or diagnostics;
2. a stalled exact-handle fill returns structured no-input evidence before its outer deadline, leaves the editor empty, and records `fillPhase: fill_dispatch` instead of triggering worker recovery;
3. a plain native custom-dropdown button whose mouse-down handler would replace itself opens through one trusted keyboard-generated click with zero pointer-down/mouse-down events and zero replacement; and
4. a non-native ARIA button that detaches during pointer input remains partial, non-retriable, and incapable of fallback or replay.
