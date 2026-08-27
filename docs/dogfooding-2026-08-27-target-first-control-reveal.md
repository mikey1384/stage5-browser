# Target-first control reveal from Finance dogfooding

Date: 2026-08-27
Release contract: Stage5 Browser 0.21.1, MCP host behavior 13, worker protocol 18, tool catalog 20, 56 tools.

## Actual evidence first

Finance validated the 0.21.0 compact-result improvement, then reported two remaining control failures with privacy-safe operation IDs:

- `291dfc0b-a368-46cb-bf31-e256d9cb2c26`: `inspectControl` failed `detached` in 489 ms after one trusted pointer-down. Telemetry proves `actionDispatched=true`, `clickDispatched=false`, one dispatch attempt, and no replay. A fresh form summary confirmed no selected role effect.
- `6675a45e-46ec-42fb-a608-5cdfa708af52`: `inspectControl` failed `ambiguous_control_popup_after_reveal` in 1,689 ms. The requested control was freshly active beside its menu, but global popup-owner discovery exceeded its bounded owner inventory before evaluating that exact relationship.

No developer action was performed in the live account. The failures were reproduced with disposable local pages only.

## Generic control invariant

Popup ownership now begins with the exact retained target. Its direct structural relationship is decisive. Otherwise exact DOM focus or expanded state plus spatial adjacency may bind the popup only after a bounded check proves that no different control structurally owns the surface. If that evidence is absent, Stage5 falls back to the existing bounded global structural/focused/expanded/spatial comparison. A large unrelated page inventory can no longer erase stronger exact-target evidence, while a competing structural owner still wins.

Control reveal is a motion choice made before input. `browser_inspect_control` accepts `revealInteraction=auto|pointer|keyboard`; `auto` retains the pointer default. Keyboard reveal prepares and revalidates the exact retained target, proves a zero-popup baseline, sends Enter once, and reconciles the associated popup even if a framework replaces the control after key-down. Pointer and keyboard are never switched after a trusted event. A partial 0.21.0 pointer action remains non-retriable; the new technique is for a fresh action selected before dispatch.

When the exact option label is already known on an editable combobox/searchbox, `browser_select_option(interaction=auto)` remains the shorter path: it queries once, requires exact active-option proof, presses Enter once, and avoids full popup inventory.

## Proprioception and regression

Success and failure traces retain only `controlRevealInteraction=pointer|keyboard` plus the existing categorical dispatch, association, ownership, and reconciliation evidence. Labels, options, values, selectors, geometry, URLs, and page content remain omitted.

Regression fixtures prove:

- a focused exact country control resolves its adjacent popup despite 120 unrelated owner-shaped controls;
- a different explicit structural owner defeats the focused-target shortcut;
- an agent-selected keyboard reveal survives control replacement with one key dispatch and zero pointer input;
- tied, composite, causal, and agent-judgment popup cases retain their existing fail-closed behavior; and
- the built MCP/worker exposes the new input and telemetry contract.

## Resume contract

Existing agents reconnect the MCP host once, immediately rejoin their stable Lounge identity before any browser operation, and require MCP/worker/current 0.21.1, host 13, protocol 18, catalog 20, 56 tools, and `restartRequired:false`. All earlier form, control, popup, ref, and snapshot capabilities are stale. The release grants no account authority and never authorizes replay of the partial pointer operation above. A tester may use keyboard reveal only for a separately current fresh action within its direct controlling-user scope.
