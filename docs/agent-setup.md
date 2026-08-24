# Agent setup and authentication

## Confirm the MCP connection

Stage5 Browser should be registered at user scope when agents need it from multiple repositories. The active local registration points directly to this checkout's `dist/launcher.js`; it is not a cached marketplace-plugin installation and does not need redeployment after a compatible patch.

### ChatGPT desktop app

The ChatGPT desktop app and Codex CLI share `~/.codex/config.toml`. The official host documentation is [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp?surface=chatgpt-desktop).

From any project directory, first inspect the shared configuration without opening a browser:

```bash
codex mcp list
```

The expected result includes an enabled `stage5_browser` entry whose command resolves to this repository's `dist/launcher.js`.

Use this decision tree:

1. If the current agent exposes the number of Stage5 Browser tools declared at `stage5Browser.toolCount` in `package.json`, call `browser_status`; do not touch host configuration.
2. If `codex mcp list` does not contain `stage5_browser`, the server is not registered for that Codex host. Register it before browser work.
3. If the CLI reports it enabled but the current ChatGPT agent lacks the tools or the app does not show the server, the running app loaded its host configuration before registration. Fully quit and reopen ChatGPT once, then start or resume an agent run. Do not rebuild, reinstall, redeploy, or add a duplicate server.
4. Once connected, `browser_status` should report the version and tool count declared in `package.json`, with `restartRequired: false`.
5. If `compatibleUpdateAvailable` is true, continue normally. Stage5 Browser replaces the worker with the completed compatible build on the next operation.
6. Reconnect the host only when `restartRequired` is true. This means the MCP tool catalog or MCP-to-worker protocol actually changed.

The ChatGPT composer can use `/mcp` to inspect connected servers after the host has loaded them. If the server is missing there while `codex mcp list` says it is enabled, treat that as stale host state—not failed registration.

### Claude Code

From any project directory, Claude Code can verify the registration without opening a browser:

```bash
claude mcp get stage5_browser
```

The expected result includes both:

```text
Scope: User config (available in all your projects)
Status: ✔ Connected
```

Inside an interactive Claude Code session, `/mcp` provides the equivalent connection view. If `ToolSearch` cannot find Stage5 Browser, check the MCP connection first instead of inspecting configuration files or constructing JSON-RPC by hand.

Claude Code builds its MCP tool catalog when the agent process starts. A server registered after a long-running session began will not appear in that session. Exit the process and resume the conversation with:

```bash
claude --continue
```

After reconnection, a natural-language instruction such as “Use the `stage5_browser` MCP tools instead of `claude-in-chrome`” is sufficient. The host exposes the individual tools to the model; no JSON-RPC bridge is necessary.

## Runtime diagnosis

`browser_status` reports the MCP version, protocol version, process start time, build fingerprint, tool-catalog version, compatible-update state, and `restartRequired`. Rebuilds that preserve both the tool-catalog and worker-protocol versions load automatically on the next browser operation. Restart the MCP host only when `restartRequired` is true, which means one of those public contracts changed. `browser_recover` remains for failed browser workers; it is not an update mechanism.

Do not terminate an old-looking MCP or worker PID without proving ownership; multiple concurrent agents can legitimately have separate Stage5 Browser processes. A missing tool is a host-catalog problem. A present tool returning a structured launch failure is a runtime problem. Keep those paths separate.

After any `browser_start` failure, call `browser_diagnostics` before retrying. It reports the selected backend's executable preflight, profile writability and known lock files, sandbox policy, automation-control mode, `--enable-automation` policy, observed `navigator.webdriver` value when Playwright has a page, the last sanitized launch-failure category, and a safe suggested action. After an interaction failure, the same tool reports bounded console/network categories, success/redirect/error response counts, requests within the last click window, and the most recent click's actionability and dispatch facts. Raw browser errors, console or exception text, credentials, page contents, headers, bodies, query strings, fragments, form values, and full launch arguments are not included.

## File attachment model

`browser_snapshot` separately reports any HTML file inputs as `fileInputs`, including hidden inputs omitted from the ARIA tree. Each entry carries an opaque ref bound to that exact latest snapshot, frame, document version, and observed element. To attach a user-authorized local file, call `browser_set_input_files` with that `snapshotId`, ref, frame ID, and absolute path. The tool consumes the capability once, rejects symlinks/directories/unreadable files before dispatch, bypasses the native picker, confirms the browser's privacy-minimized file metadata, and returns a fresh preview.

Attaching is not posting, and file-input confirmation is not upload completion. Read `processing.state`: only `completion_observed` has explicit semantic progress or caller-supplied completion evidence. `in_progress`, `error_observed`, and `unverified` require inspection through the returned fresh snapshot before any submit action. A timeout or `file_selection_outcome_unknown` must never be replayed until a fresh observation proves the composer has no attachment. Absolute paths are neither returned nor journaled.

## Authentication model

The normal mode is one isolated, persistent Stage5 Browser profile per browser backend:

- Call `browser_auth_status` first. It reports profile/handoff state but deliberately returns `authenticated: "unknown"`; only the site's visible UI can prove that account state. Before a new login, explicitly select the intended backend instead of relying on a remembered default.
- If login is needed, call `browser_request_login_handoff`, optionally with the absolute login URL. Stage5 Browser navigates while controlled, closes Playwright cleanly, and launches the same isolated profile as a normal native browser without Playwright automation flags. The response is `awaiting_user`, `browserConnected: false`, and `controlMode: "human_bootstrap"`. It also names the real browser application, exact executable/profile binding, target origin, and short handoff label.
- While the handoff is `awaiting_user`, do not call tab, page, action, start, switch, recover, or stop tools. They intentionally fail with `AUTH_HANDOFF_REQUIRED`; the agent cannot inspect or steer the private window.
- If a compatible build finishes during the private handoff, Stage5 Browser defers worker replacement. Resume through the existing worker first; the next operation rolls forward automatically. Do not reconnect or recover merely to load that compatible build.
- The native window contains a static Stage5 marker tab next to the sign-in tab. The user should match that marker and the application name in the handoff result, then complete passwords, passkeys, CAPTCHAs, or OTPs privately. Never ask them to paste sensitive values into the conversation.
- Follow the returned backend-specific instruction exactly. For Chromium, Chrome, Brave, and Edge, leave that application open and call `browser_resume_after_login`; Stage5 attaches to that same running process, preserving its in-memory session. For Firefox, quit the application normally, then resume through the existing unlocked-profile checks. Do not use a bare origin such as `https://example.com` as the URL expectation; use a non-root post-login route or pass `null`.
- Chromium resume reports the actual runtime profile and privacy-safe storage at first attachment and after target load. Its fixed ephemeral CDP port is loopback-only and never appears in tool output. Compatible worker replacement disconnects and reconnects without closing the browser. Firefox retains the offline-after-exit checkpoint and bounded clean-exit override. Exact human clicks and private-window network traffic remain deliberately unobserved.
- Inspect `verificationPreview` immediately; if it still shows signed-out controls, stop. Then take a fresh full `browser_snapshot` and verify the site-specific account identity or signed-in affordance before acting. Storage continuity and a `lossBoundary` of `none` are evidence, not proof that the site accepted the login. Never request cookie values to resolve ambiguity.
- A unique visible dialog automatically becomes the snapshot root. Check `scope`, `visibleModalCount`, and `warnings`; this keeps portal/modal fields and buttons within the bounded depth while retaining valid refs from one ARIA capture. If `ambiguous_visible_modals` appears, do not guess which dialog to use.
- Persistent browser storage remains in that backend's Stage5 Browser profile across browser-worker, MCP-server, and agent-session restarts. Storage continuity is diagnostic evidence, never a claim that the site accepted or retained authentication.
- Chrome, Brave, Edge, Chromium, Firefox, and WebKit profiles do not share authentication with one another.
- Stage5 Browser never attaches to or imports cookies from the user's everyday browser profile.
- Tests and smoke checks use temporary profiles and do not modify the persistent profiles.

The handoff lifecycle is intentionally conservative:

```text
browser_stopped / profile_ready
              │ browser_request_login_handoff
              ▼
        awaiting_user
              │ native browser; no agent control
              │ Chromium: user finishes and leaves process open
              │ Firefox: user finishes and quits normally
              │ browser_resume_after_login
              ▼
ready_for_agent_verification
              │ fresh snapshot proves site state
              ▼
     normal semantic actions
```

The user normally signs in only once per backend profile. A later agent session can reuse that profile, but it must still inspect the current page instead of assuming authentication. Use an isolated backend that has never been authenticated when the task specifically needs an anonymous-user check.

Cookie import is intentionally not the login strategy: it expands credential exposure, can copy stale or device-bound state, and weakens the ownership boundary that makes recovery safe. Explicit profile reset and profile export/import are not exposed as agent tools.
