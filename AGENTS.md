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

## Security and privacy

- Never automate the default Chrome profile. Use the dedicated Stage5 Browser profile or a temporary test profile.
- Do not add arbitrary JavaScript evaluation, credential extraction, CAPTCHA bypass, or unrestricted file navigation.
- Do not log command arguments, page content, form values, cookies, headers, query strings, fragments, screenshots, credentials, or OTPs.
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
