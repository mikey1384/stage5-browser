# Causal popup surface sets

Date: 2026-08-27

Release: Stage5 Browser 0.19.5, worker protocol 15, MCP host behavior 8, tool catalog 17, 56 tools.

This privacy-safe acceptance record contains no live URL, account identity, control or option meaning, form value, credential, payment or tax data, private address, document, selector, coordinates, or page content.

## Actual usage evidence first

Finance operation `3e714d96-a4f4-4961-8c3b-b1740735f6cd` on worker 0.19.1 independently showed:

- manager `form_manager`, command `inspectControl`, and the canonical action phases;
- one exact opener dispatch after the earlier pointer obstruction was cleared;
- `actionDispatched:true` with the never-after-possible-dispatch replay policy;
- seven rendered semantic popup surfaces, with no proven owner or surface association;
- terminal `ambiguous_control_popup_after_reveal` after 9,082 ms;
- URLs, selectors, names, values, coordinates, and page content omitted from telemetry.

The reporting agent then answered a privacy-safe categorical question from already observed state: the seven roots were internal semantic groups in one logical popup, not separate panels. Only after that real feedback and trace were checked was a disposable fixture added. It failed before the implementation with the same post-dispatch association error.

After 0.19.2 loaded, the reporting agent correctly did not dismiss or replay the historical opener. Snapshot operation `ade3fce9-fbf4-44b9-a619-e2f1ef025cc1` was a 147 ms `perception_manager` read with no dispatch boundary. It showed that the logical popup remained open. A separately authorized passive control inspection, operation `e052e6ad-b238-4a9a-b9b9-1dd34fdfd21d`, then failed after 2,997 ms with `actionDispatched:false`, no actions, `renderedPopupCount:7`, and no association proof. That actual zero-input continuation failure—not a speculative test—drove 0.19.3.

The 0.19.3 actual-use gate exposed the next lifecycle boundary before the broad suite. Operation `d95d8d5f-9f42-4699-9877-1026a5f7e0a9` failed in 210 ms as `control_not_found`, with `actionDispatched:false`, no actions, and no popup association phase. From only its existing tool transcript, the reporter confirmed that the exact textbox/name/exact tuple was byte-for-byte identical to the successful-resolution 0.19.2 call and that no popup association had been supplied. The page remained frozen. This proved that the composite widget had removed its requested textbox node while leaving the logical popup and a surviving owner control present. That real result drove 0.19.4.

The 0.19.4 actual-use gate then returned one semantically wrong owner candidate with zero input. Operation `78cad255-376b-4103-b4fc-14abfbb1e107` recorded five candidates in the active spatial tier, but coverage ranking exposed only one and the old trace could not independently report exposed or issued-capability counts. The reporting agent correctly refused the candidate and kept the page frozen. This proved that physical ranking had crossed into an agent-owned meaning decision and drove 0.19.5.

## Generic phase-owned correction

The existing causal gate remains the source of truth: popup reveal must have proven zero rendered surfaces before preparation, and the exact opener must then have possibly received one input. Under only that gate, association first collapses nested roots. More than one outermost root is accepted as one causal surface set only when:

- every root is connected through the composed tree within a bounded ancestor search;
- one common envelope is structurally popup-like: absolute, fixed, sticky, a popover, an ARIA modal, or an open dialog;
- no root reaches that envelope through a lower popup-like branch.

The last condition prevents a broad overlay from merging independent positioned panels. `body`, `html`, `main`, and `form` are never popup envelopes. Raw `renderedPopupCount` remains unchanged for telemetry. Independent portals, missing proof, and unbounded discovery remain closed. No label, role meaning, URL, regex, score, or site name participates in the structural decision.

0.19.3 handles the already-open state without inventing historical causality. Existing per-partition deterministic ownership remains higher priority. Only when that does not resolve the requested control may the proven common envelope expose a bounded current owner-candidate set. The agent may choose one uniquely named observed candidate through the existing document-bound, one-use `ownerCandidateId`; Stage5 then re-resolves the exact envelope and surface set before retaining options. Candidate semantics remain absent from telemetry. This path dispatches no browser input and cannot dismiss, re-open, select, or replay anything.

0.19.4 removes the assumption that the originally requested composite DOM node must survive that decision. When exact control resolution proves zero matches or a pre-inspection detach with no input, Stage5 performs only a bounded read of already-rendered popup surfaces. It offers current owner candidates only when those surfaces form one logical root or one proven common popup envelope; independent positioned panels still produce no recovery capability. The agent—not a role mapping, label heuristic, regex, or score—may identify a semantically equivalent surviving owner. Stage5 consumes the one-use decision, re-resolves that exact current owner, binds the whole logical surface set, and retains the surviving owner as the canonical control for later revalidation. If the owner or popup disappeared, changed, became ambiguous, or would need to be opened again, the passive continuation fails with `actionDispatched:false`. It never replays or substitutes browser input.

0.19.5 keeps physical proof tiers as the bound but stops using distance or coverage to suppress viable semantics when the requested meaning is unresolved. The complete bounded active tier is exposed for agent judgment. Trace schema 2 self-identifies the loaded host and records only requested-control resolution, active/exposed/issued counts, truncation, judgment availability, and decision consumption alongside existing categorical proof and dispatch facts. Candidate semantics and IDs remain excluded.

## Regression and rollout boundary

`tests/browser-controller/core/control-popup-causal-surface-set.test.ts` proves six directions:

- one positioned portal containing seven sibling semantic groups yields one `post_dispatch_unique` capability, all seven options, and exactly one opener input;
- the same already-open seven-group set yields one-use bounded owner candidates and then a zero-input `agent_declared` capability;
- when the requested textbox has disappeared, the surviving owner can be chosen through a one-use decision and all seven groups remain available with zero input;
- if that popup vanishes before the decision is consumed, Stage5 refuses with zero input even when reveal was requested;
- a five-candidate active spatial tier exposes all five one-use choices rather than one ranking-selected semantic guess;
- two independently positioned panels inside one fixed overlay remain a post-dispatch failure after exactly one opener input.

Focused 0.19.5 regressions prove the complete five-candidate pool, privacy-safe schema-2 trace parsing, concise result ordering, and an intentional open multi-select popup. The built fresh-host integration passed, followed by the complete headless gate: 313 tests passed across 85 files with three intentional native-only skips. Historical operations are never replayed.

0.19.5 changes host behavior and requires one MCP reconnect. Finance verified MCP/worker/current 0.19.5 with host behavior 8, protocol 15, catalog 17, 56 tools, and `restartRequired:false`, discarded old capabilities, and resumed ordinary work under its controlling thread's existing authority. No developer-only passive acceptance step is required. The release and Lounge grant no observation, navigation, selection, correction, continuation, submission, private entry, funding, trading, or other account authority.
