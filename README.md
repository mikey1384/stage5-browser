# Stage5 Browser

Stage5 Browser is a reliability-first local browser controller for AI agents. It gives Stage5 a dogfoodable alternative to browser integrations that stall, detach, lose state, or leave an action's outcome ambiguous.

> A browser action may fail, but the controller must never leave the agent or user in an ambiguous state.

## Current status

The reliability and diagnostics slice is implemented and tested. A standard MCP client can:

- preflight and switch among isolated Chromium, Chrome, Brave, Edge, Firefox, and WebKit profiles
- open HTTP(S) pages with commit-first navigation
- list and select tabs
- inspect an AI-oriented ARIA snapshot
- capture a screenshot
- click or fill one unique semantic target
- stop or explicitly recover the browser
- detect a stale MCP build, diagnose launch preflight/profile failures, and distinguish worker recovery from browser recovery

The MCP process supervises a separate worker that owns Playwright and the selected browser. If a command exceeds its outer hard deadline, the supervisor terminates that worker's process group, starts a clean worker, reports the recovery outcome, and does not replay the timed-out action.

The initial production smoke test opened `https://translator.tools`, returned its semantic page structure, and captured a screenshot through MCP.

## Quick start

Requirements: Node.js 22 or newer.

```bash
npm install
npm run browser:install
npm test
npm run smoke
```

Run the MCP server directly:

```bash
npm run build
npm start
```

The included `.codex-plugin/plugin.json` and `.mcp.json` package the server for Codex-compatible plugin environments. After installing or registering it locally as `stage5_browser`, start a new agent process so its MCP tool catalog is rebuilt. For Claude Code, `claude mcp get stage5_browser` should report `Scope: User config` and `Status: ✔ Connected`; use `claude --continue` to resume the last conversation after restarting. See `docs/agent-setup.md` for registration, discovery, and authentication behavior.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `browser_status` | Report MCP/build freshness plus worker, browser, tab, and active-page state |
| `browser_available` | Preflight every backend without launching or closing a browser |
| `browser_diagnostics` | Diagnose build freshness, executable availability, profile writability/locks, and the last safe launch cause |
| `browser_start` | Launch a requested profile without closing another running browser |
| `browser_switch` | Safely switch to a preflighted isolated browser profile |
| `browser_open` | Navigate with bounded commit and readiness phases |
| `browser_tabs` | List live tabs |
| `browser_select_tab` | Select a tab by an observed index |
| `browser_frames` | Inventory the active page's main document and nested frames |
| `browser_snapshot` | Read semantic structure from the main document or an observed frame |
| `browser_screenshot` | Explicitly capture a PNG artifact |
| `browser_click_by_role` | Click one unique role/name target in the main document or an observed frame |
| `browser_fill_by_role` | Fill one unique role/name target in the main document or an observed frame |
| `browser_recover` | Replace the worker process group and optionally reopen the last URL |
| `browser_stop` | Close the owned browser context |

## Architecture

```text
Codex / Claude / MCP client
        │ stdio MCP
        ▼
MCP server + serialized supervisor
        │ Node IPC with per-command hard deadlines
        ▼
Browser worker process group
        │ direct Playwright protocol
        ▼
Selected Playwright browser backend + dedicated persistent profile
```

The worker boundary is intentional. A stalled browser transport cannot wedge the MCP event loop, and recovery can kill browser descendants rather than merely dropping a stale JavaScript object.

Key implementation files:

- `src/mcp-server.ts` — agent-facing MCP tools and safety annotations
- `src/supervisor.ts` — serialization, deadlines, process-tree replacement, and journaling
- `src/browser-worker.ts` — IPC command dispatch
- `src/browser-controller.ts` — direct Playwright browser operations
- `src/browser-provider.ts` — trusted browser selection and installed-browser discovery
- `docs/agent-setup.md` — Claude connection checks, session restart, and login lifecycle
- `docs/browser-support.md` — support matrix and required agent selection workflow
- `docs/first-vertical-slice.md` — dogfooding outcome and acceptance criteria
- `docs/failure-taxonomy.md` — defined failure and recovery layers

## Reliability contract

- Every agent-visible operation receives an operation ID and terminal result.
- Browser operations are serialized; two agents cannot race the same active tab.
- Playwright deadlines are backed by a supervisor-owned hard deadline.
- Navigation succeeds at document commit and reports DOM readiness separately.
- A timed-out consequential action is never retried automatically.
- A zero-match or multi-match semantic locator fails explicitly.
- A hung or disconnected worker is killed and replaced before another operation proceeds.
- MCP and worker builds complete a versioned protocol handshake; incompatible builds fail with `MCP_RESTART_REQUIRED`.
- A running MCP detects when its loaded artifact was rebuilt and refuses browser work until the host restarts.
- Worker recovery reports whether a browser was actually running afterward; it never implies that the MCP catalog was refreshed.
- Diagnostic journaling is best-effort and cannot change an operation's result.

Regression coverage currently includes URL restrictions, privacy-safe journal URLs and diagnostic causes, command serialization, semantic targeting, screenshots, ambiguous matches, cross-origin frames, browser switching, stale-artifact detection, worker protocol mismatches, and deliberate worker hangs followed by PID replacement.

## Browser selection

Bundled Playwright Chromium remains the zero-configuration default. A trusted operator can choose another default when launching the MCP server:

```bash
STAGE5_BROWSER_BROWSER=brave npm start
```

Supported values are `chromium`, `chrome`, `brave`, `edge`, `firefox`, and `webkit`. Stage5 Browser discovers standard Chrome, Brave, and Edge installations on macOS, Windows, and Linux. Chromium, Firefox, and WebKit use the project-pinned Playwright runtimes installed by `npm run browser:install`.

Agents do not need an MCP restart to choose browsers after the Stage5 Browser tools are already connected. After `browser_available`, an agent uses `browser_start({ browser })`. If another backend is already running, it uses the explicitly destructive `browser_switch` instead; the target is preflighted before current tabs are closed. The supervisor preserves the selected backend across worker recovery. Each backend has an independent Stage5 profile and does not inherit cookies from a person's everyday browser profile.

For a nonstandard installation, a trusted operator can set an absolute executable path:

```bash
STAGE5_BROWSER_BROWSER=brave \
STAGE5_BROWSER_EXECUTABLE_PATH="/path/to/Brave Browser" \
npm start
```

`STAGE5_BROWSER_EXECUTABLE_PATH` is startup configuration for the configured default and is never exposed as an agent-callable tool argument. `STAGE5_BROWSER_PROFILES_DIR` overrides the isolated-profile root; `STAGE5_BROWSER_PROFILE_DIR` overrides only the configured default browser's profile.

To smoke-test a selected browser through the complete MCP boundary:

```bash
STAGE5_BROWSER_BROWSER=brave npm run smoke
```

To exercise an agent-driven runtime switch from the default Chromium profile:

```bash
STAGE5_BROWSER_SWITCH_TO=firefox npm run smoke
```

WebKit provides Safari-engine coverage, not control of the installed Safari application or its profile. Safari application control requires a separate WebDriver adapter and explicit Safari Remote Automation permission. See `docs/browser-support.md` for the exact support boundary.

## Security and privacy

- Stage5 Browser never opens a person's default browser profile.
- Bundled Chromium, Firefox, and WebKit are pinned under `.playwright-browsers/`; every selected backend keeps profile state in a dedicated Stage5 Browser application-data directory.
- Only HTTP, HTTPS, and `about:blank` navigation are allowed.
- URLs with embedded credentials are rejected.
- The operation journal excludes arguments, page content, form values, cookies, headers, query strings, fragments, screenshots, credentials, and OTPs.
- Screenshots are explicit and written with user-only permissions.
- Arbitrary JavaScript evaluation, credential extraction, CAPTCHA bypass, and unrestricted local-file navigation are not exposed.

## Dogfooding model

Stage5 Browser grows from real Stage5 work:

1. Prefer an official API, CLI, connector, or repository script when one can complete the task.
2. For genuinely UI-only work, identify the smallest missing browser capability.
3. Reproduce the gap or failure in a fixture or test.
4. Implement a generic primitive or isolated service adapter.
5. Complete the original task through Stage5 Browser.
6. Preserve the failure as a regression test.

Service-specific behavior for Google, Twilio, Cloudflare, or another vendor must remain outside browser core. The next capability should be selected by the next real Stage5 workflow, not by speculative feature breadth.

## Initial non-goals

- Forking Chromium without a reproducible engine-level defect
- Controlling the user's primary Chrome profile
- Circumventing CAPTCHAs, anti-bot systems, access controls, or service policies
- Encoding fragile service-specific selector scripts in browser core
- Replacing a reliable official API or CLI
