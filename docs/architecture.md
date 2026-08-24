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

The separation has an explicit version boundary. MCP and worker exchange the package and protocol versions during initialization. Completed builds publish a final build stamp only after TypeScript output succeeds, so a live process never treats half-written output as current.

The resident MCP process compares the published worker protocol and tool-catalog versions with the contract it loaded. When both contracts are unchanged, it replaces its worker automatically and restores the active URL on the next browser operation. No MCP reconnect or local deployment is required for ordinary runtime fixes. It returns `MCP_RESTART_REQUIRED` only when the tool catalog or MCP-to-worker protocol actually changes.

### Use Playwright protocol, not CDP attachment

The first slice launches the browser through Playwright rather than attaching to an externally launched Chrome instance over CDP. This provides the higher-fidelity connection and makes browser ownership and cleanup unambiguous.

### Use a dedicated persistent profile

Authentication state may persist across worker restarts, but it is isolated from the user's everyday Chrome profile. Tests receive temporary profiles; the installed product uses an application-support directory outside the source tree.

Authentication uses an explicit process-boundary handoff rather than cookie import, stealth automation, or a guessed login boolean. The controller prepares the target under Playwright, captures only a keyed semantic fingerprint and sanitized route, closes the controlled context, waits for real profile locks to clear, and launches the same isolated profile as a native browser process. Chromium control and native handoff both pin the same `Default` partition inside the same user-data directory; Firefox uses the same explicit profile root. The resolved executable, application name, backend, executable source, user-data directory, profile directory, and effective profile path form one launch identity and must match at reattachment. That launch has no Playwright connection, remote-debugging argument, automation argument, or sandbox override.

The native window receives a static Stage5 identity-marker tab next to the requested login tab, while the handoff result names the browser application's real on-screen identity and a short label. This is important when separate agents have simultaneous Stage5 handoffs under different backends. The user completes credentials/passkey/CAPTCHA/OTP privately and quits the named browser application normally so its process exits; on macOS, closing only a tab/window may leave it running.

Agent browser operations are unavailable while the native process owns the profile. Resume refuses a running process, remaining profile lock, explicit Chromium crash state, launch-identity mismatch, or a caller-supplied non-root post-login route that cannot be reached after the human phase added target-origin session metadata. It never kills the human process, deletes locks, edits exit preferences, or selects cookie values. Clean-shutdown output includes the evidence source so `state: clean` cannot coexist with an ambiguous `exitedCleanly` value for Chromium. Once clean, the controller reopens the same profile under Playwright, removes the static marker tab, compares sanitized boundary and storage-continuity facts, and returns a bounded semantic preview with form-control lines removed. A fresh full semantic snapshot remains required to prove site-specific signed-in state. Exact human clicks and the uncontrolled window's network traffic are intentionally unobservable.

Compatible worker updates are deferred while this handoff is active. The existing worker is allowed to report status and complete resume despite a newly published compatible artifact; the supervisor replaces it before the following operation. This preserves the in-memory native-process handle without weakening the restart boundary for actual tool-catalog or worker-protocol changes.

### Preflight and switch browsers

The MCP host defines a default browser through trusted startup configuration. An agent can inspect the fixed backend registry with `browser_available` and explicitly change the active isolated profile with `browser_switch`. The controller proves the target executable is available before it closes the current context, and the supervisor remembers a successful selection when replacing a failed worker.

Chrome, Brave, and Edge are resolved from allowlisted product installation locations, with an absolute executable-path override available only to the operator. Chromium, Firefox, and WebKit use pinned Playwright runtimes. Each backend receives a separate Stage5 Browser profile by default. This prevents profile locking and avoids mixing authentication state between products while retaining the original bundled-Chromium profile location for existing users. Chromium-engine launches explicitly enable Chromium sandboxing on macOS; diagnostics expose the safe policy decision rather than the raw process command line.

### Commit-first navigation

Navigation waits for network commit, then performs separately bounded readiness and client-redirect stabilization probes. Results distinguish requested and final sanitized URLs, include the server redirect chain and observed main-frame URL changes, and classify non-2xx responses as structured warnings. A page that committed successfully is not reported as a total failure merely because a later lifecycle event was lost or delayed, but commit alone is not treated as proof that the requested workflow state was reached.

### Semantic targeting

The primary action tools use ARIA roles and accessible names. They require a unique match and reject ambiguity. A semantic snapshot uses the unique active visible modal as its root when one can be established, so surrounding application depth does not hide portal controls. Multiple unresolved modals produce a warning and a document snapshot instead of an arbitrary choice. Each single capture issues one random snapshot ID and Playwright element-reference map; reference clicks require that exact latest snapshot, frame, document version, and observed ref. Any action or navigation invalidates the capability.

Clicks can carry bounded URL, selected-state, and visible-element postconditions. Failure says explicitly that the click was dispatched, so a caller does not replay a potentially consequential action. Scrolling and rendered-text search use fixed internal operations rather than exposing arbitrary script execution or fragile one-off selectors.

Frames are explicit capabilities rather than hidden traversal. `browser_frames` inventories the active page and issues opaque, session-scoped IDs. Snapshots and semantic actions accept one of those IDs, including for cross-origin frames. Detachment or navigation invalidates the ID, forcing the caller to observe current frame state before acting again. Journaled frame URLs are reduced to origin and path.

### Local stdio MCP

The initial product is a local stdio MCP server. It exposes a narrow tool surface and does not open a network listener. Remote operation requires a separate threat model.

## Data handling

The supervisor journal records operation identifiers, names, timings, outcomes, recovery state, and sanitized URL origin/path where useful. It must not record tool arguments, DOM/page content, query strings, fragments, headers, cookies, form values, screenshots, or credentials.

Screenshots are captured only through an explicit tool call, stored with restrictive local permissions, and returned only to the invoking MCP client.

Launch diagnostics expose only allowlisted cause categories, selected backend, exact application/profile binding, profile writability/known lock names, build metadata, sandbox policy, control mode, known automation-argument policy, an observed `navigator.webdriver` boolean when a controlled page exists, and static suggested actions. Offline authentication boundaries expose every allowlisted cookie-database location, modification timestamps, and target-origin/session/persistent presence booleans. Cookie-key identifiers are hashed in-process only for before/after set comparison and are never returned; cookie values are never selected. While Chromium is live, SQLite rows are non-authoritative because the browser may hold a valid in-memory cookie jar while migrating stores, so Stage5 Browser reports file metadata and sets presence booleans to `null`. Page diagnostics retain bounded category/count/status records for successful, redirected, failed, and HTTP-error requests; they also isolate events whose timestamps fall within the most recent click window. Raw console and exception text is represented only by a process-local keyed fingerprint; request bodies, headers, queries, fragments, form values, and full launch arguments are never retained or returned. The journal may store the allowlisted cause and backend but never the raw launch error or filesystem configuration supplied by an operator.

## Future boundaries

An optional extension may later bridge an explicitly selected existing Chrome profile. It must remain separate from the default dedicated-profile mode. Service adapters, remote supervision, and a desktop status UI are also independent layers rather than browser-core responsibilities.
