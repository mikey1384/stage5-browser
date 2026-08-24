# Stage5 Browser agent guide

When this project is checked out inside the Stage5 workspace, read the parent `../AGENTS.md` first. Its rules remain authoritative.

## Product invariant

A browser action may fail, but the controller must never leave the agent or user in an ambiguous state. Every operation must succeed, fail with structured evidence, or complete a defined recovery within a bounded time.

## Development model

- Build capabilities only for a real Stage5 dogfooding workflow or a demonstrated reliability gap.
- Check for an API, CLI, connector, or repository script before adding browser automation.
- Convert every reproduced failure into a regression test before or alongside its fix.
- Keep service-specific behavior out of browser core. Put it in an isolated adapter when generic semantic controls are insufficient.
- Do not fork Chromium unless a raw, repeatable test proves an engine-level defect.

## Reliability rules

- The MCP process supervises a separate browser worker. Do not move browser ownership into the MCP event loop.
- All browser commands pass through one serialized queue and have an outer hard deadline.
- A hung worker must be terminated with the browser process group it owns before replacement.
- Never retry a consequential operation after an ambiguous timeout. Verify authoritative state first.
- Navigation uses commit-first semantics with a separately bounded readiness probe.
- Do not return an arbitrary first match for an ambiguous locator.
- Treat a semantic snapshot's `snapshotId` and refs as document-bound capabilities. Never accept a ref that was not present in the latest snapshot of the same frame, and invalidate refs after navigation or mutation.
- Treat hidden file inputs as a distinct one-use snapshot capability. Accept only explicit absolute paths to readable regular files; reject symlinks, directories, stale refs, disabled inputs, and unsupported multiple selection before dispatch. Never log or return absolute paths, and never open the native picker.
- When a click is intended to change state, use a bounded postcondition. If it fails, report that the click was dispatched and never replay it without a fresh observation.
- File selection is consequential. Confirm privacy-minimized browser `FileList` metadata after dispatch, return a fresh semantic preview, and report processing as completion observed, in progress, error observed, or unverified. Temporal network activity is evidence, not proof of upload completion; never replay an ambiguous selection.
- Return structured warnings for non-2xx navigation responses and explicit redirect evidence; a committed response is not automatically a successful workflow result.
- Keep scrolling and text search bounded and generic. Do not add arbitrary agent-supplied JavaScript or service-specific timeline code.
- Separate geometric scroll boundaries from semantic feed ends. A downward boundary without an explicit visible end marker is unconfirmed; earlier dynamic growth followed by no movement is a stalled feed, not a completed timeline.
- Prefer one ARIA capture rooted at a uniquely established visible modal over stitching multiple snapshots or globally increasing document depth. Preserve one valid ref map; warn and fail back to the document when modal choice is ambiguous.
- Page and click diagnostics must be bounded and sanitized. Expose categories, counts, status, and actionability facts—not raw console/exception text, request bodies or headers, query strings, fragments, entered values, or a full browser command line.

## Authentication handoff

- Isolated persistent profiles remain the default security boundary. Do not attach to or copy cookies from a person's everyday browser profile.
- Agents call `browser_auth_status` before account-dependent work. The tool reports lifecycle state, not a guessed authenticated boolean.
- Before login, explicitly select the intended backend; concurrent agents may legitimately have different Stage5 Brave, Chrome, Chromium, Edge, or Firefox windows. Login uses `browser_request_login_handoff` → user acts privately in the exact native application named by the result, using the adjacent Stage5 identity-marker tab and short handoff label to distinguish it → user follows the returned backend-specific instruction → `browser_resume_after_login` → returned bounded preview → fresh full semantic snapshot. Chromium-family browsers stay open for same-process attachment; Firefox exits normally for restart-based resume. Credentials, passkeys, CAPTCHAs, and OTPs never pass through agent arguments, messages, or logs.
- The human bootstrap uses the same isolated profile and launches the selected browser without Playwright automation flags. Chromium uses a fixed ephemeral loopback-only CDP endpoint so Stage5 can attach only after the user finishes, without restarting the authenticated browser; the endpoint remains private and is never returned to an agent. Do not replace this with stealth flags or script-based `navigator.webdriver` overrides.
- While `browser_auth_status.state` is `awaiting_user`, do not call tab, page, action, start, switch, recover, or stop tools. Stage5 Browser intentionally refuses control while the human window owns the profile.
- A compatible completed build is deferred while the human window owns the profile. Resume through the already-running worker first; the supervisor rolls forward before the following operation.
- Never force-close the human authentication browser or delete profile locks. For Chromium, ask the user to leave the dedicated instance open and resume into that same process. For Firefox, ask the user to quit normally; a current exit code of zero, no exit signal, and zero profile locks is sufficient for restart-based reattachment. If Firefox's process exit is abnormal or unavailable after the process is gone and locks are clear, do not repeat login: the first resume offers a bounded explicit override, and one deliberate second resume uses it. Never rewrite browser exit preferences.
- The uncontrolled phase cannot observe exact manual clicks or network traffic. Treat `lastHandoffOutcome` as a sanitized before/after boundary comparison, then use a fresh snapshot to verify account state.
- Treat the returned executable, application name, user-data directory, profile directory, and effective profile path as one binding. Resume must fail as `AUTH_NOT_PERSISTED` when that binding changes, or when the human phase added target-origin session metadata but reattachment cannot reach a caller-supplied non-root post-login route. Cookie values are never inspected. Do not infer live cookie absence from an open Chromium SQLite database; the browser may hold a valid in-memory jar while migrating stores. Storage continuity is still not proof of authentication; stop if the bounded preview or fresh snapshot shows signed-out controls.
- On Chromium resume, inspect `runtimeProfile` and all three storage observations: `afterHumanBrowser`, `afterControlledStart`, and `afterTargetLoad`. Report `lossBoundary`, `automationCorrelation`, `targetOriginLoadedAtControlledStart`, and the visible site state. `playwright_start` points to launch/profile/storage-policy investigation. `target_load` with `loss_after_automation_exposure` justifies designing an extension-control path only after repeated evidence; it does not by itself prove `navigator.webdriver` caused invalidation. `preserved` plus signed-out UI means the site rejected or expired state that key-only metadata cannot identify. Never inspect or expose cookie values.
- Do not use an origin-only URL as an authentication postcondition. Use a non-root post-login route when one is stable, or omit the URL expectation and verify the preview plus a fresh snapshot.
- A successful login persists per selected backend profile. It does not transfer between Brave, Chrome, Chromium, Edge, Firefox, or WebKit.

## Host connection and update lifecycle

Before browser work, distinguish a missing host connection from a failed browser runtime:

1. Confirm the current agent exposes the `stage5_browser` tools. Read the expected count from `package.json` at `stage5Browser.toolCount`; do not rely on a remembered release number.
2. If the tools are absent in ChatGPT, run `codex mcp list`. The expected entry is `stage5_browser`, enabled, pointing directly to this repository's `dist/launcher.js`.
3. If the CLI entry is enabled but ChatGPT does not expose the tools or show the server, the running ChatGPT host predates the registration. Fully quit and reopen ChatGPT once, then start or resume an agent run. Do not rebuild, redeploy, reinstall, or rewrite the registration.
4. When the tools are present, call `browser_status`. A normal build reports the version and tool count declared in `package.json`, plus `restartRequired: false`.
5. `compatibleUpdateAvailable: true` is not a blocker. The next browser operation automatically rolls the worker onto the compatible completed build.
6. Reconnect the MCP host only when `restartRequired: true`. That flag is reserved for a real tool-catalog or MCP-to-worker protocol change.

Do not kill an observed MCP or worker PID merely because it is old; other active agent sessions may own it. Do not use `browser_recover` as an update mechanism. After a launch failure, call `browser_diagnostics` and follow its structured action.

When changing Stage5 Browser itself:

- Ordinary behavior fixes keep the existing tool-catalog and worker-protocol versions. `npm run build` publishes a completed build stamp last, and live hosts pick up the compatible worker automatically.
- Adding, removing, or changing an MCP tool schema requires a tool-catalog version bump.
- Changing the MCP-to-worker command contract requires a worker-protocol version bump.
- Keep the contract metadata in `package.json`, constants in `src/runtime-info.ts`, package/plugin versions, and regression tests aligned.
- Never tell the user to patch or deploy this local integration. The registered launcher reads this checkout directly.

See `docs/agent-setup.md` for host-specific checks and the exact decision tree.

## Security and privacy

- Never automate the default Chrome profile. Use the dedicated Stage5 Browser profile or a temporary test profile.
- Do not add arbitrary JavaScript evaluation, credential extraction, CAPTCHA bypass, or unrestricted file navigation.
- Do not log command arguments, page content, form values, cookies, headers, query strings, fragments, screenshots, credentials, or OTPs.
- Enable Chromium sandboxing on macOS unless a documented, reproduced browser incompatibility requires a narrower exception. Do not expose raw launch arguments; diagnostics may list only known security-relevant policy facts.
- Screenshots are explicit operations, stored outside the repository with restrictive permissions.
- Browser tools that may change external state must be marked as writes in MCP annotations.

## Commands

```bash
npm install
npm run browser:install
npm run build
npm test
npm run smoke
```
