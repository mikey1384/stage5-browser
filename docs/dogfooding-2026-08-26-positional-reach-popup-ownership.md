# Positional reach and popup ownership dogfooding

Release: 0.15.4 (compatible worker update; tool catalog 13, worker protocol 12, 54 tools)

## Evidence

- YouTube operation `239ca60d-fde7-4e63-b386-8628e5e05d48` on worker 0.15.3 spent 1,283 ms in preparation and terminated with zero dispatch. Its categorical viewport evidence reported one attempt, zero movement, no nested or document surface, and `completedInViewport=false`. The exact button was visible and enabled but belonged to an oversized fixed modal that exposed no movable surface.
- Finance retained the live page after the older partial opener and adopted 0.15.3. Its one authorized passive funding-control inspection used `revealOptions=false`, dispatched no input, and returned no association because two open portal popups exposed neither an explicit ARIA relation nor a current focus/expanded owner.
- Manager telemetry independently corroborated the historical Finance partial dispatch and the new YouTube zero-dispatch boundary. No live account action or native focus-changing validation was used to derive either fix.

## Generic correction

- Exact native-button reach is now positional: scrollable surfaces remain first, while an unscrollable off-viewport button can use guarded keyboard activation only when the caller supplied a non-null bounded postcondition. The exact-target dispatch probe permits off-viewport keyboard events but still requires visible, enabled, connected ownership and blocks misdirected input. Null-postcondition contact remains a zero-input failure.
- Popup ownership now has one ordered source of truth: explicit/structural relation, spatially plausible focus, spatially plausible expanded state, then one unique geometric anchor. Geometry is used only ephemerally; no coordinates, names, values, or content enter telemetry. Multiple plausible anchors fail closed.
- `viewportPreparation.reachStrategy` and `inspection.reveal.associationProof` expose categorical proprioception so agents can distinguish physical reach and ownership without relying on narrative claims.

## Regression contract

- A fixed oversized modal with no scroll surface rejects ordinary pointer contact with zero input, then succeeds exactly once through postconditioned keyboard reach for both role and snapshot-ref targeting.
- Two unlinked portal popups can be inspected passively when each has one unique anchor, with zero opener/preparation input.
- One popup near two equally plausible controls fails as `AMBIGUOUS_TARGET` with zero input.
- Existing exact-ref, postcondition, virtualization, partial-effect, control, form, and execution-telemetry suites remain green. Native focus-changing tests stay excluded because foreground activation is not this boundary.

## Safe adoption

- Adopt worker 0.15.4 only at an existing safe boundary and require `restartRequired=false`; discard all old refs and inspection IDs.
- YouTube's 0.15.3 action proved zero dispatch. One fresh exact modal-dismiss attempt is permitted only within its existing user authorization and only with the exact close postcondition.
- Finance must preserve the current page and use one passive `revealOptions=false` inspection after adoption. Continue only when `popupOpened=true` and `associationProof` is non-null. The historical partial opener is never replayed, and this recovery grants no authority to select, close, correct, save, submit, fund, trade, or enter private data.
