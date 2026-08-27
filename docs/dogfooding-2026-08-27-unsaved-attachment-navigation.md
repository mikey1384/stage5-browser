# Unsaved attachment navigation from Finance dogfooding

Date: 2026-08-27
Release contract: Stage5 Browser 0.21.4, MCP host behavior 16, worker protocol 21, tool catalog 23, 56 tools.

## Actual evidence first

Finance reported that two file selections reached their requested site-visible completion state, but the page's save action remained unavailable. Three later sidebar clicks succeeded. Returning to the document surface showed no retained attachments. The report contained no filenames, paths, document contents, account values, or other private data.

Privacy-safe traces confirmed the boundary. Operations `d8b53299-1b00-4424-9c3b-7fca7ad5a33d` and `b2624469-ee5a-465a-b306-e2a130f7f67e` each made one `setInputFiles` dispatch and completed reconciliation. Operations `ddd9a3a2-bfc9-404b-b7a1-79dec5297bd3`, `25784f79-2e58-433f-9933-4b70b2a1bae3`, and `d13eb521-b891-4bd7-aafe-32ba9c4b3aec` each made one successful exact-ref click. Read-only operation `a04b308a-6171-4426-9fea-5f36d4c6dced` observed the later state. There was no timeout, worker recovery, duplicate dispatch, or replay.

## Root cause and invariant

The transfer result distinguished file selection from upload processing, but it did not distinguish upload-processing completion from persistence by the surrounding form or application. Once the page consumed and cleared an input, a later agent saw no durable compact signal that navigation might discard completed-but-unsaved attachments.

The generic invariant is now:

- any possible file selection creates a bounded page-scoped `possible_unsaved_file_selections` state containing only a file count and whether the current revision needs acknowledgement;
- every page summary and the upload result surface that state, while the upload result explicitly warns that processing completion is not workflow persistence;
- a click or exact motion is gated only when the calling agent declares `intent=navigate`; direct URL navigation, history navigation, and exact tab close use the same navigation gate;
- the first navigation for the current risk revision stops before dispatch unless the agent sets `acknowledgeStateRisk=true`; acknowledgement records the agent's decision and permits the fresh action without Stage5 inferring business meaning;
- another file selection creates a new revision and requires a new decision;
- a proven document boundary clears the state;
- on native Chromium control, the value-free state is retained only with the exact opaque target and document identities, so compatible worker replacement restores it only for the same document.

This is a positional safety signal, not a semantic policy engine. Stage5 does not decide whether the agent should save, leave, upload, submit, or abandon the work. It makes a known irreversible transition visible at the action boundary and lets the agent choose.

## Proprioception and regression

Execution traces retain only the caller's categorical `declaredIntent`, whether `stateRiskAcknowledgementRequested` was supplied, `unsavedStateRisk=possible_unsaved_file_selections`, and `stateRiskAcknowledged=true|false`. They retain no filename, path, label, URL, selector, content, target identity, or document identity. Older traces cannot establish which intent or acknowledgement a caller supplied; future dogfooding can verify that this agent-discretion boundary was actually exercised rather than infer it from a successful click.

`tests/mcp-file-upload.test.ts` uses a disposable local SPA. It proves that a completed input returns the compact risk, an unacknowledged exact navigation click has false dispatch, a newly snapshotted acknowledged click dispatches once and satisfies its URL postcondition, and both decisions appear categorically in fresh-host telemetry. `tests/page-state-risk-manager.test.ts` proves acknowledgement is scoped to one file-selection revision. `tests/native-worker-handoff.test.ts` proves the state survives exact CDP detach/reattach with the same document. `tests/native-control-channel.test.ts` proves the retained record accepts only the bounded categorical shape.

## Resume contract

Reconnect once, rejoin the stable Lounge identity before browser tools, and require MCP/worker/current 0.21.4, host 16, protocol 21, catalog 23, 56 tools, and `restartRequired:false`. Discard all older refs, snapshots, file inputs, controls, popups, options, and inspections. Never replay the reported upload or navigation operations. Existing account and document authority is unchanged.

For a new authorized workflow, inspect fresh state. After any file selection, treat `processing.state=completion_observed` as processing evidence only. If `page.stateRisk` is present, choose whether to persist or leave. Use the page's save/persist action when appropriate; otherwise pass `acknowledgeStateRisk=true` only on the one fresh navigation the controlling agent deliberately chooses.
