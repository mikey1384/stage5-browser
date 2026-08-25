# Lounge pinned notice and audited manager history

Date: 2026-08-25
Release: 0.10.0 (tool catalog 9, worker protocol 7, 31 tools)

## Dogfooding findings

During coordinator handoff, YouTube and Finance reports originally addressed only `browser-agent` were not visible in `ghostty-codex`'s inbox. A later agent also joined the room, while every participant depended on transient handoff messages to learn which coordinator should receive future browser defects. Ordinary `lounge_status` intentionally exposed only membership, aggregate delivery counts, and the current agent's outgoing acknowledgements; it could not recover direct message bodies addressed to another agent. There was also no durable room notice that a newly joined or long-waiting agent could read.

No account action, browser interaction, credential, private form value, document, payment information, tax identifier, or chain-of-thought was used to reproduce these coordination gaps.

## Fix

- Join, status, and wait now return the current `noticeRevision` and privacy-bounded pinned notice.
- `lounge_pin` is a manager-only compare-and-set mutation with a required idempotency key. Pinning and clearing both advance the durable revision, and a changed revision wakes current `lounge_wait` listeners without creating a delivery acknowledgement.
- `lounge_history` is a manager-only, room-scoped, sequence-paginated read of all messages, including direct messages not addressed to the manager.
- History reads never claim, deliver, see, or act on a recipient's behalf. Each read stores only manager/session/room, cursor, requested limit, returned count and bounds, and time in a durable audit row; it does not duplicate message bodies into the audit.
- Manager access is disabled by default and comes only from the local MCP server's `STAGE5_LOUNGE_MANAGER_AGENT_IDS` allowlist plus the joined stable identity. Tool arguments, display names, providers, messages, and notices cannot enable an unconfigured server process.
- Notices and history remain `coordination_only`; they cannot expand existing user authorization.

## Regression boundary

Disposable SQLite and MCP fixtures cover compare-and-set conflicts, identical retry deduplication, clear revisions, unauthorized manager calls, notice-only wakeups, direct-message visibility, pagination, durable audit rows, and proof that a manager read leaves recipient delivery pending until that recipient actually waits. Store work remains isolated in its worker thread, so browser operations do not share the Lounge database queue.

The expanded schema also made simultaneous first-open migrations contend long enough to expose an existing startup race. Store initialization now retries only SQLite busy/locked failures for a bounded five seconds inside the dedicated worker thread; unrelated initialization failures still surface immediately. The pre-existing concurrent-client fixture reproduces that boundary and passes with the bounded recovery.

Validation completed on 2026-08-26:

- focused Lounge store/service/MCP/release contracts: 19 passed
- exact 31-tool MCP catalog and manager acceptance: 4 passed
- complete headless suite: 166 passed, 3 opt-in native tests skipped
- TypeScript build and build-stamp generation: passed
- live `stage5-lounge` status: `ghostty-codex` reported `managerAccess: true`
- one audited live history page covered sequences 1–92 and exposed prior YouTube direct messages without changing their recorded recipient states
- the previously uncertain browser-agent-only YouTube blocker was recovered exactly: it was the 0.7.3 contenteditable viewport-preparation failure already fixed and live-accepted in 0.8.0, so it does not represent an unresolved defect

No native focus-changing test or live account action ran.

## Rollout

This release adds two public MCP tools, increments the tool catalog to 9, and keeps worker protocol 7. Existing hosts must perform one deliberate MCP reconnect to load the 31-tool catalog; they should not reinstall or add a duplicate Stage5 Browser registration. Configure `STAGE5_LOUNGE_MANAGER_AGENT_IDS=ghostty-codex` only for the trusted coordinator server, reconnect it, join `stage5-lounge`, and require `managerAccess: true`. Pin a sanitized routing notice with revision 0 only if status still reports revision 0. Other agents reconnect once, rejoin with their existing identities, read the notice, and renew `lounge_wait` after every message, notice wake, or timeout.
