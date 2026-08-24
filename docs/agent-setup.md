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

## Authentication model

The normal mode is one isolated, persistent Stage5 Browser profile per browser backend:

- Call `browser_auth_status` first. It reports profile/handoff state but deliberately returns `authenticated: "unknown"`; only the site's visible UI can prove that account state. Before a new login, explicitly select the intended backend instead of relying on a remembered default.
- If login is needed, call `browser_request_login_handoff`, optionally with the absolute login URL. Stage5 Browser navigates while controlled, closes Playwright cleanly, and launches the same isolated profile as a normal native browser without Playwright, remote debugging, or automation flags. The response is `awaiting_user`, `browserConnected: false`, and `controlMode: "human_bootstrap"`. It also names the real browser application, exact executable/profile binding, target origin, and short handoff label.
- While the handoff is `awaiting_user`, do not call tab, page, action, start, switch, recover, or stop tools. They intentionally fail with `AUTH_HANDOFF_REQUIRED`; the agent cannot inspect or steer the private window.
- If a compatible build finishes during the private handoff, Stage5 Browser defers worker replacement. Resume through the existing worker first; the next operation rolls forward automatically. Do not reconnect or recover merely to load that compatible build.
- The native window contains a static Stage5 marker tab next to the sign-in tab. The user should match that marker and the application name in the handoff result, complete passwords, passkeys, CAPTCHAs, or OTPs privately, then quit that exact browser application normally so its process exits. On macOS, use Cmd-Q in the named application; closing only a tab/window may leave it running. Never ask them to paste sensitive values into the conversation, and never force-close the process or delete profile locks.
- Call `browser_resume_after_login` only after that complete application exits. Exit code zero, no signal, and zero profile locks is clean enough to reattach; Chromium's stored exit marker is advisory and compared with its pre-handoff value and modification time. A still-running, locked, executable/profile-mismatched, or storage-continuity-lost handoff fails closed with a precise suggested action. If the process exit itself is abnormal or unavailable but the process is gone and locks are clear, the first resume offers an explicit override; one deliberate second resume with the same expectation uses it without repeating login. Stage5 Browser does not forge Chromium shutdown preferences. Do not use a bare origin such as `https://example.com` as the URL expectation; use a non-root post-login route or pass `null`.
- Resume reopens the same profile under Playwright and reports the actual runtime profile path plus privacy-safe storage observations immediately after native exit, immediately after controlled start, and after target load. Read `lossBoundary`, `automationCorrelation`, `targetOriginLoadedAtControlledStart`, and `navigatorWebdriverAtControlledStart` together; correlation does not prove that automation caused invalidation. The marker tab is removed afterward. `lastHandoffOutcome` also includes sanitized route and semantic evidence, while `verificationPreview` is a bounded semantic preview with form-control lines removed. Exact human clicks and human-window network traffic are deliberately unobserved. Inspect that preview immediately; if it still shows signed-out controls, stop. Then take a fresh full `browser_snapshot` and verify the site-specific account identity or signed-in affordance before acting; that snapshot completes the lifecycle.
- Interpret the boundary before proposing a new control architecture: `playwright_start` points to profile, keychain, or controlled-launch policy; `playwright_start_or_restored_target_load` cannot separate launch from an automatically restored target; `target_load` plus `loss_after_automation_exposure` supports an extension-control experiment only after the result repeats; `none` plus a signed-out page means cookie-key presence survived but site acceptance did not. Never request cookie values to resolve the ambiguity.
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
              │ user finishes and quits the dedicated process normally
              │ browser_resume_after_login
              ▼
ready_for_agent_verification
              │ fresh snapshot proves site state
              ▼
     normal semantic actions
```

The user normally signs in only once per backend profile. A later agent session can reuse that profile, but it must still inspect the current page instead of assuming authentication. Use an isolated backend that has never been authenticated when the task specifically needs an anonymous-user check.

Cookie import is intentionally not the login strategy: it expands credential exposure, can copy stale or device-bound state, and weakens the ownership boundary that makes recovery safe. Explicit profile reset and profile export/import are not exposed as agent tools.
