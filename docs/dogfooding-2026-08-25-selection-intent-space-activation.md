# Selection-intent Space activation

Date: 2026-08-25
Release: 0.8.2 (tool catalog 7, worker protocol 6, 29 tools)

## Dogfooding evidence

On Stage5 Browser 0.8.0, one separately authorized Coinbase custom-dropdown opener received a trusted Enter keydown on the exact native button. The application detached that node before keyup or click, and the caller's visible-menuitem postcondition remained absent. Stage5 correctly stopped with `actionDispatched: true`, `clickDispatched: false` and never replayed, but the workflow had no safer generic opener path. Version 0.8.1 repaired only cross-worker evidence continuity; it did not change selection behavior.

No further Coinbase input was authorized or attempted. The dedicated browser and preserved form remain untouched.

## Root cause

The shared click engine selected Enter for every native HTML button. That avoids React pointerdown replacement and remains the safest default for ordinary button activation. For a selection opener, however, the caller had already supplied stronger intent: a bounded postcondition explicitly required a menu/list option to become visible. Native buttons also define Space as a single keyboard activation, and a disposable reproduction proved that an Enter-specific keydown re-render could be avoided by choosing Space before any input.

This is not a retry strategy. Stage5 must choose exactly one key from the caller's already-authorized intent before dispatch and must never try the other key or pointer input afterward.

## Fix

- Native HTML buttons still default to one exact guarded Enter activation.
- When `expectedVisible.role` explicitly names `menuitem`, `menuitemcheckbox`, `menuitemradio`, `option`, or `treeitem`, role and ref clicks select Space before input as the one guarded selection-intent activation.
- The same exact-target keydown/keyup/click probe, page-activation gate, deadline, postcondition reconciliation, and evidence-finalization reserve remain authoritative.
- If Space produces the requested visible option, the operation succeeds once with normal trusted-click evidence or truthful partial-input evidence.
- If the node detaches and the option is absent, the original partial-input failure remains terminal. Stage5 sends no Enter, pointer, replacement-node click, or other fallback.
- Non-native ARIA buttons remain on the guarded pointer path.

This is a compatible behavior update. Tool catalog 7, worker protocol 6, and all 29 MCP tools are unchanged, so a connected host adopts 0.8.2 automatically without an MCP reconnect.

## Regression coverage

Disposable headless fixtures prove that:

- a native selection opener whose Enter handler would replace it receives Space instead, emits no pointer input, produces one trusted click, and exposes the requested menuitem;
- the same preselection applies to a fresh snapshot ref whose expected visible target is an option;
- a Space keydown that detaches the exact opener without exposing the option remains partial and non-retriable, with zero Enter, pointer, click, or replacement-click fallback; and
- ordinary native buttons and popup buttons without an explicit option-visibility postcondition continue to use Enter.

## Safe resume contract

No live retry is authorized by this fix. If the owner later grants one fresh opener attempt, first verify `browser_status` reports worker 0.8.2 with `restartRequired: false`, take one fresh semantic snapshot, and use the exact observed opener once with a bounded `expectedVisible` postcondition naming the intended non-private menu/list option. If that postcondition passes, take a fresh snapshot before any separately authorized option click. If it fails after any key evidence, stop and inspect read-only state; never replay the opener.

This release repairs the current generic opener path but does not add the broader first-class select/multiselect transaction described in the protected Coinbase report. That report therefore remains untracked and must not be deleted.
