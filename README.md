# Stage5 Browser

Stage5 Browser is a reliability-first local browser controller for AI agents. It gives Stage5 a dogfoodable alternative to browser integrations that stall, detach, lose state, or leave an action's outcome ambiguous.

It also includes the first headless component of **Stage5 Agent Tools**: an agent-only Lounge that gives local Codex, Claude, and other MCP clients durable shared rooms, inboxes, presence, acknowledgements, and bounded wake waits without a human message-board UI.

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
- discover and target nested scroll surfaces, wait for feed growth, and search currently rendered text without arbitrary script evaluation
- classify every installed backend as startable, currently owned, recoverable, busy in another Stage5 session, or externally owned before an agent tries to launch it
- preserve exact cross-worker ownership through a private atomic per-profile lease and recover only a conclusively proven Stage5 orphan
- release a persistent isolated profile into a visibly marked native browser for passwords, passkeys, tax identifiers, identity documents, selfies, or other private steps, then resume without exposing the user's input
- dispatch role and ref clicks through one deadline-safe exact-target engine whose trusted-event evidence survives document replacement
- stop or explicitly recover the browser
- detect a stale MCP build, diagnose launch preflight/profile failures, automation exposure, sandbox policy, successful/error request classes around the last click, and distinguish worker recovery from browser recovery
- join the shared Stage5 Lounge, exchange durable cross-process messages, acknowledge them, and remain genuinely wakeable while a bounded inbox wait is active

The MCP process supervises a separate worker that owns Playwright and the selected browser. If a command exceeds its outer hard deadline, the supervisor terminates that worker's process group, starts a clean worker, reports the recovery outcome, and does not replay the timed-out action.

The initial production smoke test opened `https://translator.tools`, returned its semantic page structure, and captured a screenshot through MCP.

## Quick start

Requirements: Node.js 22.5 or newer.

```bash
npm install
npm run browser:install
npm test
npm run smoke
```

The ordinary build and test suite is headless and must not take desktop focus. The opt-in macOS native-window smoke deliberately verifies foreground recovery and therefore moves focus; it requires both `STAGE5_BROWSER_NATIVE_WINDOW_SMOKE=1` and `STAGE5_BROWSER_ALLOW_FOCUS_CHANGE=1`. Use it only when native activation is the actual boundary under test and disclose the expected interruption; it is an intentional technical gate, not a repetitive approval workflow.

Run the MCP server directly:

```bash
npm run build
npm start
```

The included `.codex-plugin/plugin.json` and `.mcp.json` package the server for Codex-compatible plugin environments. A host reconnect is needed once after initial registration or a real tool-catalog change. Compatible runtime patches roll forward automatically on the next browser operation—even when the exact build fingerprint changes during a private handoff—and do not require reinstalling or redeploying Stage5 Browser. See `docs/agent-setup.md` for the ChatGPT and Claude connection decision trees, discovery checks, and authentication behavior.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `lounge_join` | Bind this MCP connection to one stable agent identity and shared Lounge |
| `lounge_send` | Send one idempotent coordination-only message to Lounge members |
| `lounge_wait` | Stay genuinely online and wake when a durable inbox message arrives |
| `lounge_ack` | Acknowledge one or more delivered messages as seen or acted upon |
| `lounge_status` | Inspect this agent's Lounge membership, presence, and aggregate pending delivery state |
| `browser_status` | Report MCP/build freshness plus worker, browser, configured and actual runtime profile identity, tab, and active-page state |
| `browser_available` | Report whether every backend is installed and actually startable, already owned, recoverable, busy in another Stage5 session, or externally owned—without launching or closing it |
| `browser_diagnostics` | Diagnose build freshness, durable profile ownership, executable/profile state, sandbox policy, automation exposure, sanitized page events, and successful/error requests around the last action |
| `browser_start` | Launch a requested profile without closing another running browser |
| `browser_switch` | Safely switch to a preflighted isolated browser profile |
| `browser_open` | Navigate with bounded commit, readiness, and client-redirect stabilization; report redirects and HTTP warnings |
| `browser_tabs` | List live tabs, preserve the agent-selected tab across auxiliary pages, and recover the sole remaining tab after closure |
| `browser_select_tab` | Select a tab by an observed index while Stage5 Browser controls the profile |
| `browser_frames` | Inventory the active page's main document and nested frames |
| `browser_snapshot` | Read semantic structure, scope a unique visible modal, and issue document-bound element, hidden-file-input, and nested-scroll references |
| `browser_screenshot` | Explicitly capture a PNG artifact |
| `browser_click_by_role` | Resolve one unique role/name target and use the shared deadline-safe exact-target engine, optionally verifying URL, selected state, or visible state |
| `browser_click_ref` | Incrementally prepare one fresh reference, uniquely rebind feed virtualization, then use the same deadline-safe exact-target engine |
| `browser_set_input_files` | Select authorized regular local files through a fresh file-input ref and report attachment preview, progress, completion, and error evidence |
| `browser_fill_by_role` | Fill one unique role/name target in the main document or an observed frame |
| `browser_fill_ref` | Fill one fresh snapshot-bound textbox/contenteditable, including unnamed active editors, with privacy-safe input/value-match evidence |
| `browser_scroll` | Scroll the document or an observed nested container, optionally wait for article growth/loading completion, and distinguish confirmed ends from stalled feeds |
| `browser_find_text` | Search bounded rendered page/frame text and return matching lines with nearby unique rendered context |
| `browser_wait_for_url` | Wait for an exact, prefix, or substring URL postcondition |
| `browser_auth_status` | Report the private-interaction lifecycle, actual runtime profile, three-phase storage boundary, native application, marker label, and exact profile binding |
| `browser_request_login_handoff` | Retain the controlled release phase, then launch the same isolated profile with a Stage5 marker tab for private user input; instructions distinguish continuous Chromium attachment from Firefox restart |
| `browser_resume_after_login` | Resume after private input by attaching to the same Chromium process or restarting a normally exited, actually unlocked Firefox profile; then require fresh visible verification |
| `browser_recover` | Replace the worker process group and optionally reopen the last URL |
| `browser_stop` | Close the owned browser context |

## Architecture

```text
Codex / Claude / MCP client
        │ stdio MCP
        ▼
MCP server
        ├── Agent Lounge service
        │       │ non-blocking worker-thread RPC
        │       ▼
        │   shared local SQLite WAL
        │
        └── serialized browser supervisor
                │ Node IPC with per-command hard deadlines
                ▼
          Browser worker process group
        │
        ├── atomic per-profile ownership lease + heartbeat
        │
        ├── normal work: direct Playwright protocol
        │
        └── private input: retain release → native Chromium step → same-process attach
                                      │
                                      ├── private loopback control channel
                                      └── dedicated persistent profile
```

The worker boundary is intentional. A stalled browser transport cannot wedge the MCP event loop, and recovery can kill browser descendants rather than merely dropping a stale JavaScript object.

Key implementation files:

- `src/mcp-server.ts` — agent-facing MCP tools and safety annotations
- `src/lounge-service.ts` — per-connection identity, bounded wake waits, and Lounge lifecycle
- `src/lounge-store-client.ts` / `src/lounge-store-worker.ts` — non-blocking access to the shared durable Lounge database
- `src/supervisor.ts` — serialization, deadlines, process-tree replacement, and journaling
- `src/browser-worker.ts` — IPC command dispatch
- `src/browser-controller.ts` — direct Playwright browser operations
- `src/browser-provider.ts` — trusted browser selection and installed-browser discovery
- `src/profile-ownership-lease.ts` — atomic cross-worker profile ownership, heartbeats, orphan proof, and exact owned-process recovery
- `src/chromium-profile-owner.ts` — privacy-safe legacy Chromium lock/CDP ownership reconstruction
- `src/native-window-activation.ts` — exact owned-process activation and Chromium profile-owner resolution
- `docs/agent-setup.md` — Claude connection checks, session restart, and login lifecycle
- `docs/browser-support.md` — support matrix and required agent selection workflow
- `docs/agent-lounge.md` — cross-vendor join, wake, acknowledgement, and relay instructions
- `docs/dogfooding-2026-08-24-x-timeline.md` — X timeline bottlenecks and the generic 0.4 remedies
- `docs/dogfooding-2026-08-24-x-login-handoff.md` — X login diagnostics and the compatible 0.4.1–0.4.6 remedies
- `docs/dogfooding-2026-08-24-x-upload.md` — X attachment, consumed-input, active-tab, selected-state, and dynamic-feed regressions plus the 0.5.0–0.5.1 remedies
- `docs/dogfooding-2026-08-24-facebook-scroll.md` — Facebook nested-scroll, skeleton-wait, fractional-boundary, and scroll-diagnostics regressions plus the 0.6.0 remedy
- `docs/dogfooding-2026-08-24-facebook-find-context.md` — Facebook snapshot-noise finding and the compatible 0.6.1 contextual-search remedy
- `docs/dogfooding-2026-08-24-facebook-offscreen-click.md` — Facebook offscreen-ref and unrelated-loader findings plus the compatible 0.6.1 remedies
- `docs/dogfooding-2026-08-25-facebook-virtualized-ref.md` — Facebook document-scroll virtualization finding plus the compatible 0.6.2 exact-node and article-scoped rebind remedy
- `docs/dogfooding-2026-08-25-facebook-dispatch-boundary.md` — Facebook stable-click timeout finding plus the compatible 0.6.3 exact-target dispatch probe and guarded fallback
- `docs/dogfooding-2026-08-25-facebook-foreground-dispatch.md` — Facebook zero-event handle-dispatch finding plus the compatible 0.6.4 foreground check and guarded page-input fallback
- `docs/dogfooding-2026-08-25-facebook-native-window-activation.md` — Facebook browser-hidden target finding plus the compatible 0.6.5 exact owned-window activation boundary
- `docs/dogfooding-2026-08-25-twinkle-runtime-friction.md` — Twinkle profile-lock, transitioning-role, unknown-dispatch, and managed-capture findings plus their 0.6.4 evidence boundaries
- `docs/dogfooding-2026-08-25-coinbase-release-gate.md` — Coinbase ownership, shared-click, Firefox release, private-input, and availability blockers plus the compatible 0.6.6 remedies
- `docs/dogfooding-2026-08-25-facebook-auth-route.md` — Facebook authentication false-negative caused by incidental post-login query metadata, fixed in 0.6.7
- `docs/dogfooding-2026-08-25-compatible-worker-fingerprint.md` — compatible update during a private handoff falsely required an MCP reconnect, fixed in 0.6.8
- `docs/dogfooding-2026-08-25-facebook-hidden-application.md` — accepted macOS activation request left the selected Facebook renderer hidden, fixed in 0.6.9
- `docs/dogfooding-2026-08-25-chromium-front-process.md` — accepted activation still left unhidden owned Chrome and Brave processes non-frontmost, fixed in 0.6.10
- `docs/dogfooding-2026-08-25-facebook-feed-observation.md` — Facebook loading-only articles, drifting feed scope, and hidden-renderer scrolling fixed in 0.6.11
- `docs/dogfooding-2026-08-25-react-dropdown-openers.md` — React popup openers that replace themselves during pointer input, fixed in 0.6.12 without replay
- `docs/dogfooding-2026-08-25-partial-effects-focus-and-state.md` — partial-input external effects, unnecessary focus stealing, clipped targets, duplicate-tab continuity, unsaved-state-safe updates, and unnamed editor fill fixed in 0.7.0
- `docs/dogfooding-2026-08-25-contenteditable-and-native-dropdowns.md` — bounded exact-handle contenteditable fill evidence and pointer-split avoidance for plain native custom-dropdown buttons fixed in 0.7.1
- `docs/dogfooding-2026-08-25-facebook-fill-preparation.md` — snapshot-captured editor/scope capabilities, post-activation role resolution, exact preparation-step evidence, and truthful pre-keyboard detachment classification fixed in 0.7.3
- `docs/dogfooding-2026-08-25-snapshot-ref-activation-rebind.md` — scope-bound semantic rebinding for a fresh ref replaced during necessary pre-input activation, with ambiguous replacements rejected in 0.7.4
- `docs/dogfooding-2026-08-25-facebook-editor-viewport.md` — Facebook contenteditable viewport preparation no longer waits for Playwright stability when the exact retained editor is already visible, fixed in 0.7.5
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
- Text search preserves the matching rendered line number and returns at most two nearby unique non-empty lines on each side, scanning only a bounded neighborhood so repeated navigation and quote blocks do not swamp the result.
- Hidden file-input references follow the same document-bound, one-use capability model. Local selection accepts only explicit absolute paths to readable regular files, rejects symlinks/directories, never opens a native picker, and never journals or returns absolute paths.
- Unnamed textboxes and contenteditables can be filled only through a fresh snapshot-bound `browser_fill_ref`. It revalidates the exact document, frame, and modal scope, pins the exact observed handle through dispatch, and inspects that handle before viewport preparation. An already-visible in-viewport editor is never subjected to a stability-gated scroll; an offscreen editor receives only one bounded exact-handle DOM scroll before revalidation. The capability is consumed once, the supplied value is never journaled or returned, and the result reports the bounded fill phase, target state, input/change events, and exact logical value-match booleans.
- A unique visible modal becomes the snapshot root; multiple unresolved modals produce a warning instead of an arbitrary choice.
- A dispatched click with an unmet requested postcondition fails as `POSTCONDITION_FAILED` and explicitly reports that the click already happened. The postcondition loop performs a final deadline-bound reconciliation so a state change during its last wait is not falsely reported as failure. If exact-target input is partial or ambiguous but the supplied postcondition is observed, the requested effect is terminal success while diagnostics retain the truthful partial dispatch booleans; Stage5 never replays it.
- A fresh offscreen snapshot ref receives bounded incremental movement on a visible nested or document scroll surface. The controller retains the exact observed DOM node; if feed virtualization detaches it, rebind is allowed only when the same privacy-fingerprinted article and same semantic target are both unique. Global name matching is forbidden. Preparation failures consume the ref and return `actionDispatched: false`; only the later exact-node click phase may return an ambiguous dispatch outcome.
- Role and ref clicks share one absolute deadline across resolution, preparation, activation, normal input, guarded fallbacks, postcondition, and evidence finalization. A reserved finalization window precedes the supervisor deadline. Trusted-event evidence is also retained outside the current document, so navigation cannot erase proof of a completed click. Results are clicked, definitely not dispatched, or ambiguous; partial/ambiguous input is never replayed.
- Clicks verify the controller-selected page immediately before input and record only activation/focus state, native-window result categories, connectivity, geometry-change, and trusted pointer/mouse/click booleans. When its renderer is already visible, Stage5 stays background-safe and does not call `bringToFront` or activate the native application. Only a hidden renderer escalates to exact-page and exact-owned-process recovery. On macOS, a browser-hidden Chromium target is resolved to its exact window, restored if minimized, and recovered only through its verified Stage5-owned PID: Stage5 explicitly unhides that application, activates all of its windows, and, if AppKit leaves that unhidden process non-frontmost, may issue one bounded Process Manager fallback against the same PID. It then reselects the exact target and requires renderer visibility. Native request acceptance, fallback attempt/resolution/outcome, hidden state, frontmost state, and renderer visibility remain separate bounded facts. PIDs, native window IDs, titles, geometry, and coordinates are never returned or journaled. A normal stable-click timeout may use one forced exact-handle fallback only when no trusted event was emitted and the same node remains fully actionable. If both handle paths emit zero events, one guarded page-level mouse dispatch may use the exact clipped visible hit point. Misdirected or newly non-actionable input is blocked; any partial or uncertain dispatch stops without another click unless its requested postcondition is already authoritatively observed.
- Every persistent launch claims an atomic private per-profile lease containing the exact worker/browser start identities, canonical executable fingerprint, control mode, phase, and heartbeat. Status and availability distinguish current ownership, another live Stage5 owner, a conclusively proven orphan, an abandoned record, and genuinely external ownership. Stage5 may reattach or terminate only the exact fingerprint-matched orphan; it never deletes browser locks or kills an unknown owner.
- Status reports profile locks separately from controller connection state, so a stopped worker cannot make an externally owned or still-releasing profile look available. Fresh Chromium starts allow a bounded lock-release interval but never delete lock files. Role targeting waits up to one second for a transitioning control and reports `actionDispatched: false` when it remains absent.
- Screenshots activate the selected page before capture and return `captureEvidence` containing only activation state, PNG byte length, semantic-content presence, a conservative contentful/possibly-uniform classification, and whether one bounded recapture was used. The saved PNG path is authoritative when a managed client renders the returned image incorrectly.
- File selection confirms privacy-minimized name/size metadata during the capture-phase input event or from the retained browser `FileList` before returning. Sites may consume and clear the input without creating a false failure. `observationMs` is a quick-sampling window from 0–5,000 ms; a supplied semantic `completion.timeoutMs` can wait up to 60,000 ms within the overall timeout. The bounded processing result is `completion_observed`, `in_progress`, `error_observed`, or `unverified`; temporal network activity is never presented as proof of upload completion.
- A live agent-selected tab remains active when a transient popup or auxiliary player page appears. Native Chromium control also stores a private opaque target identity so compatible worker replacement restores the exact tab even when duplicate tabs share a URL. If the selected page disappears and exactly one live page remains, the controller deterministically selects that sole page instead of returning `activePageIndex: null`.
- Snapshots expose a bounded set of visible nested vertical scroll containers as opaque one-use refs. Container scrolling requires the exact latest snapshot/frame/document capability and never accepts selectors or guesses a target.
- Downward scrolling uses a one-CSS-pixel boundary tolerance and reports target geometry separately from a confirmed feed end. Earlier growth, a remaining loading indicator, or an unmet bounded article/loading wait followed by no movement is `dynamic_content_stalled`, not `endReached: true`, unless the caller supplies a visible end marker.
- Before collecting a scroll baseline and before every scroll step, Stage5 activates the controller-selected page and requires a visible renderer. A pre-dispatch activation failure returns definite false dispatch evidence; visibility loss after completed steps reports those steps and never replays them.
- Loading waits pin one observation root for the full operation and count only indicators intersecting that selected surface's visible region. A uniquely visible semantic feed may scope a document wait, but a later viewport change cannot silently replace it; detachment returns prompt structured surface-loss evidence with completed-step facts instead of becoming false loader disappearance or consuming the remaining wait. Loading-only semantic status articles count as unresolved loaders rather than rendered articles; unrelated page loaders and statuses inside substantive posts do not prevent feed completion evidence. Reaching a bounded semantic candidate limit returns structured incomplete-observation evidence instead of treating truncated counts as definitive. The separately bounded animation heuristic cannot block semantic article growth or explicit loader disappearance; animation-only disappearance requires a complete heuristic scan.
- Scroll is recorded as the latest sanitized page action, allowing diagnostics to isolate successful, redirected, failed, and HTTP-error requests within that bounded action window.
- A click that cannot dispatch records sanitized visibility, enabled-state, viewport, and pointer-interception evidence.
- Private interaction bootstrap releases Playwright completely, pins the selected profile partition, and launches the exact same native executable/profile identity without automation flags. A static Stage5 marker tab and the returned application-specific label distinguish concurrent handoffs. Browser tools remain blocked until explicit resume; credentials, tax identifiers, identity documents, selfies, and other private values stay outside agent arguments and logs.
- Chromium-family handoffs use a fixed ephemeral loopback-only CDP endpoint. The user leaves the dedicated browser open; resume attaches to that exact process, so in-memory session cookies are never serialized, imported, or restored by a new browser process. A user-only profile record with an explicit `awaiting_user`/`controlled` state lets compatible worker replacements reconnect without allowing a fresh worker to attach during private login. The endpoint is not returned to agents or written to the operation journal.
- Firefox retains the exit-and-restart handoff, modeled as `close_requested → process_exited → profile_unlocked`. An interrupted request/resume continues that retained phase within the remaining operation budget instead of relaunching. On macOS, a persistent `.parentlock` counts as active only while the OS reports a holder. Resume still rejects a running, actually locked, or launch-identity-mismatched profile and never deletes locks or rewrites shutdown preferences.
- The pinned Playwright Firefox binary currently reports `navigator.webdriver: true` even during its uncontrolled native launch despite receiving no automation flags. Use Brave, Chrome, or Edge for bot-sensitive login/KYC; Firefox's private handoff is supported for lifecycle/session continuity but does not claim automation invisibility.
- Chromium resume reports the canonical profile path observed by the running browser and compares it with the configured profile after resolving filesystem aliases. A mismatch fails before target navigation.
- The private phase records no exact manual clicks. Chromium resume samples privacy-safe target-origin cookie-key presence immediately after same-process attachment and after target load; Firefox retains the offline-after-exit checkpoint. A bounded preview and fresh full snapshot remain authoritative for visible authentication state; origin-only URL checks are rejected as too weak. An exact authentication route that omits a query accepts site-added query metadata only when origin, pathname, and fragment still match; explicit queries and all generic navigation/click expectations remain strict.
- A hung or disconnected worker is killed and replaced before another operation proceeds.
- MCP and worker builds complete a versioned protocol handshake; incompatible contract changes fail with `MCP_RESTART_REQUIRED`.
- A running MCP automatically rolls its worker onto compatible completed builds only at a state-safe boundary. Proven native-CDP sessions reattach to the continuously running browser and exact selected tab; connected direct-Playwright contexts defer the update until explicit stop rather than closing the page and losing unsaved state. Only tool-catalog or worker-protocol changes require a host reconnect.
- Worker recovery reports whether a browser was actually running afterward; it never implies that the MCP catalog was refreshed.
- Diagnostic journaling is best-effort and cannot change an operation's result. Page diagnostics include bounded success/redirect/error response classes and the events within the last click window, but exclude raw console/exception text, request metadata beyond method/type/status/sanitized URL, and all URL queries/fragments.
- Exact-target dispatch diagnostics contain only booleans for connectivity, geometry change, trusted event phases, and blocked conditions. They exclude coordinates, selectors, element text, event payloads, and page values.
- Uniquely resolved role targets may be re-resolved once only while input is still definitively absent. A fresh ref replaced during necessary page activation may similarly bind one exact role/name-equivalent control only inside its retained snapshot scope; missing or multiple in-scope replacements fail closed. Accessible native popup buttons use one guarded Enter activation instead of a pointer sequence; any keyboard or pointer detachment remains non-retriable and never enters another transport.

Regression coverage currently includes URL restrictions, privacy-safe journal URLs and diagnostic causes, command serialization, atomic profile leases, competing-worker ownership, exact orphan proof, truthful backend availability, semantic targeting, modal-scoped snapshots, document-bound reference clicks, retained-scope semantic ref rebinding after necessary activation, ambiguous same-scope replacement rejection, incremental offscreen-ref preparation, unique same-article rebinding after feed virtualization, ambiguous replacement rejection, shared role/ref OneTrust consent dispatch in Chromium and Firefox, standard native-button keyboard activation without pointerdown replacement, exact keydown/keyup dispatch evidence, truthful pre-keyboard detachment, one pre-input role re-resolution after necessary activation or scrolling, non-retriable keyboard/pointer detachment, navigation-safe trusted-click evidence, guarded dispatch of continuously moving exact targets, detached-before-dispatch rejection, exact owned-window activation, bounded exact-PID foreground fallback behind a competing disposable browser, browser-hidden fail-closed behavior, and pre-dispatch failure certainty, plus snapshot-captured editor/scope capabilities, exact-handle multiline contenteditable fill without live ARIA/modal rescans, bounded preparation/phase/evidence finalization, hidden-file-input and nested-scroll capabilities, local-file preflight and attachment confirmation, click actionability and deadline-edge postconditions, upload progress/error evidence, scroll-correlated successful requests, fractional scroll boundaries, pinned feed-observation scope, loading-only status placeholders, per-step scroll activation, no-replay visibility loss, feed-scoped loading waits, content-growth waits, dynamic-feed stall classification, contextual timeline text search, server and client redirects, HTTP 429 classification, screenshots, ambiguous matches, cross-origin frames, browser switching, private human interaction, same-process Chromium continuity across worker replacement, retained Firefox release phases and delayed unlock, stale macOS `.parentlock` handling, configured-to-runtime profile verification, stale Chromium exit-marker handling, bounded unlocked-profile override, weak auth-URL rejection, automation exposure, stale-artifact detection, worker protocol mismatches, and deliberate worker hangs followed by PID replacement.

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
- Private interaction launches only the selected browser, pinned dedicated-profile arguments, a new-window directive, a static Stage5 identity-marker data URL, and the target URL. Chromium also receives a fixed ephemeral control port bound to `127.0.0.1`; Stage5 does not attach until explicit resume. The launch does not use Playwright automation arguments, `--enable-automation`, `--no-sandbox`, or webdriver-masking scripts.
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
