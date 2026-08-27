# Framework-replaced popup rebind dogfooding

Release contract: Stage5 Browser 0.15.13, MCP host behavior 4, worker protocol 12, tool catalog 13, 54 tools. This is a compatible worker update and grants no browser authority.

## Finding

After adopting 0.15.12, Finance followed the required two-step authorization sequence. A fresh passive inspection succeeded with a fully observed, already-open custom popup and no opener input. After separate exact selection authority, the retained control remained connected but the retained popup capability no longer rendered. Selection failed in its `observe` phase with `reason=control_popup_changed`.

Privacy-safe telemetry for operation `248be0ed-8417-44fd-9c71-1c0cdc0f088a` proved a 227 ms owning action, `dispatchState=not_attempted`, zero dispatch attempts, and `actionDispatched=false`. No live retry was performed.

## Generic invariant

Control and popup capabilities are independent framework-replacement boundaries. A definitively non-rendered retained popup may be replaced read-only only when:

- the document and exact control capability remain current, or the control independently passes the strict 0.15.12 exact rebind gate;
- current popup discovery resolves exactly one popup associated with that exact control;
- the newly resolved popup is authoritatively rendered;
- a current field-local baseline is available;
- the intended option is still one exact semantic match inside the current popup at final preparation.

An unknown popup observation, missing or ambiguous association, hidden replacement, document change, or missing exact option fails before input. Stage5 never replays the opener to recover a popup.

## Implementation and telemetry

`selection-baseline.ts` now treats proven control replacement and proven popup replacement symmetrically while retaining separate handles and disposal ownership. A successful read-only capability repair records the existing categorical action recovery reason `target_changed_before_input` with zero completed dispatch attempts. The durable execution trace therefore exposes that the hand repositioned before contact without adding semantics, geometry, page content, or a host-owned telemetry field.

## Regression evidence

The focused rebinding fixture proves:

1. a replaced control can rebind read-only before one exact option dispatch;
2. a replaced popup can rebind read-only before one exact option dispatch;
3. a merely closed popup is not reopened and the opener count does not increase;
4. both successful repairs emit categorical `target_changed_before_input` phase evidence;
5. stalled/unknown handles, representation isolation, open multi-select reconciliation, and no-replay behavior remain closed.

No live account was used to validate the fix.

## Adoption and safe resume

At an existing safe boundary, keep the MCP connection and call `browser_status`. Require worker/current version 0.15.13, host behavior 4, protocol 12, catalog 13, 54 tools, and `restartRequired:false`; a compatible host may retain its prior loaded package label. Discard old inspection IDs.

Inspection `6a4425b3-2784-4242-b19c-7938db034709` and selection `248be0ed-8417-44fd-9c71-1c0cdc0f088a` remain non-retriable. This release authorizes no live inspection, option selection, save, continuation, submission, funding, trading, or private entry. Resume requires fresh direct controlling-thread authority for a new inspection and separate current authority for one exact selection.
