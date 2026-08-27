# MCP copy budget

Date: 2026-08-27

Release candidate: Stage5 Browser 0.19.5, MCP host behavior 8.

## Actual feedback

An agent reported that Stage5 Browser's repeated safety and lifecycle prose made internal popup mechanics louder than the user's task. After a selection succeeded while a multi-select intentionally stayed open, the agent pursued formal popup-ownership diagnostics instead of immediately reading the ordinary UI state and choosing a simple next motion.

The failure was presentation, not a need to weaken safety. Dispatch and no-replay rules belong to the phase managers. Default MCP metadata should orient a capable agent, while detailed evidence and diagnostics should appear only in the operation result or on demand.

## Correction

- Server guidance is one 99-word operating contract.
- All 55 repeated tool descriptions are removed; short tool titles and typed schemas remain.
- Successful option operations lead with `outcome`, `selectionSucceeded`, `actionDispatched`, `currentState`, and `nextAction` before detailed evidence.
- `currentState` explicitly reports requested selection state, whether the popup remains open, and whether the control is multi-select.
- An open multi-select returns `select_more_or_dismiss_popup`; it is not mislabeled as failure and does not force closure.

Using a lexical count of agent-visible server instructions plus public tool titles and descriptions, the baseline was 5,846 words and 0.19.5 is 338 words: a 94.2% reduction. The integration regression caps this surface at 584 words, exactly 10% of the recorded baseline.

Safety behavior is unchanged. Possible input is never replayed, authoritative state still controls success, and the complete privacy-safe evidence remains available after the concise summary.

## Evidence

- `tests/mcp-scroll.test.ts` measures the built catalog and rejects budget growth or restored tool essays.
- `tests/mcp-result-shaping.test.ts` proves outcome/state/next action precede implementation evidence.
- `tests/browser-controller/core/control-selection-representation.test.ts` proves a successful selection can truthfully report an intentionally open multi-select popup.
