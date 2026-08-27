# Open multi-select reconciliation dogfooding

Release contract: Stage5 Browser 0.15.11, MCP host behavior 4, worker protocol 12, tool catalog 13, 54 tools. This is a compatible worker update and grants no browser authority.

## Observed boundary

Finance Agent reported one exact custom-option operation, `760c1c20-6aad-4aff-bf3f-335ed0efd448`, after its controlling user authorized that option and explicitly excluded continuation, submission, funding, trading, and private data. Durable privacy-safe telemetry corroborated one trusted click, one dispatch attempt, a failed `selection_representation` check, unavailable selected state, an open popup, and no replay. A later passive form summary reported no selected representation.

The user subsequently explained the widget's intended contract from a separate human interaction: it is a multi-select that adds a selected item while deliberately keeping the option surface open so more items remain available. That observation identifies the generic widget behavior; it does not retroactively prove the outcome of the earlier Stage5 operation. The historical operation remains non-retriable.

## Root cause and invariant

The selection manager previously searched the control itself and one conventional nearby wrapper. A custom field can render its selected chip as a sibling in a larger field-owned region, so the authoritative effect existed outside that narrow observation scope. Conversely, treating popup closure as generic success is unsafe: an open popup is normal for multi-selects, and a closed popup without selected state can still represent a failed selection.

The generic invariant is:

- retain the exact control, popup, and an adaptively isolated field region before dispatch;
- stop field expansion at the first competing interactive field and exclude the owned popup;
- take an exact selected-representation baseline before input;
- dispatch at most one trusted contact;
- accept multi-selection only from selected state or one new exact field-local representation;
- treat popup visibility timeout as unknown, never as proof of closure;
- preserve the original failure and prohibit replay whenever trusted input cannot be reconciled.

The structural search is not capped by a guessed DOM depth or site-specific option count. The action remains bounded where certainty matters: one absolute deadline, one dispatch gate, one retained local ownership region, one privacy-safe evidence schema, and no replay after possible input.

## Regression and telemetry evidence

`tests/browser-controller/core/control-selection-representation.test.ts` covers four independent boundaries:

1. a sibling selected chip proves success while the multi-select popup remains open;
2. the same text newly rendered in a competing field cannot prove selection;
3. popup closure without selected state or a new chip cannot prove multi-selection;
4. a timed-out popup observation remains unknown and cannot manufacture closure.

Existing generic control, baseline-timeout, and execution-telemetry tests verify one-use capabilities, one trusted click, canonical reconciliation checks, and the privacy allowlist. No telemetry schema changes were needed: `selection_representation`, `selected`, `popup_closed`, dispatch count, action phases, and terminal outcome already expose the relevant categorical facts without option names, form values, selectors, URLs, coordinates, or page content. Therefore host behavior remains 4.

The release gate passed `npm run build`, including TypeScript and the file-size contract. One complete headless run passed 73 files and 266 tests with three intentional native focus-changing/handoff skips; its sole failure was the still-0.15.10 plugin manifest. After correcting that metadata, the isolated release-version contract passed. Together the unchanged behavioral run and affected-contract rerun cover all 74 executed files and 267 tests without repeating the three-minute browser suite for a JSON-only version correction.

## Safe adoption

At an existing safe boundary, call `browser_status` and require `worker.version:0.15.11`, `mcp.currentVersion:0.15.11`, host behavior 4, protocol 12, catalog 13, 54 tools, and `restartRequired:false`. An already-running compatible host can correctly keep its loaded `mcp.version` at 0.15.10; do not reconnect solely for that package label. Discard every old inspection ID. Do not replay the reported operation and do not infer current form state from the later human interaction. Any live resume begins with fresh controlling-thread authority and a new authoritative observation; another exact option action requires its own current authorization.
