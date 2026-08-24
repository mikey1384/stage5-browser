# Agent setup and authentication

## Confirm the MCP connection

Stage5 Browser should be registered at user scope when agents need it from multiple repositories. From any project directory, Claude Code can verify the registration without opening a browser:

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

## Authentication model

The normal mode is one isolated, persistent Stage5 Browser profile per browser backend:

- The first authenticated workflow opens a visible browser window. The user completes passwords, passkeys, CAPTCHAs, or OTPs that should not be delegated.
- Cookies and local storage remain in that backend's Stage5 Browser profile across browser-worker, MCP-server, and agent-session restarts.
- Chrome, Brave, Edge, Chromium, Firefox, and WebKit profiles do not share authentication with one another.
- Stage5 Browser never attaches to or imports cookies from the user's everyday browser profile.
- Tests and smoke checks use temporary profiles and do not modify the persistent profiles.

An agent must inspect the current page instead of assuming a profile is authenticated. When login is required, it should request only the smallest user-only step, then take a fresh semantic snapshot and continue. Use an isolated backend that has never been authenticated when the task specifically needs an anonymous-user check.

Cookie import is intentionally not the login strategy: it expands credential exposure, can copy stale or device-bound state, and weakens the ownership boundary that makes recovery safe. Explicit profile reset and profile export/import are not exposed as agent tools.
