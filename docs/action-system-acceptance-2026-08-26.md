# Stage5 Browser 0.13 action-system acceptance

Release contract: 0.13.0, tool catalog 12, worker protocol 10, 53 MCP tools.

This document is the privacy-safe replacement acceptance record for the discarded raw business-form dogfooding report. It records generic browser invariants, source owners, and disposable-fixture regressions only. No live account action, address, credential, tax value, payment value, document, query string, or private form value was used or retained.

## Product and architecture gate

Stage5 Browser is the agent's hand. Its useful unit is not a website-specific patch but a composable movement with truthful proprioception. The complete worker command surface is assigned exhaustively in `src/protocol/command-contracts.ts`; the complete 53-tool public surface, including host recovery and Lounge coordination, is assigned in `src/mcp/tool-contracts.ts` from the canonical names in `src/mcp/tool-names.ts`. Manager responsibilities, technique vocabulary, context layers, and the canonical action loop are declared in `src/protocol/capabilities.ts`.

Every consequential physical input follows:

```text
observe → plan → preflight → prepare → dispatch once → reconcile → finalize
                         └── one return to preflight only after proven zero input
```

Semantic choice belongs to the agent within the user's existing authority. Deterministic code owns structural identity, actionability, exact target binding, dispatch evidence, state reconciliation, privacy, and replay safety. Core code does not infer business meaning from labels, URLs, regexes, or site names.

The one controller runtime owns session context. Tab IDs, frame IDs, document versions, snapshots, control/form capabilities, exact handles, and action evidence have explicit narrower lifetimes. Only privacy-minimized ownership, terminal operation timing, page-lifecycle risk, transfer/dialog manifests, and Lounge coordination cross a durable boundary.

## Reported defect acceptance

| Finding | Governing invariant and implementation | Disposable regression evidence | Status |
| --- | --- | --- | --- |
| Unsaved form state disappeared around compatible worker replacement | Direct-Playwright replacement is deferred while connected. Proven native-CDP replacement reattaches the same browser and exact target. The private control record carries only opaque target/document identities, so a replacement during the detach gap emits durable `all_unsaved_form_state_may_be_lost` evidence before further work; an unavailable exact target fails instead of selecting another page. Same-document history is excluded. Owners: `src/supervisor/worker-lifecycle.ts`, `src/native-control-channel.ts`, `src/controller/lifecycle/native-attach.ts`, `src/controller/lifecycle/page-events.ts`. | `tests/supervisor.test.ts`; `tests/browser-controller/core/page-lifecycle.test.ts`; `tests/browser-controller/core/diagnostic-persistence.test.ts`; `tests/browser-controller/handoff/reattachment.test.ts` | Fixed and covered across attached and detach-gap replacement |
| Controller-selected page stayed hidden despite accepted activation | `browser_activate_selected_page` reconciles the exact selected renderer, document focus, and—only when required—the verified owned native application. An accepted activation request is never proof; unresolved visibility blocks input. Owners: `src/controller/observation/tab-activation.ts`, `src/controller/input/activation.ts`. | `tests/browser-controller-tab-capabilities.test.ts`; `tests/browser-controller/click/native-activation.test.ts`; `tests/browser-controller/click/role-activation.test.ts` | Fixed and covered headlessly; no native focus-changing smoke was run |
| A short internal deadline took minutes to reach the caller | Consequential work can be reserved before dispatch and queried without replay. Terminal creation, persistence completion, and response creation are retained in the operation registry; the supervisor enforces the outer wall-clock deadline. Owners: `src/operations/registry.ts`, `src/supervisor/execute.ts`, `src/mcp/context.ts`. | `tests/operation-registry.test.ts`; hard-deadline cases in `tests/supervisor.test.ts`; real stdio MCP deadline/recovery in `tests/mcp-operation-deadline.test.ts` | Fixed and covered end to end through MCP response creation |
| A click opened exactly one new page but only the original-page URL was checked | Click reconciliation reports `newPage`, `newPageCount`, and supports opt-in `expectedNewPageUrl`; multiple new pages remain ambiguous. Owners: `src/controller/action/click-executor.ts`, `src/controller/input/postconditions.ts`. | New-page case in `tests/browser-controller/click/postconditions.test.ts` | Fixed and covered |
| Date fill hid the required HTML format | Date fields fail before input with privacy-safe `invalid_date_format; expected YYYY-MM-DD`; an unambiguous ISO date is accepted. Owner: `src/controller/input/fill-evidence.ts`. | Date cases in `tests/browser-controller/core/fill-preparation.test.ts` | Fixed and covered |
| An exact autocomplete option lost its semantics between observation and dispatch | `browser_inspect_control` retains one-use exact control, popup, and option capabilities; `browser_select_option` accepts exact semantics or those opaque capabilities and proves selected/closed state. Owners: `src/controller/controls/inspection.ts`, `selection.ts`, `options.ts`. | `tests/browser-controller/core/control-options.test.ts` | Fixed and covered |
| An offscreen/reactive popup opened after partial input while the action reported only failure | Partial trusted input enters reconciliation. If the exact requested visible/selected/hidden state is observed, the terminal result preserves partial dispatch evidence and reports the effect; otherwise it remains non-retriable. Owners: `src/controller/input/postconditions.ts`, `src/controller/action/click-executor.ts`. | `tests/browser-controller/click/popup-no-replay.test.ts`; `tests/browser-controller/click/target-replacement.test.ts` | Fixed and covered |
| A uniquely observed editor transiently returned zero matches | Role fill performs one bounded read-only re-resolution only while dispatch is proven false; ref fill remains bound to the retained exact handle and scope. No input is replayed. Owners: `src/controller/input/fill-role.ts`, `fill-ref.ts`. | Transient unique-editor case in `tests/browser-controller/core/fill-preparation.test.ts` | Fixed and covered |
| Worker replacement invalidated refs without workflow-level warning | Every replacement transition explicitly returns `allReferencesInvalid`; native reattachment preserves page state but not worker-owned capabilities. Durable page events separately identify document replacement and unsaved-state risk. Owner: `src/supervisor/worker-lifecycle.ts`. | `tests/supervisor.test.ts`; `tests/browser-controller/core/page-lifecycle.test.ts` | Fixed and covered |

## Missing-capability acceptance

| Requested capability | Generic implementation | Regression evidence | Status |
| --- | --- | --- | --- |
| Single select and multi-select | `browser_select_option` handles native selects, custom popups, autocomplete-like options, structural reveal, and bounded popup scrolling. `browser_select_options` refreshes capabilities between physical selections, proves selected state, and never toggles an already-selected option. | `tests/browser-controller/core/control-options.test.ts` | Implemented |
| Focused control inspection/list options | `browser_inspect_control` returns only the exact control's type/state and bounded options with opaque one-use IDs. | `tests/browser-controller/core/control-options.test.ts` | Implemented |
| Redacted form state and staged fill | `browser_form_summary` returns labels/types/required-valid/value-presence without values. `browser_apply_form_plan` applies up to 20 exact steps, records completed steps, and stops without replay at the first unconfirmed outcome. | `tests/browser-controller/core/form-workflow.test.ts` | Implemented |
| Field-scoped private handoff | Request/resume tools yield one exact observed field and return only completed/unchanged/validation-error state. Private values never return to agent-visible context or durable storage. | `tests/browser-controller/handoff/private-field.test.ts` | Implemented |
| Stable tabs and new-tab intent | Opaque session tab IDs, exact select/inspect/close, opener evidence, exactly-one-new-page reconciliation, and explicit expected-new-page URL replace index-only control. | `tests/browser-controller-tab-capabilities.test.ts`; `tests/browser-controller/click/postconditions.test.ts` | Implemented |
| Application-safe review mode | `normal` and `review_only` modes use deterministic command class plus agent-declared intent across clicks, key/pointer motions, fills, selections, checked state, and staged form plans. Submit, terms, account change, external communication, persistence, and financial intent can be blocked before dispatch without regex inference. | `tests/action-policy-manager.test.ts` | Implemented |

## Active Lounge regressions

| Reported failure | Generic remedy | Regression evidence | Status |
| --- | --- | --- | --- |
| Another custom-control popup was already open, so the intended control opener changed state but its expected-hidden condition failed | Before revealing a control, Stage5 may dismiss exactly one rendered competing popup only when it has one structural owner. Escape dispatch has trusted evidence and a close postcondition; ambiguity or failed closure stops before the intended opener. | Competing-popup case in `tests/browser-controller/core/control-options.test.ts` | Fixed locally; reporting action remains frozen until the 0.13 release handoff |
| Temporary read-only tab activation could not prove restoration of the prior selected draft tab | Restoration now gets one bounded second attempt on the same exact selected page only. A second failure remains closed, and no URL/title/index fallback is permitted. | Restoration-recovery cases in `tests/browser-controller-tab-capabilities.test.ts` | Fixed locally; reporting action remains frozen until the 0.13 release handoff |

## Complete hand vocabulary

The current generic families cover lifecycle, bounded perception, URL/history navigation, exact tabs, click/ref action, hover, focus, key press, double-click, context-click, drag-and-drop, vertical/horizontal document and nested scrolling, text/date fill, checked state, single/multi-select, staged form work, observed file input, upload-state evidence, durable download capture, expected/unexpected JavaScript dialogs, screenshots, field/authentication private handoff, review policy, operation recovery, durable page lifecycle, and agent coordination.

This does not promise a bespoke command for every future widget. It promises that ordinary variation composes from these techniques, and that a genuinely missing motion is added once at the generic manager boundary with a disposable regression—not patched per site.

## Validation gate

Focused regressions run without rebuilding unchanged code. The complete release suite remains serial, gives each run an automatically removed root under `/private/tmp/stage5-browser-tests.noindex`, and bounds fixture teardown with exact disposable-process proof so indexing or one delayed browser exit cannot contaminate later tests. Seventeen abandoned directories from the old per-user temp runner (46 MB) were verified process-free and removed.

Final post-change release evidence:

- `npm test`: build, typecheck, file-size gate, and complete headless suite passed in 140.43 seconds;
- test files: 63 passed, 3 skipped, 66 total;
- tests: 224 passed, 3 skipped, 227 total;
- all production TypeScript files are 497 lines or fewer; all hand-authored TypeScript files remain below the enforced 1,000-line ceiling;
- public MCP catalog and exhaustive manager-owner contract: 53 unique tools;
- native focus-changing, native handoff smoke, and live-account tests were deliberately excluded because their boundaries were not required for this release.
