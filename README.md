# Stage5 Browser

Stage5 Browser is a reliability-first local browser controller for AI agents. It gives Stage5 a dogfoodable alternative to browser integrations that stall, detach, lose state, or leave an action's outcome ambiguous.

> A browser action may fail, but the controller must never leave the agent or user in an ambiguous state.

## Current status

The reliability and diagnostics slice is implemented and tested. A standard MCP client can:

- preflight and switch among isolated Chromium, Chrome, Brave, Edge, Firefox, and WebKit profiles
- open HTTP(S) pages with commit-first navigation, bounded redirect stabilization, redirect evidence, and structured HTTP warnings
- reconcile the uniquely visible tab, list tabs, and explicitly select the authentication target
- inspect an AI-oriented ARIA snapshot, automatically scope a unique visible modal, and safely target an observed document-bound reference
- capture a screenshot
- click or fill one unique semantic target, with optional click postcondition verification
- scroll infinite pages and search currently rendered text without arbitrary script evaluation
- release a persistent isolated profile into a visibly marked, genuinely uncontrolled native browser for private human login, pin and verify the exact executable/profile identity across reattachment, and fail explicitly when human session evidence cannot satisfy a non-root post-login route
- stop or explicitly recover the browser
- detect a stale MCP build, diagnose launch preflight/profile failures, automation exposure, sandbox policy, successful/error request classes around the last click, and distinguish worker recovery from browser recovery

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

The included `.codex-plugin/plugin.json` and `.mcp.json` package the server for Codex-compatible plugin environments. A host reconnect is needed once after initial registration or a real tool-catalog change. Compatible runtime patches roll forward automatically on the next browser operation and do not require reinstalling or redeploying Stage5 Browser. See `docs/agent-setup.md` for the ChatGPT and Claude connection decision trees, discovery checks, and authentication behavior.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `browser_status` | Report MCP/build freshness plus worker, browser, exact launch/profile identity, tab, and active-page state |
| `browser_available` | Preflight every backend without launching or closing a browser |
| `browser_diagnostics` | Diagnose build freshness, executable/profile state, sandbox policy, automation exposure, sanitized page events, and successful/error requests around the last click |
| `browser_start` | Launch a requested profile without closing another running browser |
| `browser_switch` | Safely switch to a preflighted isolated browser profile |
| `browser_open` | Navigate with bounded commit, readiness, and client-redirect stabilization; report redirects and HTTP warnings |
| `browser_tabs` | List live tabs and reconcile a uniquely visible user-selected tab |
| `browser_select_tab` | Select a tab by an observed index while Stage5 Browser controls the profile |
| `browser_frames` | Inventory the active page's main document and nested frames |
| `browser_snapshot` | Read semantic structure, scope a unique visible modal, and issue document-bound snapshot references |
| `browser_screenshot` | Explicitly capture a PNG artifact |
| `browser_click_by_role` | Click one unique role/name target, optionally verifying URL, selected state, or visible state |
| `browser_click_ref` | Click one reference from the latest exact semantic snapshot, failing closed when stale |
| `browser_fill_by_role` | Fill one unique role/name target in the main document or an observed frame |
| `browser_scroll` | Perform bounded page/frame scrolling and report position, growth, and end state |
| `browser_find_text` | Search bounded rendered page/frame text and return matching snippets |
| `browser_wait_for_url` | Wait for an exact, prefix, or substring URL postcondition |
| `browser_auth_status` | Report the isolated profile's authentication-handoff lifecycle, native application, marker label, and exact profile binding |
| `browser_request_login_handoff` | Close Playwright cleanly and launch the same isolated profile with a Stage5 marker tab as an uncontrolled native browser for private login |
| `browser_resume_after_login` | Reattach only after the human browser process quits normally; verify launch/storage continuity, return a bounded semantic preview, and require a fresh signed-in check |
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
        │
        ├── normal work: direct Playwright protocol
        │
        └── authentication: close control → native browser → normal user close → reattach
                                      │
                                      ▼
                         dedicated persistent profile
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
- `docs/dogfooding-2026-08-24-x-timeline.md` — X timeline bottlenecks and the generic 0.4 remedies
- `docs/dogfooding-2026-08-24-x-login-handoff.md` — X login diagnostics and the compatible 0.4.1–0.4.4 remedies
- `docs/first-vertical-slice.md` — dogfooding outcome and acceptance criteria
- `docs/failure-taxonomy.md` — defined failure and recovery layers

## Reliability contract

- Every agent-visible operation receives an operation ID and terminal result.
- Browser operations are serialized; two agents cannot race the same active tab.
- Playwright deadlines are backed by a supervisor-owned hard deadline.
- Navigation succeeds at document commit and reports DOM readiness separately.
- Navigation reports sanitized requested/final URLs, server redirects, observed client-side URL changes, and structured non-2xx warnings.
- A timed-out consequential action is never retried automatically.
- A zero-match or multi-match semantic locator fails explicitly.
- Snapshot references are accepted only from the latest snapshot of the same document and frame.
- A unique visible modal becomes the snapshot root; multiple unresolved modals produce a warning instead of an arbitrary choice.
- A dispatched click with an unmet requested postcondition fails as `POSTCONDITION_FAILED` and explicitly reports that the click already happened.
- A click that cannot dispatch records sanitized visibility, enabled-state, viewport, and pointer-interception evidence.
- Human login bootstrap releases Playwright completely, pins the selected Chromium partition, and launches the exact same executable/profile identity without automation or remote-debugging flags. A static Stage5 marker tab and the returned application-specific label distinguish concurrent handoffs. Browser tools remain blocked until the user quits that exact application normally.
- Resume rejects a still-running, locked, or launch-identity-mismatched profile. A zero process exit, no signal, and zero locks permits reattachment even when Chromium retains a stale `crashed` exit marker; the marker is advisory and is compared with its pre-handoff value and modification time. A genuinely abnormal or unavailable process exit offers one explicit second-call override only after the process is gone and locks are clear. When the human phase added target-origin session metadata but a caller-supplied non-root post-login route cannot be reached, resume returns `AUTH_NOT_PERSISTED`. It never force-kills the human browser, deletes locks, rewrites Chromium shutdown preferences, or reads cookie values.
- The uncontrolled phase records no exact manual clicks. Resume reports sanitized route, semantic, launch-identity, and storage-continuity evidence plus a bounded semantic preview, then requires a fresh full snapshot. Origin-only authentication URL checks are rejected as too weak.
- A hung or disconnected worker is killed and replaced before another operation proceeds.
- MCP and worker builds complete a versioned protocol handshake; incompatible contract changes fail with `MCP_RESTART_REQUIRED`.
- A running MCP automatically rolls its worker onto compatible completed builds; only tool-catalog or worker-protocol changes require a host reconnect.
- Worker recovery reports whether a browser was actually running afterward; it never implies that the MCP catalog was refreshed.
- Diagnostic journaling is best-effort and cannot change an operation's result. Page diagnostics include bounded success/redirect/error response classes and the events within the last click window, but exclude raw console/exception text, request metadata beyond method/type/status/sanitized URL, and all URL queries/fragments.

Regression coverage currently includes URL restrictions, privacy-safe journal URLs and diagnostic causes, command serialization, semantic targeting, modal-scoped snapshots, document-bound reference clicks, click actionability and postconditions, successful request capture, timeline scrolling and text search, server and client redirects, HTTP 429 classification, screenshots, ambiguous matches, cross-origin frames, browser switching, uncontrolled human authentication, exact executable/profile binding, native-to-controlled storage continuity, stale Chromium exit-marker handling, bounded unlocked-profile override, weak auth-URL rejection, automation exposure, stale-artifact detection, worker protocol mismatches, and deliberate worker hangs followed by PID replacement.

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
- Chromium-engine browsers opt into Chromium sandboxing on macOS; diagnostics expose the resulting safe policy without exposing a raw process command line.
- Human authentication launches only the selected browser, pinned dedicated-profile arguments, a new-window directive, a static Stage5 identity-marker data URL, and the target URL. It does not use Playwright, remote debugging, `--enable-automation`, `--no-sandbox`, or webdriver-masking scripts.
- Only HTTP, HTTPS, and `about:blank` navigation are allowed.
- URLs with embedded credentials are rejected.
- The operation journal excludes arguments, page content, form values, cookies, headers, query strings, fragments, screenshots, credentials, and OTPs. Offline authentication continuity returns only allowlisted database metadata and booleans; cookie values are never selected, and cookie-key hashes used for set comparison are never returned. Live Chromium cookie presence is reported as unknown because its in-memory jar can be authoritative while SQLite stores are migrating. Page-event fingerprints use a process-local keyed digest and cannot be compared across launches.
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
