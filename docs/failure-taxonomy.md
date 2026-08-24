# Failure taxonomy

Stage5 Browser treats failures according to the layer that owns recovery. A generic retry is not a recovery strategy.

| Layer | Examples | Detection | Recovery owner | Default response |
| --- | --- | --- | --- | --- |
| MCP transport | host disconnect, malformed protocol output | transport close or protocol error | MCP host/server | close cleanly; never write non-protocol data to stdout |
| Supervisor | queue corruption, worker startup failure | failed readiness handshake | supervisor | reject with a structured terminal error |
| Worker process | deadlock, event-loop stall, crash | hard deadline, process exit, IPC disconnect | supervisor | terminate the process group and spawn a clean worker |
| Browser process | crash, orphan, profile lock | Playwright disconnect or failed launch | supervisor and worker | close or kill the owned process tree; relaunch the dedicated profile |
| Browser context | unexpected close, unusable persistent context | context close event or operation error | worker | recreate the context; preserve only the dedicated profile |
| Page/renderer | page crash, closed target, unresponsive renderer | page events or failed health probe | worker | discard the page and create a new one; escalate to worker restart if needed |
| Navigation lifecycle | commit succeeds but `load` never arrives | URL commit plus bounded readiness probe | worker | return committed state with a warning instead of a false timeout |
| Frame lifecycle | observed frame detaches or belongs to an old tab | opaque frame-ID lookup plus attachment check | caller | return `TARGET_NOT_FOUND`; inventory frames again before retrying |
| Element targeting | missing or ambiguous role/name | locator count and actionability checks | caller | return candidates/error; never click an arbitrary first match |
| Consequential ambiguity | click or submission times out after it may have fired | timeout after dispatch | caller and service adapter | do not retry; verify authoritative external state first |
| Authentication/site policy | CAPTCHA, expired login, bot rejection | visible page state and service response | user or service adapter | request the smallest user-only action or switch to API/CLI |

## Recovery invariants

- Read-only operations may be retried only after the failed layer has been reset.
- Consequential operations are never retried merely because their response timed out.
- Killing a worker must kill the browser descendants it owns.
- Recovery never attaches to or modifies the user's default Chrome profile.
- Every operation ends as `succeeded`, `failed`, or `timed_out`; there is no permanently pending state.
- Evidence identifies the failed layer without recording page contents or sensitive inputs.
