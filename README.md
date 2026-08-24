# Stage5 Browser

Stage5 Browser is a reliability-first local browser controller for AI agents. It gives Stage5 a dogfoodable alternative to browser integrations that stall, detach, lose state, or leave an action's outcome ambiguous.

> A browser action may fail, but the controller must never leave the agent or user in an ambiguous state.

## Current status

The reliability and diagnostics slice is implemented and tested. A standard MCP client can:

- preflight and switch among isolated Chromium, Chrome, Brave, Edge, Firefox, and WebKit profiles
- open HTTP(S) pages with commit-first navigation, bounded redirect stabilization, redirect evidence, and structured HTTP warnings
- reconcile the uniquely visible tab, list tabs, and explicitly select the authentication target
- inspect an AI-oriented ARIA snapshot, automatically scope a unique visible modal, and safely target an observed document-bound reference
- discover hidden file inputs, select explicitly authorized local files through one-use snapshot refs, and return attachment/processing evidence without opening a native picker
- capture a screenshot
- click or fill one unique semantic target, with optional click postcondition verification
- scroll infinite pages and search currently rendered text without arbitrary script evaluation
- release a persistent isolated profile into a visibly marked native browser for private human login, then attach to the same running Chromium process so session cookies never cross a restart boundary
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
| `browser_status` | Report MCP/build freshness plus worker, browser, configured and actual runtime profile identity, tab, and active-page state |
| `browser_available` | Preflight every backend without launching or closing a browser |
| `browser_diagnostics` | Diagnose build freshness, executable/profile state, sandbox policy, automation exposure, sanitized page events, and successful/error requests around the last click |
| `browser_start` | Launch a requested profile without closing another running browser |
| `browser_switch` | Safely switch to a preflighted isolated browser profile |
| `browser_open` | Navigate with bounded commit, readiness, and client-redirect stabilization; report redirects and HTTP warnings |
| `browser_tabs` | List live tabs, preserve the agent-selected tab across auxiliary pages, and recover the sole remaining tab after closure |
| `browser_select_tab` | Select a tab by an observed index while Stage5 Browser controls the profile |
| `browser_frames` | Inventory the active page's main document and nested frames |
| `browser_snapshot` | Read semantic structure, scope a unique visible modal, and issue document-bound element and hidden-file-input references |
| `browser_screenshot` | Explicitly capture a PNG artifact |
| `browser_click_by_role` | Click one unique role/name target, optionally verifying URL, selected state, or visible state |
| `browser_click_ref` | Click one reference from the latest exact semantic snapshot, failing closed when stale |
| `browser_set_input_files` | Select authorized regular local files through a fresh file-input ref and report attachment preview, progress, completion, and error evidence |
| `browser_fill_by_role` | Fill one unique role/name target in the main document or an observed frame |
| `browser_scroll` | Perform bounded page/frame scrolling and distinguish a confirmed end from an unconfirmed geometric boundary or stalled dynamic feed |
| `browser_find_text` | Search bounded rendered page/frame text and return matching snippets |
| `browser_wait_for_url` | Wait for an exact, prefix, or substring URL postcondition |
| `browser_auth_status` | Report the authentication-handoff lifecycle, actual runtime profile, three-phase storage boundary, native application, marker label, and exact profile binding |
| `browser_request_login_handoff` | Close current control and launch the same isolated profile with a Stage5 marker tab for private login; returned instructions distinguish continuous Chromium attachment from Firefox restart |
| `browser_resume_after_login` | Attach to the same running Chromium process, or restart a normally exited Firefox profile; verify storage continuity and require a fresh signed-in check |
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
        └── authentication: close control → native Chromium login → same-process attach
                                      │
                                      ├── private loopback control channel
                                      └── dedicated persistent profile
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
- `docs/dogfooding-2026-08-24-x-login-handoff.md` — X login diagnostics and the compatible 0.4.1–0.4.6 remedies
- `docs/dogfooding-2026-08-24-x-upload.md` — X attachment, consumed-input, active-tab, selected-state, and dynamic-feed regressions plus the 0.5.0–0.5.1 remedies
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
- Hidden file-input references follow the same document-bound, one-use capability model. Local selection accepts only explicit absolute paths to readable regular files, rejects symlinks/directories, never opens a native picker, and never journals or returns absolute paths.
- A unique visible modal becomes the snapshot root; multiple unresolved modals produce a warning instead of an arbitrary choice.
- A dispatched click with an unmet requested postcondition fails as `POSTCONDITION_FAILED` and explicitly reports that the click already happened. The postcondition loop performs a final deadline-bound reconciliation so a state change during its last wait is not falsely reported as failure.
- File selection confirms privacy-minimized name/size metadata during the capture-phase input event or from the retained browser `FileList` before returning. Sites may consume and clear the input without creating a false failure. `observationMs` is a quick-sampling window from 0–5,000 ms; a supplied semantic `completion.timeoutMs` can wait up to 60,000 ms within the overall timeout. The bounded processing result is `completion_observed`, `in_progress`, `error_observed`, or `unverified`; temporal network activity is never presented as proof of upload completion.
- A live agent-selected tab remains active when a transient popup or auxiliary player page appears. If the selected page disappears and exactly one live page remains, the controller deterministically selects that sole page instead of returning `activePageIndex: null`.
- Downward scrolling reports the geometric document boundary separately from a confirmed feed end. Earlier dynamic growth followed by a stable boundary is `dynamic_content_stalled`, not `endReached: true`, unless the caller supplies a visible end marker.
- A click that cannot dispatch records sanitized visibility, enabled-state, viewport, and pointer-interception evidence.
- Human login bootstrap releases Playwright completely, pins the selected profile partition, and launches the exact same native executable/profile identity without automation flags. A static Stage5 marker tab and the returned application-specific label distinguish concurrent handoffs. Browser tools remain blocked until explicit resume.
- Chromium-family handoffs use a fixed ephemeral loopback-only CDP endpoint. The user leaves the dedicated browser open; resume attaches to that exact process, so in-memory session cookies are never serialized, imported, or restored by a new browser process. A user-only profile record with an explicit `awaiting_user`/`controlled` state lets compatible worker replacements reconnect without allowing a fresh worker to attach during private login. The endpoint is not returned to agents or written to the operation journal.
- Firefox retains the exit-and-restart handoff. Its resume rejects a still-running, locked, or launch-identity-mismatched profile, applies the existing clean-exit/override checks, and never deletes locks or rewrites shutdown preferences.
- Chromium resume reports the canonical profile path observed by the running browser and compares it with the configured profile after resolving filesystem aliases. A mismatch fails before target navigation.
- The private phase records no exact manual clicks. Chromium resume samples privacy-safe target-origin cookie-key presence immediately after same-process attachment and after target load; Firefox retains the offline-after-exit checkpoint. A bounded preview and fresh full snapshot remain authoritative for visible authentication state; origin-only URL checks are rejected as too weak.
- A hung or disconnected worker is killed and replaced before another operation proceeds.
- MCP and worker builds complete a versioned protocol handshake; incompatible contract changes fail with `MCP_RESTART_REQUIRED`.
- A running MCP automatically rolls its worker onto compatible completed builds; only tool-catalog or worker-protocol changes require a host reconnect.
- Worker recovery reports whether a browser was actually running afterward; it never implies that the MCP catalog was refreshed.
- Diagnostic journaling is best-effort and cannot change an operation's result. Page diagnostics include bounded success/redirect/error response classes and the events within the last click window, but exclude raw console/exception text, request metadata beyond method/type/status/sanitized URL, and all URL queries/fragments.

Regression coverage currently includes URL restrictions, privacy-safe journal URLs and diagnostic causes, command serialization, semantic targeting, modal-scoped snapshots, document-bound reference clicks and hidden-file-input capabilities, local-file preflight and attachment confirmation, click actionability and deadline-edge postconditions, upload progress/error evidence, successful request capture, dynamic-feed stall classification, timeline scrolling and text search, server and client redirects, HTTP 429 classification, screenshots, ambiguous matches, cross-origin frames, browser switching, private human authentication, same-process Chromium session continuity across worker replacement, configured-to-runtime profile verification, Firefox restart-boundary storage diagnostics, stale Chromium exit-marker handling, bounded unlocked-profile override, weak auth-URL rejection, automation exposure, stale-artifact detection, worker protocol mismatches, and deliberate worker hangs followed by PID replacement.

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
- Human authentication launches only the selected browser, pinned dedicated-profile arguments, a new-window directive, a static Stage5 identity-marker data URL, and the target URL. Chromium also receives a fixed ephemeral control port bound to `127.0.0.1`; Stage5 does not attach until explicit resume. The launch does not use Playwright automation arguments, `--enable-automation`, `--no-sandbox`, or webdriver-masking scripts.
- Only HTTP, HTTPS, and `about:blank` navigation are allowed.
- URLs with embedded credentials are rejected.
- The operation journal excludes arguments, page content, form values, cookies, headers, query strings, fragments, screenshots, credentials, and OTPs. Offline authentication continuity returns only allowlisted database metadata and booleans. During controlled checkpoints, Playwright results are immediately reduced to domain/name/expiry metadata; values are never read, retained, compared, hashed, logged, or returned. Cookie-key hashes used for set comparison are never returned. An open Chromium SQLite store remains non-authoritative; live presence comes from the in-memory browser context. Page-event fingerprints use a process-local keyed digest and cannot be compared across launches.
- File selection is an explicit external write. It requires a file-input ref from the latest snapshot and absolute paths supplied for that one operation; paths are never echoed or journaled. Symlinks, directories, unreadable files, stale refs, and disabled inputs fail before selection.
- Screenshots are explicit and written with user-only permissions.
- Arbitrary JavaScript evaluation, credential extraction, CAPTCHA bypass, native file-picker navigation, and unrestricted local-file browsing are not exposed.

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
