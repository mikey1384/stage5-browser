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
        selected Playwright browser backend
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

### Preflight and switch browsers

The MCP host defines a default browser through trusted startup configuration. An agent can inspect the fixed backend registry with `browser_available` and explicitly change the active isolated profile with `browser_switch`. The controller proves the target executable is available before it closes the current context, and the supervisor remembers a successful selection when replacing a failed worker.

Chrome, Brave, and Edge are resolved from allowlisted product installation locations, with an absolute executable-path override available only to the operator. Chromium, Firefox, and WebKit use pinned Playwright runtimes. Each backend receives a separate Stage5 Browser profile by default. This prevents profile locking and avoids mixing authentication state between products while retaining the original bundled-Chromium profile location for existing users.

### Commit-first navigation

Navigation waits for network commit, then performs a separately bounded readiness probe. A page that committed successfully is not reported as a total failure merely because a later lifecycle event was lost or delayed.

### Semantic targeting

The first action tools use ARIA roles and accessible names. They require a unique match and reject ambiguity. Arbitrary script execution and fragile one-off selectors are deferred.

Frames are explicit capabilities rather than hidden traversal. `browser_frames` inventories the active page and issues opaque, session-scoped IDs. Snapshots and semantic actions accept one of those IDs, including for cross-origin frames. Detachment or navigation invalidates the ID, forcing the caller to observe current frame state before acting again. Journaled frame URLs are reduced to origin and path.

### Local stdio MCP

The initial product is a local stdio MCP server. It exposes a narrow tool surface and does not open a network listener. Remote operation requires a separate threat model.

## Data handling

The supervisor journal records operation identifiers, names, timings, outcomes, recovery state, and sanitized URL origin/path where useful. It must not record tool arguments, DOM/page content, query strings, fragments, headers, cookies, form values, screenshots, or credentials.

Screenshots are captured only through an explicit tool call, stored with restrictive local permissions, and returned only to the invoking MCP client.

## Future boundaries

An optional extension may later bridge an explicitly selected existing Chrome profile. It must remain separate from the default dedicated-profile mode. Service adapters, remote supervision, and a desktop status UI are also independent layers rather than browser-core responsibilities.
