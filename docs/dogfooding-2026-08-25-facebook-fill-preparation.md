# Facebook fill preparation and pre-keyboard detachment

Date: 2026-08-25
Release: 0.7.2 (tool catalog 6, worker protocol 6)

## Dogfooding evidence

Stage5 Browser 0.7.1 received a fresh unnamed Facebook composer textbox capability, then spent the whole bounded operation in `target_preparation`. Operation `685c8e7b-da49-4f1b-af69-d5e91f2c6b62` returned `target_preparation_timeout`, `actionDispatched: false`, `targetState: null`, and no input evidence. Fresh snapshot `8bcb0f25-db36-4afa-a209-0e1e5aa380d2` proved that the editor remained empty and Next remained disabled. Diagnostics operation `b2c821c3-64ab-4469-becc-6f445cf97f97` confirmed that the worker remained healthy.

A separate Coinbase funding-source attempt (`01e1d6a7-56a0-4b0c-9d82-cbb61e16e32b`) showed a native button detaching before any trusted event reached the exact target, but the result incorrectly said `actionDispatched: true`. No menu opened and no funding source was selected. This report is used only as evidence; development and validation use disposable local fixtures and never touch Coinbase or its profile.

## Root causes

`browser_fill_ref` retained only a snapshot ref string. During the later action it resolved that ref again against the entire live frame and rediscovered the current modal by scanning every visible dialog. On a large reactive page, either scan could consume the complete preparation budget before Stage5 obtained target state.

Native-button Enter activation observed pointer, mouse, and click events but not keydown/keyup. A completed Playwright transport could therefore be treated as dispatched even when no exact-target keyboard event was proven.

## Fix

- A semantic snapshot now retains the exact eligible editor handle and exact modal/document root handle behind each fillable ref.
- `browser_fill_ref` uses only those one-use handles. It validates the same document and retained scope containment, then editability, viewport preparation, and target state without a live ARIA-ref resolution or modal rescan.
- Fill diagnostics now include `fillPreparationStep`: `reference_validation`, `editor_capability`, `scope_validation`, `editor_validation`, `viewport_preparation`, `target_state`, or `completed`.
- Exact click probes now retain trusted keydown and keyup evidence in addition to pointer, mouse, and click evidence.
- A native-button target that detaches before an exact-target keyboard event is definite no-dispatch. A keydown that reaches the exact target before React replaces it remains partial input and non-retriable.

## Regression coverage

Headless fixtures prove that:

- a multiline Korean draft plus URL fills an unnamed modal contenteditable without calling `snapshotRoot` or resolving an `aria-ref` during the action;
- replacing the retained modal after the snapshot fails promptly at `scope_validation` with null target/input evidence and no text entry;
- a keydown-triggered native-button replacement remains `actionDispatched: true`, `clickDispatched: false`, and non-retriable; and
- a native button replaced while the press is focusing it reports `actionDispatched: false`, `clickDispatched: false` when no key event reached the exact target, even when a misdirected event was intercepted.

The complete headless suite passes with 127 tests and 3 opt-in native tests skipped. No signed-in browser, Facebook state, Coinbase state, private field, save, or submission was touched.
