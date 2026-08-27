# Available moves and agent judgment

Date: 2026-08-27

Release contract: Stage5 Browser 0.18.0, worker protocol 14, MCP host behavior 7, tool catalog 16, 56 tools.

## Reported boundary

A passive Finance control inspection found one already-open popup and five structurally plausible owner controls. Stage5 correctly dispatched no input, but its deterministic spatial ranking could not choose the intended owner and exposed no safe way for the browsing agent to contribute the semantic judgment available from the current page context. Repeating geometry heuristics would make the hand more rigid without making the meaning more truthful.

The page remains frozen. No live opener, option selection, form continuation, account mutation, or native foreground test was used to develop or validate this release.

## Governing split

The runtime and the agent have different jobs:

- deterministic managers own current identity, connectivity, containment, visibility, actionability, document freshness, lifecycle and control mode, dispatch evidence, deadlines, replay rules, and authoritative resulting state;
- the agent owns semantic equivalence, tactic choice, and interpretation of user intent within authority already granted in its controlling thread;
- neither side may silently absorb the other role. An algorithm may not infer business meaning from labels, regexes, scores, coordinates, URLs, or site names, while agent judgment may not override physical contradiction, stale capability, missing authority, a private boundary, or possible-input no-replay evidence.

This rule applies across browser managers. When physical facts cannot decide meaning, a manager should return the smallest bounded current candidate set and, where safe, expose an explicit auditable agent-decision input. It should not add a site-specific exception or force a human relay for an ordinary choice already within the agent's scope.

## Generic implementation

### Current move map

`browser_available_moves` is owned by the planning manager. It derives several current techniques from the canonical command contract and one privacy-safe controller context snapshot. Each move reports:

- stable technique identity and responsible manager;
- current availability or safe preparation needed;
- public tools that can establish missing structural prerequisites;
- phase system, expected effect class, bounded cost, authority boundary, and replay consequence;
- caller obligations such as an exact current target, a fresh document capability, a bounded postcondition, or agent-chosen option meaning.

Each row is a tactic the caller can intentionally select through a public tool or parameter. Automatic ownership reconciliation, backend-specific resume mechanics, and other internal phase steps remain visible through their owning manager and telemetry where useful, but do not consume duplicate slots in the bounded move list.

The view contains counts only for current tab, snapshot, ref, scroll, control, option, and form capabilities. It contains no URLs, titles, labels, selectors, coordinates, field values, page content, or inferred business purpose. Listing moves never starts a browser, changes page state, creates authority, or retains a new action capability. Blocked moves are omitted by default and can be filtered by manager or availability for diagnosis without returning an unbounded catalog.

The structural prerequisite groups now live on the same canonical command contracts as manager, technique, phase, dispatch, and replay ownership. The planner does not maintain a second command-precondition table.

### Explicit semantic popup-owner decision

When passive inspection observes exactly one rendered popup whose current structural owner candidates remain tied, the failure returns at most twelve role/name candidate observations with categorical focused, expanded, structural, spatial, overlap, and covered-state evidence. It also states whether the exact requested control is in that current candidate set. No input is dispatched.

The caller may perform a fresh passive inspection with:

```text
popupAssociation = {
  owner: "requested_control",
  basis: "agent_semantic_judgment"
}
```

Stage5 accepts that declaration only when the fresh document still has exactly one rendered popup, deterministic ownership is genuinely ambiguous, and the exact requested control is one of the bounded current candidates. A resolved competing owner, multiple surfaces, a missing or changed control, a replaced document, possible opener input, or an unavailable candidate set stays closed. The resulting association proof is `agent_declared`. Later option input is a separate one-shot action with its own authority, preflight, dispatch, reconciliation, and no-replay boundary.

This also preserves real multi-select behavior: a successful option selection may leave its popup open. Reconciliation requires desired selected state or a new exact field-local representation; popup closure is never the sole success criterion.

### Explicit startup and handoff modes

Public `browser_open` now requires an explicitly running browser. It returns `BROWSER_NOT_READY`, `reason=browser_stopped`, and `actionDispatched=false` without launching when stopped. The move map exposes `browser_available` and `browser_start` as its safe preparation path.

Private-field and authentication handoffs centrally restrict commands to their exact status/resume families plus the read-only move and policy views. The move map derives the same control-mode availability. A planning response therefore cannot advertise a motion the worker gate would accept only accidentally.

## Telemetry

The host retains `agent_declared` only as a categorical popup-association proof attached to the owning operation. Candidate roles and names are intentionally excluded from durable execution traces, along with URLs, selectors, coordinates, values, page content, arguments, and external account identity. `browser_available_moves` itself produces a normal trace owned by `planning_manager`, with `read_only_observation`, dispatch boundary `none`, idempotent replay, and no action dispatch.

Because this changes the host trace allowlist, public tool catalog, and worker command contract, it is a full reconnect boundary rather than a compatible worker patch.

## Regression evidence

- `tests/browser-controller/core/control-popup-composition.test.ts`: five tied Finance-shaped owner candidates; initial passive ambiguity with zero input; explicit current agent declaration; option inventory; open multi-select preserved.
- `tests/execution-telemetry.test.ts`: categorical `agent_declared` proof retained while candidate semantics are omitted.
- `tests/available-moves.test.ts`: stopped, running, capability-rich, review-only, private-field, and authentication-release contexts; stable bounded ordering and preparation paths.
- `tests/browser-controller/core/available-moves.test.ts`: disposable browser fixture proves capability counts are current and semantic content is absent.
- `tests/mcp-available-moves.test.ts`: fresh MCP host proves public tool mapping, stopped-open no-launch behavior, bounded delivery, and planning-manager telemetry.
- `tests/command-manager-contract.test.ts`: every worker command and public tool has one owner; every technique and technique-specific prerequisite belongs to that canonical contract.

The focused changed-boundary gate passed 31 of 31 tests across 10 files. A fresh read-only host probe then exposed two non-failing planning-quality defects: stopped-browser output described starting merely to stop or switch (and waiting for a future download with no browser), while automatic status and backend-resume mechanics consumed duplicate move slots. Pointless paths now report blocked with no enabling tools, direct start remains available, and only caller-selectable tactics enter the list; the focused correction gates passed 13 and 14 tests across 2 files. The definitive post-correction complete headless gate passed 302 tests across 82 files in 204.43 seconds with three intentional native-only skips; build, typecheck, and the file-size gate passed in the same run. No live account or focus-changing native boundary was exercised.

## Safe adoption and Finance resume

Reconnect once and require MCP, worker, and current version 0.18.0; worker protocol 14; host behavior 7; catalog 16; 56 tools; and `restartRequired:false`. Rejoin the same Lounge identity and discard all old refs, option IDs, inspection IDs, and move observations.

The historical opener and every possibly dispatched selection remain non-retriable. This release grants no live account authority. Finance may use the explicit owner-declaration path only after its controlling user thread authorizes a new passive observation, and only if a fresh result again exposes the requested control in the bounded current candidate set. Any option selection, correction, continuation, submission, funding, trading, private entry, or account action requires its own existing direct authority and fresh authoritative state.
