# Causal popup surface sets

Date: 2026-08-27

Compatible worker: Stage5 Browser 0.19.3, worker protocol 15, MCP host behavior 7, tool catalog 17, 56 tools.

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

## Generic phase-owned correction

The existing causal gate remains the source of truth: popup reveal must have proven zero rendered surfaces before preparation, and the exact opener must then have possibly received one input. Under only that gate, association first collapses nested roots. More than one outermost root is accepted as one causal surface set only when:

- every root is connected through the composed tree within a bounded ancestor search;
- one common envelope is structurally popup-like: absolute, fixed, sticky, a popover, an ARIA modal, or an open dialog;
- no root reaches that envelope through a lower popup-like branch.

The last condition prevents a broad overlay from merging independent positioned panels. `body`, `html`, `main`, and `form` are never popup envelopes. Raw `renderedPopupCount` remains unchanged for telemetry. Independent portals, missing proof, and unbounded discovery remain closed. No label, role meaning, URL, regex, score, or site name participates in the structural decision.

0.19.3 handles the already-open state without inventing historical causality. Existing per-partition deterministic ownership remains higher priority. Only when that does not resolve the requested control may the proven common envelope expose a bounded current owner-candidate set. The agent may choose one uniquely named observed candidate through the existing document-bound, one-use `ownerCandidateId`; Stage5 then re-resolves the exact envelope and surface set before retaining options. Candidate semantics remain absent from telemetry. This path dispatches no browser input and cannot dismiss, re-open, select, or replay anything.

## Regression and rollout boundary

`tests/browser-controller/core/control-popup-causal-surface-set.test.ts` proves three directions:

- one positioned portal containing seven sibling semantic groups yields one `post_dispatch_unique` capability, all seven options, and exactly one opener input;
- the same already-open seven-group set yields one-use bounded owner candidates and then a zero-input `agent_declared` capability;
- two independently positioned panels inside one fixed overlay remain a post-dispatch failure after exactly one opener input.

The adjacent popup-owner, composition, reveal, selection-rebinding, representation, and timeout matrix passed 34 tests across eight files. It includes a broad positioned portal whose separated option partitions retain their stronger deterministic per-surface owner. This focused gate is intentionally before the broad suite because the next decisive evidence is a fresh reporter operation and its privacy-safe trace. Historical operations are never replayed.

0.19.3 changes no host, protocol, catalog, or tool contract. An adopted 0.19.0 host loads the compatible worker at a safe boundary without reconnecting. Require worker/current 0.19.3 with `restartRequired:false`, discard the failed inspection and every derived ref, and perform a new passive inspection only if the reporting agent's direct controlling thread already authorizes it. The release and Lounge grant no observation, navigation, selection, correction, continuation, submission, private entry, funding, trading, or other account authority.
