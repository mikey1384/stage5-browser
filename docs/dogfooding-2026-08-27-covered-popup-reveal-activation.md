# Covered popup reveal activation

Date: 2026-08-27

Release contract: Stage5 Browser 0.19.1, worker protocol 15, MCP host behavior 7, tool catalog 17, 56 tools.

This is a privacy-safe generic acceptance record. It contains no live URL, account identity, field or option meaning, form value, credential, payment or tax data, private address, document, selector, or screenshot.

## Evidence and root cause

After adopting 0.19.0 and successfully exercising the observed popup-owner candidate path, Finance reported a different ordinary custom-control failure. Durable trace `b98dd39d-0450-45ad-baa7-a19853ffa8dd` independently proves:

- manager `form_manager`, command `inspectControl`, worker 0.19.0 / protocol 15;
- the action reached `click_by_role` preparation after one nested vertical movement and pointer-contact recovery;
- the exact target was visible, enabled, and in the viewport, but bounded hit testing reported `receivesPointerEvents:false` with a covering `span` category;
- terminal `OPERATION_FAILED` / `target_covered_after_scroll` after 2,120 ms;
- `actionDispatched:false`, `clickDispatched:false`, and zero dispatch attempts;
- URLs, selectors, accessible names, values, coordinates, and page content omitted.

Exact hit testing already accepts ordinary, slotted, and shadow-composed descendants. The categorical trace did not prove that the covering span was such a descendant, so weakening hit testing or clicking the cover would be an unsafe diagnosis. The actual phase mismatch was that popup reveal owns an authoritative zero-surface baseline plus exact post-input popup reconciliation, while click preparation previously recognized only a public `ClickPostcondition` as permission to use guarded native keyboard activation. `inspectControl` uses a manager-specific reconcile function, so it was incorrectly forced into pointer-only preparation even when an exact native button was definitively covered.

## 0.19.1 design

The click action plan now requires its responsible manager to declare one activation policy:

- `pointer_only` for actions whose keyboard semantics could target framework-managed active state;
- `postconditioned_native_keyboard` for the existing explicit public-postcondition path;
- `postconditioned_native_keyboard_fallback` when pointer contact remains preferred and keyboard is allowed only for a definitively covered native button under manager-owned reconciliation.

Popup reveal declares the fallback policy. It still uses the pointer whenever exact contact exists, preserving partial-pointer/no-replay reconciliation. It may use Enter only when the exact retained target is an `HTMLButtonElement`, hit testing is definitively false, the page is the verified input target, the exact dispatch probe is installed, and the reveal manager owns the zero-rendered-surface baseline plus one associated rendered-popup postcondition. The probe must observe trusted exact-target keyboard/click evidence; the popup result is then reconciled through the ordinary action phases.

Custom option selection explicitly remains `pointer_only`. A button-shaped option can have active-descendant keyboard semantics that select a different option, so the existence of a strong selection reconciliation function is not permission to use a different motion. Covered non-native controls also remain zero-input failures. No overlay, sibling, role substitute, or historical opener is clicked.

## Regression boundaries

- `tests/browser-controller/core/control-reveal-pointer-contact.test.ts` reproduces a nested-scroll native popup opener fully covered by a pointer-active visual sibling. Before the fix it fails with `target_covered_after_scroll`; after the fix it dispatches one exact trusted native keyboard activation, opens the associated popup, and increments the opener count exactly once.
- The same file covers an identically obscured non-native `role=button` and proves `target_covered_after_scroll`, `actionDispatched:false`, unchanged expanded state, hidden popup, and zero opener count.
- `tests/browser-controller/core/control-reveal-recovery.test.ts` proves an unobstructed opener still uses pointer semantics and reconciles a popup opened by partial pointer input without replay.
- `tests/browser-controller/core/control-options.test.ts` proves exact button options remain pointer-only so keyboard active-option behavior cannot redirect selection.
- `tests/browser-controller-hit-point.test.ts` continues to prove exact ordinary and composed-tree descendant contact, alternate hit points, and postconditioned covered-native activation.

## Resume boundary

0.19.1 is a compatible worker correction: host behavior 7, protocol 15, catalog 17, and 56 tools do not change. An adopted 0.19.0 host does not reconnect. At a safe boundary, require worker and current version 0.19.1 with `restartRequired:false`, discard the failed inspection and all refs derived from it, and resume only within still-valid authority in the controlling user thread.

The reported zero-dispatch operation is not replayed. This release record and any Lounge message grant no live observation, navigation, selection, correction, continuation, submission, private entry, funding, trading, or other account action.

## Validation

- The Finance-shaped regression failed before the implementation at the expected pre-dispatch preparation boundary and passed afterward.
- Focused control, reveal-recovery, option-selection, exact-hit-point, action-phase, and execution-telemetry gates passed 58 tests across 10 files after the activation policy was narrowed.
- Definitive `npm test` rebuilt 0.19.1, passed TypeScript and the file-size gate, then passed 307 tests across 84 files with three intentional native-only skips in 275.03 seconds.
- Production TypeScript remains under the 500-line target and every hand-authored TypeScript file remains below the enforced 1,000-line ceiling.
- No native focus-changing, native handoff, or live-account test was run because none of those boundaries changed.
