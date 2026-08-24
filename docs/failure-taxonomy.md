# Failure taxonomy

Stage5 Browser treats failures according to the layer that owns recovery. A generic retry is not a recovery strategy.

| Layer | Examples | Detection | Recovery owner | Default response |
| --- | --- | --- | --- | --- |
| MCP transport | host disconnect, malformed protocol output | transport close or protocol error | MCP host/server | close cleanly; never write non-protocol data to stdout |
| MCP build lifecycle | server artifact rebuilt after process start, stale tool catalog | runtime fingerprint and build metadata | MCP host | return `MCP_RESTART_REQUIRED`; restart/resume the host session |
| Supervisor | queue corruption, worker startup failure | failed readiness handshake | supervisor | reject with a structured terminal error |
| MCP/worker protocol | stale MCP starts a worker from a newer build | versioned initialization handshake | MCP host | reject with `MCP_RESTART_REQUIRED`; never attempt worker recovery loops |
| Worker process | deadlock, event-loop stall, crash | hard deadline, process exit, IPC disconnect | supervisor | terminate the process group and spawn a clean worker |
| Browser process | crash, orphan, profile lock | Playwright disconnect or failed launch | supervisor and worker | close or kill the owned process tree; relaunch the dedicated profile |
| Browser context | unexpected close, unusable persistent context | context close event or operation error | worker | recreate the context; preserve only the dedicated profile |
| Page/renderer | page crash, closed target, unresponsive renderer | page events or failed health probe | worker | discard the page and create a new one; escalate to worker restart if needed |
| Navigation lifecycle | commit succeeds but readiness stalls, client redirect follows, or HTTP response is non-2xx | URL commit, bounded readiness/stabilization, redirect observation, and response status | worker and caller | return committed state plus structured warning/redirect evidence instead of declaring workflow success |
| Frame lifecycle | observed frame detaches or belongs to an old tab | opaque frame-ID lookup plus attachment check | caller | return `TARGET_NOT_FOUND`; inventory frames again before retrying |
| Human authentication lifecycle | native browser still running, profile locks remain, or the current process exit is abnormal/unavailable | native-process exit code/signal, known profile locks, advisory Chromium marker value/mtime comparison, and effective evidence source | user and worker | never force-close or edit profile state; accept zero exit/no signal/zero locks, or offer one deliberate unlocked-profile override without repeating login |
| Authentication launch identity | native and controlled executable, backend, user-data root, or profile partition differ | configured binding plus the canonical Profile Path observed from the running Chromium instance | worker | return `AUTH_NOT_PERSISTED`; do not ask the user to repeat login in an untrusted window |
| Authentication storage continuity | target-origin cookie-key presence changes across native exit, controlled start, or target load, or a non-root post-login route is not reached | offline database metadata, live context metadata reduced to non-value key facts, non-exported hashes, restored-target flag, webdriver observation, exact route postcondition, and bounded preview | worker and caller | return `AUTH_NOT_PERSISTED` for verified loss; retain the controlled page, report `lossBoundary` and non-causal `automationCorrelation`, and do not replay login. Never infer live absence from open SQLite |
| Authentication boundary evidence | exact human clicks and native-window requests are not instrumented, or storage survives while the site still renders signed out | sanitized before/after route and keyed semantic fingerprints plus bounded semantic preview | caller | treat storage and boundary comparisons as evidence only; stop on signed-out controls and require a fresh full snapshot to prove signed-in state |
| Modal inspection | portal controls exceed document snapshot depth, or several dialogs compete | unique visible-modal root and ambiguity count | worker and caller | preserve one ref map for the unique modal; otherwise warn and inspect the document without choosing a modal |
| Element targeting | missing or ambiguous role/name | locator count and actionability checks | caller | return candidates/error; never click an arbitrary first match |
| Snapshot reference lifecycle | ref is stale, reused, absent, or from another document/frame | latest snapshot ID, document version, and observed-ref membership | caller | return `TARGET_NOT_FOUND`; take a fresh snapshot |
| Local file preflight | path is relative, missing, unreadable, a symlink/directory, or exceeds the input's multiplicity | filesystem metadata plus the observed file-input constraints; file contents are never read | caller | return `INVALID_FILE` or a structured pre-dispatch failure without consuming an otherwise valid capability |
| File-selection outcome | the input accepts the action but does not retain matching privacy-minimized `FileList` metadata, or the command fails after dispatch may have begun | exact observed element handle plus post-dispatch name/size/count comparison | caller | return `POSTCONDITION_FAILED` or outcome-unknown evidence; inspect the composer and never replay without a fresh snapshot proving no attachment exists |
| Upload processing | attachment is retained but progress, service completion, or error state is unclear | semantic progress controls, optional caller-supplied completion/error markers, fresh preview, and temporally bounded network counts | caller and service adapter | report `completion_observed`, `in_progress`, `error_observed`, or `unverified`; never equate file selection or HTTP success with upload completion |
| Click outcome | click dispatches but URL/selection/visibility postcondition is unmet | bounded postcondition probe | caller | return `POSTCONDITION_FAILED` with `clickDispatched: true`; inspect before any retry |
| Click actionability | target is hidden, disabled, out of viewport, detached, or covered | sanitized pre/post-failure target state and Playwright outcome | caller | return `OPERATION_FAILED` with dispatch certainty when known; inspect the page diagnostic before correcting or retrying |
| Consequential ambiguity | click or submission times out after it may have fired | timeout after dispatch | caller and service adapter | do not retry; verify authoritative external state first |
| Dynamic-feed boundary | viewport reaches the current bottom after prior content growth, but no explicit feed-end marker is visible | per-step geometry/content-growth history plus an optional semantic end marker | caller | report `dynamic_content_stalled` or `geometric_boundary_unconfirmed`; do not claim the timeline is complete |
| Authentication/site policy | CAPTCHA, expired login, bot rejection | explicit private bootstrap, fresh post-resume page state, and service response | user or service adapter | hand the native dedicated window to the user, follow its backend-specific leave-open/normal-close instruction, resume, then verify with a fresh snapshot; or switch to API/CLI |

`browser_recover` recovers the worker boundary only. Its terminal result explicitly reports either `worker_recovered_browser_running` or `worker_recovered_browser_stopped`; neither outcome claims that an MCP tool catalog was reloaded.

## Recovery invariants

- Read-only operations may be retried only after the failed layer has been reset.
- Consequential operations are never retried merely because their response timed out.
- Killing a worker must kill the browser descendants it owns.
- Recovery never attaches to or modifies the user's default Chrome profile.
- Recovery never kills a human authentication browser, removes its profile locks, or rewrites browser shutdown preferences.
- Every operation ends as `succeeded`, `failed`, or `timed_out`; there is no permanently pending state.
- Evidence identifies the failed layer without recording page contents or sensitive inputs.
