# Dogfooding incident: stale MCP and rebuilt worker

## Observed behavior

A long-running agent exposed the original Stage5 Browser tool catalog. `browser_status` reported a stopped browser, while `browser_start` failed in approximately four milliseconds with only `BROWSER_NOT_READY`. Worker recovery succeeded as a process operation but left the browser stopped. Tools added by a later build were absent from the agent's catalog.

## Root cause

The MCP server process had started at 08:42 and remained in memory. A later build replaced the JavaScript files on disk. At 12:37 the old supervisor spawned the new `browser-worker.js`, so the worker received an initialization payload from the older protocol. The old protocol had no build handshake, and the resulting initialization incompatibility was flattened into the generic launch error.

Several MCP server processes were present because multiple agent sessions had loaded the user-scoped integration. Worker-only recovery could not refresh any host's MCP tool catalog.

## Changes made

- Package version `0.2.0` and worker protocol version `2` are exchanged at initialization.
- Protocol mismatch returns `MCP_RESTART_REQUIRED` instead of entering a recovery loop.
- The MCP fingerprints its loaded artifact and detects a rebuild on disk.
- `browser_status` includes MCP/build freshness and worker metadata.
- `browser_diagnostics` reports executable preflight, profile writability/locks, and a sanitized last-launch cause with a suggested action.
- Launch errors include the selected backend, engine, safe cause category, and action.
- The privacy-minimized journal records only an allowlisted diagnostic cause and backend.
- Worker recovery distinguishes a running browser from a stopped browser.
- A package-relative launcher normalizes the Playwright runtime location independently of the agent project's working directory.

## Operational resolution

An agent whose catalog predates this release must restart its MCP host once. In Claude Code, exit and run `claude --continue`; in other hosts, start a fresh agent session. Future rebuilds are detected and reported explicitly.

The follow-up lifecycle fix in `0.3.0` removes restarts for compatible rebuilds. A successful build publishes its stamp last, and the resident MCP process rolls its worker forward on the next operation when the tool catalog and worker protocol are unchanged. Only a real public-contract change asks the host to reconnect.
