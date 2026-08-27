# Durable per-identity Lounge work notes

Release contract: Stage5 Browser 0.17.0, MCP host behavior 6, worker protocol 13, tool catalog 15, and 55 tools. Every MCP host reconnects once and rejoins its same stable identity. Lounge state remains coordination-only and grants no browser or external-account authority.

## Requirement

Durable messages preserve the conversation, but a replacement agent should not have to reconstruct its predecessor's working position from an inbox transcript. Each stable Lounge identity therefore owns one small current-state handoff that is returned automatically on join and updated whenever material work state changes.

The canonical fields are:

- `role`
- `currentState`
- `lastCompleted`, nullable
- `blocker`, nullable
- `nextSafeAction`

Each field is non-empty when present and has a canonical character bound; the complete normalized note is also bounded to 8 KiB of UTF-8. It must contain only sanitized coordination conclusions. Credentials, private or account content, form values, documents, payment or tax information, and chain-of-thought are forbidden.

## Persistence and concurrency

`lounge_set_work_note` accepts the five fields, the caller's last observed `expectedRevision`, and a required idempotency key. The SQLite worker performs one immediate transaction:

1. an exact duplicate idempotency retry returns the original revision;
2. reuse of the key for another payload fails;
3. a stale expected revision fails without overwriting current state; and
4. a successful mutation advances only that room and stable identity by one revision.

The current note is durable without limit. Only the newest 256 idempotency receipts per identity are retained, so frequent checkpoints cannot grow a second unbounded history. A retry older than that bounded window cannot overwrite anything: its stale expected revision fails against the current note.

Joining the same identity from another MCP connection returns the exact current note and supersedes the older session. The old writer is fenced by the existing session owner check. Browser-worker replacement does not affect the note or its MCP connection, and the Lounge storage lane never enters the serialized browser queue.

Every agent receives its own note through `lounge_join` and `lounge_status`. Ordinary agents receive `memberWorkNotes:null`; only a locally allowlisted manager receives current member notes. Manager access cannot be claimed through an agent ID, display name, provider, message, notice, or work note.

## Operating rule and regression

The active agent updates its note after every material start, completion, blocker, scope change, or next-safe-action change, then keeps `lounge_wait` pending whenever idle. The note is a handoff checkpoint, not an event log, an authorization token, a browser command, or an algorithmic gate.

`tests/lounge-work-note.test.ts` covers durable rehydration, duplicate mutation, idempotency conflict, compare-and-set conflict, superseded-session fencing, bounded receipt retention, manager visibility, ordinary-agent isolation, and character/byte limits. `tests/mcp-lounge-work-note.test.ts` proves the public schema, automatic join return, exact replacement handoff, stale MCP-writer rejection, and manager-only aggregate visibility through a fresh host boundary.
