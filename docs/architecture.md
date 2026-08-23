# Architecture

## First-slice topology

```text
Codex or another MCP host
          │ stdio MCP
          ▼
Stage5 Browser MCP server
          │
          ├── serialized operation queue
          ├── hard deadlines
          ├── privacy-minimized journal
          └── worker lifecycle supervision
                      │ Node IPC
                      ▼
               browser worker
                      │ Playwright protocol
                      ▼
          pinned Playwright Chromium
                      │
                      ▼
          dedicated persistent profile
```

## Boundary decisions

### Own the worker process

The MCP server and browser runtime are separate processes. A timeout enforced inside the same event loop cannot recover from that event loop becoming stuck. The supervisor therefore owns the worker process and can terminate its complete process group before replacement.

### Use Playwright protocol, not CDP attachment

The first slice launches the browser through Playwright rather than attaching to an externally launched Chrome instance over CDP. This provides the higher-fidelity connection and makes browser ownership and cleanup unambiguous.

### Use a dedicated persistent profile

Authentication state may persist across worker restarts, but it is isolated from the user's everyday Chrome profile. Tests receive temporary profiles; the installed product uses an application-support directory outside the source tree.

### Commit-first navigation

Navigation waits for network commit, then performs a separately bounded readiness probe. A page that committed successfully is not reported as a total failure merely because a later lifecycle event was lost or delayed.

### Semantic targeting

The first action tools use ARIA roles and accessible names. They require a unique match and reject ambiguity. Arbitrary script execution and fragile one-off selectors are deferred.

### Local stdio MCP

The initial product is a local stdio MCP server. It exposes a narrow tool surface and does not open a network listener. Remote operation requires a separate threat model.

## Data handling

The supervisor journal records operation identifiers, names, timings, outcomes, recovery state, and sanitized URL origin/path where useful. It must not record tool arguments, DOM/page content, query strings, fragments, headers, cookies, form values, screenshots, or credentials.

Screenshots are captured only through an explicit tool call, stored with restrictive local permissions, and returned only to the invoking MCP client.

## Future boundaries

An optional extension may later bridge an explicitly selected existing Chrome profile. It must remain separate from the default dedicated-profile mode. Service adapters, remote supervision, and a desktop status UI are also independent layers rather than browser-core responsibilities.
