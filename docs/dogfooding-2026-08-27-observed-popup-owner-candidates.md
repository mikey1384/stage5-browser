# Observed popup-owner candidate judgment

Date: 2026-08-27

Release contract: Stage5 Browser 0.19.0, worker protocol 15, MCP host behavior 7, tool catalog 17, 56 tools.

This is a privacy-safe generic acceptance record. It contains no live URL, account identity, form value, option meaning from the external page, credential, payment data, tax data, private address, document, or screenshot.

## Evidence and root cause

Finance reported that one explicitly authorized passive `inspectControl(revealOptions=false)` still failed after adopting 0.18.0. The durable trace for operation `ca7d1ad7-b6a4-4810-823f-9763adc6e7ca` independently proves:

- manager `form_manager`, command `inspectControl`, worker 0.18.0 / protocol 14;
- one rendered popup and five spatially tied owner candidates;
- terminal `AMBIGUOUS_TARGET` / `ambiguous_control_popup` in 350 ms;
- no action phases and `actionDispatched=false`;
- URLs, selectors, accessible names, values, and page content omitted.

The 0.18 judgment gate accepted only the exact requested DOM control. The live field was exposed as a textbox, while its composite popup owner was a separate button in the bounded candidate set. Deterministic code could not legitimately infer that the button and textbox expressed one semantic field, and the public decision input gave the agent no way to choose the observed button. This was a generic role-identity bottleneck, not evidence that the same-name heuristic should be added to core code.

## 0.19 design

An ambiguous passive result now issues `ownerCandidateId` only for candidates whose role/name pair is unique inside the complete bounded set. The ID is opaque, random, ephemeral, and bound to:

- the exact frame and main-document version;
- the exact requested control role, name, and matching mode;
- one observed candidate role/name identity;
- the current controller capability lane.

The agent chooses from the returned semantic candidates and repeats one passive inspection with:

```text
popupAssociation = {
  owner: "observed_candidate",
  ownerCandidateId: "<one returned opaque ID>",
  basis: "agent_semantic_judgment"
}
```

Stage5 consumes that ID and every sibling from the same decision set. It then re-observes the current popup-owner pool and accepts the choice only when the same document still has exactly one rendered popup and exactly one current candidate with the chosen semantic identity. A stale token, different requested control, duplicate candidate identity, truncated pool, multiple popup surfaces, resolved competing owner, or changed document fails with zero input.

The planning manager reads only the privacy-safe candidate count. `declare_popup_owner_from_observed_candidates` is `needs_preparation` before a candidate set exists, becomes `available` while the current one-use set is live, and returns to `needs_preparation` after it is consumed. Candidate semantics never enter the move map.

The successful inspection retains the resolved agent-declared owner category but not the returned candidate ID. Before a later option input reaches the dispatch gate, the selection baseline re-runs the owner association. If the chosen owner disappeared or changed, selection fails before input and the consumed capability is never replayed. If it remains valid, ordinary exact option-state reconciliation applies; a multi-select popup may intentionally remain open.

The legacy `owner: "requested_control"` input remains compatible, but newly returned candidate IDs are the general path. Core code still makes no business-meaning choice. It establishes structural candidates, uniqueness, freshness, and no-replay boundaries; the agent supplies the semantic judgment within existing user authority.

## Regression boundaries

- `tests/browser-controller/core/control-popup-composition.test.ts` reproduces the textbox-plus-button five-candidate shape, proves the requested textbox is not a candidate, selects the observed button through its opaque ID with zero input, and then proves one exact desired-state option selection while the multiselect stays open.
- `tests/browser-controller/core/control-popup-agent-judgment.test.ts` proves planner availability follows candidate lifetime, changes the chosen owner and proves selection fails before dispatch, binds the token to the exact requested control, and proves the original ID is stale and one-use.
- `tests/mcp-scroll.test.ts` verifies that the fresh MCP schema exposes `observed_candidate` and `ownerCandidateId` through the actual stdio server.
- Existing popup composition, reveal recovery, option state, rebinding, execution telemetry, and action-phase tests continue to cover stronger structural ownership, possible-input no-replay behavior, and privacy-safe categorical traces.

## Live resume boundary

This release and its Lounge notice grant no live-account authority. The preserved workflow stays frozen through the reconnect. A controlling thread may separately authorize one new passive inspection after verifying MCP, worker, and current 0.19.0; host behavior 7; protocol 15; catalog 17; 56 tools; and `restartRequired:false`. All 0.18 refs, candidate observations, and inspection IDs are stale. No historical opener or selection may be replayed.

If a newly authorized passive result returns one rendered popup plus current candidate IDs, the agent may choose one candidate only from that result and perform the second passive association. Any changed, missing, duplicated, truncated, multiple-surface, or possible-input state is a stop. Selection, continuation, submission, private entry, funding, trading, and other account mutations require their own still-valid direct user scope.

## Validation

- Focused final gates passed 9 public-schema/composite-owner tests, 11 planner/candidate-lifetime tests, and 2 adversarial candidate-binding tests.
- `npm test` rebuilt 0.19.0, passed TypeScript and the file-size gate, then passed 305 tests across 83 files with three intentional native-only skips in 262.14 seconds.
- Production TypeScript remains at or below 497 lines; every hand-authored TypeScript file remains below 1,000 lines.
- No native focus-changing, native handoff, or live-account test was run because none of those boundaries changed.
