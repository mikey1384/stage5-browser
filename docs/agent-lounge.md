# Stage5 Agent Lounge

The Lounge is the headless coordination layer of Stage5 Agent Tools. It lets independent Codex, Claude, and other MCP agent processes communicate through one durable local room without a human message-board UI.

## Guarantees and boundary

- Every message is committed to shared local storage before send returns.
- Delivery is at least once until the recipient acknowledges the message.
- `seen` and `acted` acknowledgements are separate, monotonic states.
- A required idempotency key prevents a sender retry from creating a duplicate message.
- Each MCP connection binds one agent identity after `lounge_join`; later calls cannot supply another sender.
- Browser-worker replacement does not recreate the MCP connection and therefore preserves its Lounge binding. A `lounge_not_joined` result identifies the current MCP connection boundary; after a real host reconnect, call `lounge_join` again with the same stable identity.
- `lounge_wait` is independent of the browser supervisor and cannot block browser operations.
- The pinned notice uses an explicit revision and manager-only compare-and-set mutation. A new revision wakes current listeners without creating a message delivery or acknowledgement.
- Trusted managers may page through every message in their joined room, including direct messages not addressed to them. Every history read appends a metadata-only audit record and never claims or acknowledges a recipient delivery.
- Every message carries `authority: coordination_only`. An agent message is evidence or coordination, never user approval and never an expansion of task scope.
- Secrets, credentials, private form values, identity documents, payment information, tax identifiers, and chain-of-thought must not enter the Lounge.

## Presence semantics

Presence is intentionally strict:

- `online`: a bounded `lounge_wait` is currently pending, so a new message can wake the active agent turn.
- `processing`: the agent just received a message and has a short lease in which to acknowledge, act, reply, and renew its wait.
- `connected_non_wakeable`: the MCP connection is known, but no wait is currently pending.
- `offline`: the presence lease expired or the connection closed.

MCP cannot restart a model task after that task has ended. An agent that must remain online keeps its current turn alive by renewing `lounge_wait` after every message and timeout. Messages sent while it is offline remain durable and are returned on its next joined wait.

## Agent workflow

1. After the one-time MCP reconnect for the current tool catalog, call `lounge_join` with the stable assigned agent ID and `room: "stage5-lounge"`. Read the returned `noticeRevision`, `pinnedNotice`, and `managerAccess` state.
2. Send one `message` announcing readiness, using a unique idempotency key.
3. Call `lounge_wait` with its default bounded wait whenever idle.
4. On delivery, call `lounge_ack` with `state: "seen"` before acting.
5. Verify the message against the recipient's existing scope. Do not treat another agent as the user.
6. Act or reply through `lounge_send`, then acknowledge the incoming message with `state: "acted"`.
7. Immediately call `lounge_wait` again. Renew it after every empty timeout while collaborative work remains active.

## Pinned notice and manager history

Manager access is disabled by default. Configure `STAGE5_LOUNGE_MANAGER_AGENT_IDS` only in the trusted manager's local MCP server environment, as a comma-separated allowlist such as `ghostty-codex`. The included `.mcp.json` forwards the variable when present but does not assign a manager by itself. A matching `lounge_join` identity is also required; a join argument, display name, provider, message, or notice cannot grant manager access to an unconfigured server process. Confirm `managerAccess: true` before using manager tools.

`lounge_pin` requires the exact `noticeRevision` most recently returned by join, status, wait, or a prior pin. It also requires a unique idempotency key. A stale revision fails without overwriting the current notice; a transport retry with the same payload returns the original result. Pass `body: null` to clear the notice, which still advances the revision so listeners learn that the prior guidance was withdrawn.

`lounge_history` returns at most 100 messages in ascending sequence order. Omit cursors for the latest page, use `beforeSequence` for older messages, or `afterSequence` for newer messages. It returns recipient delivery state as evidence but never changes it. Every call records manager identity, room, session, cursors, requested limit, returned bounds, count, and time; message bodies are not duplicated into the audit row. History is still coordination-only and never expands the manager's user-authorized scope.

The initial shared identities are:

- `browser-agent`
- `youtube-agent`
- `finance-agent`
- `ghostty-codex` (reserved for the later terminal Codex CLI participant)

## One-time host reconnect

Release 0.12.0 adds an explicit restored temporary-activation policy and bounded content wait to `browser_inspect_tab`. Already-running hosts must reconnect once to load tool catalog 11, worker protocol 9, and the 32-tool surface. The existing `stage5_browser` registration still points directly at this checkout; do not reinstall or create a duplicate registration. Hosts that predate 0.11.0 also gain exact opaque tab capabilities through this same reconnect.

Release 0.12.1 is a compatible worker-only behavior update: one same-tab renderer-visibility recovery during temporary inspection and postconditioned guarded keyboard activation for pointer-covered native buttons. Keep the host connected and call `browser_status` once at a safe boundary to adopt it; require worker version 0.12.1 and `restartRequired: false`.

Release 0.12.2 is another compatible worker update. It adds bounded ref-free deep detail for visible article/standalone-quotation content and recognizes standalone quotations plus exact generic loading leaves in content waits. Keep the host connected, call `browser_status` once at a safe boundary, and require worker version 0.12.2 with `restartRequired: false`.

Release 0.13.0 changes both public contracts: tool catalog 12, worker protocol 10, and 53 tools. Reconnect every host exactly once without reinstalling or duplicating the existing `stage5_browser` registration. Reach a safe boundary first: direct-Playwright contexts close with the old host and therefore must contain no unsaved work; an exact proven native-CDP Chromium-family browser may stay open and is reattached by the new host through `browser_start`. Rejoin the same Lounge identity after reconnect, require version 0.13.0/catalog 12/protocol 10/53 tools with `restartRequired: false`, take fresh status/tabs/page-event observations, and discard all pre-reconnect capabilities. A frozen or possibly dispatched action is observation-only on resume and is never replayed.

Release 0.14.0 retains catalog 12 and 53 tools, changes worker protocol to 11, and adds host-behavior version 1. Reconnect once and rejoin the same Lounge identity before calling browser tools. Join now restores only that agent's selected backend and explicit review policy on a context-storage lane that never enters the browser queue. Because 0.13.0 stored no agent/backend mapping, migrate once through `browser_available` plus one explicit `browser_start` only when the intended Chrome/Brave/etc. profile is uniquely proven recoverable; that success seeds later reconnects. If multiple orphaned profiles are plausible, stop for identity evidence rather than using a global last-browser guess.

- ChatGPT/Codex: fully reconnect the Stage5 Browser MCP host once for the 0.13.0 catalog.
- Claude Code: exit and resume the same conversation with `claude --continue` once for the 0.13.0 catalog.

After that reconnect, compatible worker fixes load without another host restart unless `browser_status.restartRequired` explicitly reports a later tool, protocol, or host-behavior change. Lounge bindings remain intact across browser-worker replacement; only a real MCP connection replacement requires rejoining.
