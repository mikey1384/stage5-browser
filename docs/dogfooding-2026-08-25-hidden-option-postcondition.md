# Exact hidden-option postcondition

Date: 2026-08-25

Release: 0.9.0 (tool catalog 8, worker protocol 7, 29 tools)

## Dogfooding boundary

The Finance workflow exposed an exact funding-source `option` inside an already-open selection surface. The owner separately authorized one exact option selection, but the fresh semantic snapshot exposed no stable selected marker, control label/value, or next-step marker suitable for a bounded postcondition. The option action was not dispatched. Its authority remains unused.

The browser core needed a generic privacy-safe effect boundary that did not invent site-specific semantics or weaken the no-replay contract.

## Contract

Both click tools now accept `postcondition.expectedHidden` with the same exact role/name/frame shape as `expectedVisible`.

- Zero exact semantic matches pass.
- One exact match that is no longer visible passes.
- One visible match fails.
- Multiple matches, a missing/detached frame, or an observation failure remain `observed: null` and fail closed.
- The returned check contains only `kind: "visible"`, `expected: false`, and `observed: false | true | null`. It never returns the supplied semantic name.
- A confirmed click with an unmet hidden check returns `POSTCONDITION_FAILED` and is not replayed.
- If exact-target pointer/key input is partial but the requested hidden state is observed inside the reserved reconciliation window, the effect is terminal success while `clickDispatched` and every trusted-event boolean remain truthful. No replacement target or fallback receives more input.

Hidden-state proof is deliberately narrow. It proves only the caller-requested semantic disappearance boundary together with exact-target dispatch evidence. It does not prove that a field was durably persisted, that a later form step completed, or that any save/continue/submit action occurred.

## Regression fixtures

Disposable loopback pages cover:

1. one exact option receives one click, its listbox becomes hidden, and the postcondition passes without returning the option name;
2. pointerdown/mousedown reaches the exact option, the option detaches before click, hidden-state reconciliation succeeds with `clickDispatched: false`, and no fallback or replay occurs;
3. one confirmed option click leaves the option visible, so the operation returns `POSTCONDITION_FAILED` with one click total; and
4. the click creates two identical visible options, so ambiguity remains `observed: null` and cannot masquerade as hidden.

The MCP boundary test also requires both public click schemas to expose `expectedHidden`.

## Contract rollout and safe resume

This release changes both the public MCP input schema and the MCP-to-worker command contract. A connected host must reconnect once; compatible hotload is intentionally insufficient. Browser actions fail closed while the old host reports that stale contract, but its already-loaded Lounge join/send/wait/ack/status methods remain available so agents can coordinate the reconnect without human relay. After reconnect, verify `browser_status` reports Stage5 Browser 0.9.0, tool catalog 8, worker protocol 7, 29 tools, and `restartRequired: false` before any selection attempt.

The Finance agent may then resume only under its still-current owner authorization:

1. take one fresh read-only snapshot;
2. use the exact newly observed option ref once with `expectedHidden` matching that same observed role/name/frame;
3. if the hidden check passes, take a fresh read-only snapshot and report only the privacy-safe boundary evidence;
4. if any input is partial and hidden state is not proven, stop and inspect—never replay; and
5. do not save, continue, submit, or perform another private/account action without separate authority.

No live option click, save, continue, submission, or other account mutation was used to build or validate this fix.
