# First vertical slice

## Dogfooding outcome

Use Stage5 Browser, through its MCP interface, to launch an isolated persistent browser, open `https://translator.tools`, inspect its semantic page state, capture an explicit screenshot, and recover automatically from a deliberately hung browser worker.

This workflow is deliberately read-only. It proves the reliability boundary before authenticated or consequential workflows are added.

## Included capabilities

- lazy launch of a dedicated persistent Chromium profile
- one serialized operation stream
- browser status and tab inventory
- committed navigation with bounded readiness checks
- AI-oriented accessibility snapshots
- explicit screenshots stored outside the repository
- role-and-accessible-name click and fill primitives
- a hard worker deadline enforced outside the browser process
- process-tree termination and browser-worker replacement after a hang
- structured operation outcomes and a privacy-minimized local journal
- local stdio MCP packaging for Codex and other compatible agents

## Acceptance criteria

1. The MCP server starts and lists its tools without launching a browser.
2. The first browser operation launches an isolated persistent profile without touching the default Chrome profile.
3. Navigation reports once the target is committed; a missing or delayed `load` event cannot create an indefinite stall.
4. Snapshot and screenshot operations have explicit deadlines.
5. Operations execute in submission order, including after a prior operation fails.
6. A deliberately hung worker is terminated as a process group, replaced, and followed by a successful status operation.
7. A timed-out consequential operation is never retried automatically.
8. The journal excludes page content, form values, cookies, headers, query strings, fragments, screenshots, and command arguments.
9. Unit, integration, and MCP end-to-end tests pass.
10. A final smoke run opens and semantically inspects `translator.tools` through the built MCP server.

## Validation record

Completed on 2026-08-23:

- `npm test`: 4 test files and 6 tests passed, including a deliberate worker hang, worker PID replacement, and descendant-process termination.
- `npm run smoke`: the built MCP server exposed 11 tools, opened `https://translator.tools`, returned a 24,404-character semantic result, and returned a PNG screenshot.
- Plugin manifest validation passed.
- The tested server was registered locally as `stage5_browser` for subsequent dogfooding sessions.

## Explicitly deferred

- use of a person's existing Chrome profile
- a browser extension
- CAPTCHA or anti-bot handling
- arbitrary JavaScript evaluation
- secrets, OTP, or password entry
- uploads and downloads
- service-specific adapters
- remote browser operation
- a Chromium fork

Deferred capabilities enter the product only when a real Stage5 workflow requires them.
