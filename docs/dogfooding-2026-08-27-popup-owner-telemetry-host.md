# Popup-owner telemetry host boundary

Release contract: Stage5 Browser 0.15.9, MCP host behavior 3, tool catalog 13, worker protocol 12, 54 tools. This release requires one MCP host reconnect; it does not authorize any browser replay or new account action.

## Boundary found

The 0.15.8 worker correctly returned bounded `popupOwnership` evidence and fixed the live popup association. Its durable operation trace was created by an already-running host whose trace allowlist had been loaded before that field existed. The old host therefore retained the operation success, manager, timing, zero action phases, association proof, surface proof, and rendered-surface count, but omitted the new owner categories.

That behavior was privacy-safe, but the 0.15.8 release note incorrectly treated a host-owned telemetry schema as worker-hot-reloadable. Trace extraction and journaling live in the MCP process, so a newly retained conclusion field is a host behavior change even when the worker protocol and tool catalog are unchanged.

## Contract correction

0.15.9 increments `MCP_HOST_BEHAVIOR_VERSION` from 2 to 3. `browser_status` on an old host must return `restartRequired:true` with the host-behavior change reason. After one host reconnect, the agent rejoins its same Lounge identity, calls `browser_status`, requires version 0.15.9/host behavior 3/protocol 12/catalog 13/54 tools with `restartRequired:false`, and discards old refs and inspection IDs.

The fresh-host MCP integration fixture performs one passive popup inspection against a disposable local page, confirms the canonical result contains categorical `popupOwnership`, then queries the same operation ID and confirms the durable trace contains the same proof tier and decision. The fixture contains no account state or private data and dispatches no input.

Focused fresh-host delta gate: 4 files and 13 tests passed in 2.48 seconds, covering the fresh MCP host, durable trace query, privacy allowlist, host-behavior mismatch, and package/runtime contract. The unchanged browser and parser implementation had immediately passed the complete 0.15.8 headless gate of 71 files and 260 tests with 3 intentional native focus-changing/handoff skips. 0.15.9 changes only version/host-contract metadata, documentation, and this fresh-host integration assertion, so the unchanged 178-second browser suite was not duplicated without a new boundary to cover.

The live Finance popup operation is already functionally accepted. It must not be replayed after reconnect merely to populate telemetry; old trace rows remain immutable, and future independently authorized operations use the corrected host parser.
