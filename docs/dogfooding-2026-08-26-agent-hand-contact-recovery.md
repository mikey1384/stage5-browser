# Agent-hand contact recovery

Date: 2026-08-26
Release: 0.15.2 (compatible worker update; tool catalog 13, worker protocol 12, 54 tools)

## Telemetry-confirmed failures

- Finance operation `f2aa7fc4-74e2-492e-a46f-4e585c6111c3` spent one dispatch attempt in `form_manager`. A trusted key-down reached the exact custom option, key-up/click did not, and the wrong framework-active first option became selected. The trace also omitted the controller's partial-effect checks.
- YouTube operation `213295b6-a186-4aa9-9c95-22dada766e2a` spent 3,988 ms in preparation with zero dispatch attempts. The exact button intersected the browser window but remained clipped outside its modal's scroll viewport.
- xAI operation `11d8ea26-94ec-4156-961e-4a8dd60098ec` spent 1,292 ms in preparation with zero dispatch attempts and ended `reference_semantic_rebind_ambiguous` after an exact row ref fell back to two document-wide `Row actions` semantics.

The traces contain no URL, selector, accessible name, value, page content, credential, private handoff data, or account identifier. Live account pages were not touched during investigation.

## Governing fixes

1. Ordinary exact native buttons and custom options now use pointer contact. Keyboard activation remains available only when an explicit postcondition makes it a guarded recovery primitive. A target that detaches after pointer-down remains possible input and is never replayed.
2. Viewport preparation checks clipping ancestors before document geometry. It may perform one bounded step on an `auto`, `scroll`, `overlay`, or programmatically scrollable `hidden` ancestor, including the unique modal root, then re-inspects authoritative actionability before contact.
3. Snapshot refs are one-use motor capabilities. Click and motion retain the exact node before page preparation, revalidate that same element afterward, and only then fall back to replacement resolution. Replacement resolution is first constrained to a privacy-fingerprinted article, table row, or list item; document-wide semantics remain the final fail-closed fallback.
4. Partial-effect failures publish their categorical reconciliation list under canonical `checks`, while retaining the prior compatibility field. `browser_execution_traces` can therefore show selected representation, selected state, and popup-closure observations after possible input.

## Regression evidence

- A two-option button fixture proves Enter would choose and detach the active first option, while Stage5 contacts the exact intended option with one pointer sequence and observes the intended selected state.
- A clipped unique-modal fixture proves the snapshot ref begins `visible=true`, `inViewport=false`, the modal scrolls, and exactly one trusted click reaches the button.
- Duplicate article/table-row fixtures prove exact click and hover retain the intended second action, and a replaced table-row action rebinds only within its original row.
- Existing partial-pointer, postconditioned-keyboard, activation-loss, virtualization, custom-control, and motion suites remain fail-closed/no-replay.
- Focused interaction/control/telemetry gate: 14 files and 60 tests passed.
- Full repository gate after the code changes: 69 files and 243 tests passed, 3 files/tests skipped; the sole failure was the plugin manifest still carrying version 0.15.1. After aligning that manifest, the focused release-metadata test passed 1/1 and the build/file-size gate passed, yielding 70 passed files and 244 passed tests with the same 3 opt-in native skips. The unchanged 172-second browser fixture set was not repeated for a deterministic metadata-only edit.

No native foreground-changing test and no live Facebook, Coinbase, xAI, payment, funding, submission, credential, or private-field action ran.

## Safe resume

- All agents: keep the MCP host connected, call `browser_status` at an existing safe boundary, and require worker 0.15.2, protocol 12, catalog 13, 54 tools, and `restartRequired: false`. Discard every old ref/capability.
- Finance: do not replay either partial keyboard selection and do not automatically correct the wrong observed option. Inspect authoritative control/form state from a fresh capability under the existing review-only scope; stop before any save, continuation, submission, funding/trade, or private field.
- YouTube: both reported modal clicks proved zero dispatch. One fresh attempt is safe only if existing user authority still covers dismissing that same modal and a fresh modal-scoped snapshot proves one exact target; otherwise leave it untouched.
- xAI: the consequential deletion was already completed manually. Do not perform another live console action for validation. Use the generic row capability only in a separately authorized future workflow.
