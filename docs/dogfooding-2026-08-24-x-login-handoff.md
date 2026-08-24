# X login handoff dogfooding: Stage5 Browser 0.4.1–0.4.5

## Stop condition

A second agent stopped the Rick Rubin workflow at X's visible login modal. It did not resume authentication, enter account data, or fall back to another browser integration. That was the correct fail-closed response because Stage5 Browser could not establish whether the modal's **Continue** action had completed.

The relevant journal operations are:

- `002e4159-669d-4351-921d-ec915247220b`
- `10eb4cf6-9f82-4962-a8e3-fb02af95a450`
- `6c9f966e-09ff-4968-a955-ffbf4c40424c`

The privacy-minimized journal confirms that the controller's selected tab and authentication page diverged, and that semantic inspection did not expose controls which rendered-text inspection could see. The journal does not contain credentials, form values, page text, queries, fragments, or OTPs.

## Root causes and generic fixes

| Observed failure | Root cause | 0.4.1 remedy |
| --- | --- | --- |
| The user saw login tab 0 while MCP reported tab 5 active | The handoff target was recorded after navigation stabilization. A page opened during that interval could overwrite the controller's active-page pointer. | Pin the intended page before navigation; prevent new-page events from stealing it; reconcile the uniquely visible browser tab on status, tab, authentication, and action boundaries; make `browser_select_tab` explicitly rebind the handoff target. |
| The snapshot detected a dialog but omitted Username and Continue while rendered-text search saw them | The bounded ARIA snapshot began at the entire document, spending its depth budget on surrounding application structure before reaching a portal/modal subtree. | When exactly one visible modal exists, take one reference-bearing ARIA snapshot rooted at that modal. When several modals are visible and none is uniquely active, snapshot the document and return `ambiguous_visible_modals` instead of guessing. |
| Brave visibly launched with `--no-sandbox` on macOS | Playwright's Chromium sandbox option defaults to disabled and adds `--no-sandbox` unless the caller enables it. | Set `chromiumSandbox: true` for Chromium-engine browsers on macOS. Diagnostics report the safe launch policy and known security-relevant arguments, while explicitly stating that the list is not a complete command line. |
| A stalled Continue click could not be explained | Only the top-level operation outcome was available; there was no bounded page-event or actionability evidence. | Buffer sanitized console categories, page-error counts, failed-request categories, HTTP error statuses, and the most recent click outcome. Click failures include visibility, enabled state, viewport state, and pointer interception without raw messages, exception text, headers, bodies, URL queries/fragments, or entered values. |

Playwright distinguishes transport failures (`requestfailed`) from HTTP error responses, so Stage5 Browser records them separately. It also treats action dispatch and postcondition success as separate facts; neither an error nor a timeout causes an automatic replay.

Primary implementation references: Playwright's [BrowserType API](https://playwright.dev/docs/api/class-browsertype) documents `chromiumSandbox` and persistent-context launch behavior; its [Page API](https://playwright.dev/docs/api/class-page) and [Request API](https://playwright.dev/docs/api/class-request) define console, page-error, response, and request-failure events; and the [Locator ARIA snapshot API](https://playwright.dev/docs/api/class-locator#locator-aria-snapshot) defines the reference-bearing semantic capture used here.

## Regression fixture

The controller suite now reproduces the combined failure locally:

1. Login is opened while a delayed popup is created during the handoff window.
2. The login page is restored as the visible and pinned authentication target.
3. Explicitly selecting the popup and then the login tab updates the handoff target deterministically.
4. Username and Continue sit under ten layers of surrounding document structure, but a depth-4 modal snapshot still exposes both controls and usable refs.
5. A transparent cover intercepts Continue. The click fails as `pointer_intercepted` with `clickDispatched: false`.
6. Console, page-error, and HTTP-404 diagnostics are classified, while fixture secrets and URL parameters are absent from serialized output.
7. Launch-policy tests verify that macOS Brave has sandboxing enabled and no reported `--no-sandbox` argument.

## 0.4.1 follow-up: click dispatch succeeded but X did nothing

The next dogfooding pass confirmed the 0.4.1 tab, modal, sandbox, and actionability fixes. It then tested **Continue** and **Use password** once each. Both controls were visible, enabled, in view, uncovered, receiving pointer events, and successfully dispatched; neither produced a route change, DOM change, password field, failed request, or HTTP error. The controlled Brave diagnostics still reported `--enable-automation`. X silently rejecting an automated environment was therefore the strongest remaining hypothesis, but the evidence did not prove service-side intent.

Relevant operations:

- handoff: `71c6309d-8f98-41b8-8e73-e5b8afb2371b`
- Continue click: `d1df9482-2f2d-4405-a9ee-716f5c59b409`
- Continue diagnostics: `f3a9dd51-180d-4da3-8440-dfe696faf747`
- Use password click: `39015ede-620c-485c-80b3-fc5859e541d9`
- final diagnostics: `ff5d89d0-89ff-4b94-a0c6-32fd1a7b0521`

The original workflow remained paused and no further X action was attempted.

## 0.4.2 remedy: a real human browser boundary

The request/resume tools now implement a process boundary instead of keeping Playwright attached:

1. The controlled browser prepares the requested login route and retains only a sanitized URL plus a keyed semantic fingerprint.
2. Playwright closes its persistent context and waits for the dedicated profile locks to clear.
3. Stage5 Browser launches the selected native Chromium or Firefox executable against the same isolated profile. The argument builder supplies only the profile directory, a new-window directive, and the target URL—no Playwright connection, remote debugging, `--enable-automation`, `--no-sandbox`, or webdriver-masking script.
4. Every agent browser operation fails closed while the native window owns the profile. The user authenticates privately and quits that dedicated browser normally so its process exits; on macOS, closing only a tab/window may leave Brave running.
5. Resume refuses a running process, a remaining profile lock, or an explicit Chromium crash state. It never kills the human process, removes locks, or edits Chromium exit preferences.
6. Once the profile is clean, Playwright reopens it. The result reports only sanitized before/after route and semantic-fingerprint changes and requires a fresh snapshot for authentication proof.

Exact manual clicks and network traffic cannot be captured during a genuinely uncontrolled window without violating the boundary. Stage5 Browser says that explicitly through `exactUserInteractionsObserved: false`. Controlled click diagnostics now retain bounded sanitized 2xx/3xx/4xx/5xx response records and isolate the request events whose timestamps fall within the latest click window. Automation diagnostics separately report control mode, known `--enable-automation` presence, and the observed `navigator.webdriver` boolean when a controlled page exists; during native handoff, the latter is `null` because the page is deliberately not instrumented.

Regression coverage proves the native argument allowlist, control lockout, still-running refusal, clean and crashed Chromium profile states, successful requests around a controlled click, boundary comparison, `navigator.webdriver` reporting after reattachment, and a graceful compatible-worker shutdown interval. A real-browser smoke check uses a temporary profile and local fixture only; it does not touch X or the persistent Stage5 profile.

## 0.4.3 follow-up: identity and session continuity

The uncontrolled X login completed, but the signed-in state was not visible after controlled reattachment. The human browser exited normally with no profile locks; restored tabs showed signed-out controls, and opening the account home route redirected to the public root. The relevant operations are:

- human handoff: `aeed7e50-5774-4dfe-bbf4-a383412a78ef`
- clean resume: `c4d0d9ad-00d9-4684-a490-c2eebbd36d81`
- logged-out snapshot: `0af0f97f-fadb-40b7-92a8-237a2329b0d1`
- restored tabs: `7631d28a-12f7-4ac5-82ad-65823819f8c4`
- account-home redirect: `f9ef1763-c942-4ba6-8602-78c5aebcdb89`

A separate agent then requested a Twinkle login handoff under bundled Chromium (`00c09df6-e17e-41d6-b99c-5ed9ec83a0d2`). The resulting application was Google Chrome for Testing while another authentication workflow used Brave. The generic instructions still mentioned Brave, and neither result supplied a durable executable/profile identity. With concurrent agent sessions, this made wrong-window login predictable.

The retrospective privacy-safe inspection did **not** prove a Brave profile-directory mismatch: both paths pointed at the dedicated Brave user-data root, Chromium's `Default` partition was last used, and target-origin persistent-cookie presence remained true after reattachment. No cookie name or value was read or returned. The remaining evidence therefore had to distinguish executable/profile drift, actual cookie-key continuity loss, and a site that remains logged out despite preserved storage.

Stage5 Browser 0.4.3 makes those distinctions explicit:

1. Chromium control and native handoff both pin `--profile-directory=Default` under the exact same user-data directory. The resolved executable, application name, executable source, user-data directory, profile directory, and effective profile path form one launch identity.
2. Request, status, diagnostics, and resume report that identity. Resume fails before reattachment if the selected backend, executable, or profile binding differs from the human handoff.
3. The human window includes a static Stage5 identity-marker tab next to the target sign-in tab. Instructions name the actual application—Brave, Google Chrome for Testing, Chrome, Edge, or Firefox—the selected backend, target origin, profile partition, and a short handoff label. No instruction hardcodes Brave.
4. Before native launch and after the human process exits, resume compares privacy-minimized cookie-database metadata: every allowlisted database location, modification times, target-origin/session/persistent booleans, and non-exported hashes of cookie keys. Cookie values are never selected. While the controlled browser is live, SQLite rows are explicitly treated as non-authoritative because Chromium may hold valid cookies in memory while migrating or rewriting its stores; the live observation therefore reports file metadata with presence booleans set to `null`.
5. A clean Chromium state can no longer contain `exitedCleanly: null`. The result reports the effective boolean plus whether it came from the explicit preferences flag, exit type, or profile-lock evidence.
6. Origin-only authentication URL expectations are rejected as too weak. When the human phase added target-origin session metadata but reattachment cannot reach a caller-supplied non-root post-login route, resume returns `AUTH_NOT_PERSISTED`. Resume also returns a bounded semantic preview with form-control lines removed, allowing the agent to stop immediately when signed-out controls remain even if storage continuity itself is preserved.
7. The marker tab is removed after controlled reattachment; it does not become part of the agent's working tab set.

The disposable native acceptance opens a temporary Brave profile on a localhost fixture, proves `navigator.webdriver === false`, writes a non-sensitive persistent test marker, exits cleanly, and reattaches through the exact same Brave executable and `Default` partition. The controlled fixture receives that marker, the launch identities match, and the marker remains in the offline database after controlled shutdown. The acceptance also caught and fixed a diagnostic false negative: Brave can expose both legacy and `Network/Cookies` stores during migration, so offline inspection now unions all allowlisted locations instead of stopping at the first existing database. X, Twinkle, and all personal browser profiles remain untouched by the acceptance test.

## 0.4.4 follow-up: stale shutdown marker

The next real X handoff exposed a false-positive shutdown gate. The user quit Brave with Cmd-Q, and Stage5 observed exit code `0`, no signal, no remaining profile locks, a stopped human process, and the same pinned `Default` partition. Reattachment was nevertheless rejected because Brave's stored `profile.exit_type` remained `Crashed`. The rejected resume was operation `806b14f3-929b-436f-a91b-7732b6c7100e`; operation `423b16a6-5046-487f-9ad5-bc2573356ecf` confirmed the handoff state remained pending. No controlled reattachment or Rick Rubin workflow action occurred.

Stage5 Browser 0.4.4 changes the decision boundary:

1. Current-session evidence wins: exit code zero, no exit signal, and zero locks is sufficient to reattach the exact same profile.
2. Chromium's stored `exit_type` and `exited_cleanly` values remain visible diagnostics but are no longer authoritative gates.
3. Stage5 snapshots the marker and Preferences modification time immediately before native launch, then classifies the post-handoff marker as unchanged, rewritten with the same value, changed, or unavailable. A stale pre-existing `crashed` marker is therefore explicit rather than blamed on the current session.
4. A genuinely abnormal or unavailable process exit still pauses once. Because the process is already gone and the profile is unlocked, the suggested action says not to repeat login or Cmd-Q; one deliberate second `browser_resume_after_login` call is the explicit override for that same isolated profile.
5. Regression coverage reproduces the exact zero-exit/stale-crash combination and proves reattachment succeeds. Separate coverage proves the bounded override is unavailable until the process is gone and locks are clear.

## 0.4.5 follow-up: X storage boundary

A fresh 0.4.4 worker cleared the shutdown gate and started the configured Brave `Default` partition, but X still rendered signed out. Operation `48b7d7c8-47d0-4a70-b106-5940f1b96c0c` established the 0.4.4 worker; `24d4e296-c687-41b1-a5d2-f01069a6ca79` started the existing profile; `7154b202-1018-4e05-864d-5fbac7cf0a29` showed `/home` redirecting to the logged-out root; `6673a795-bb0b-4a99-b786-4b20a3a701a0` captured the logged-out form; and `af87c8cf-7e71-4a57-aa0e-e98a833c876d` observed X's `bundle.LoggedOutAppModules`. That sequence proved the visible outcome, but it could not say whether storage disappeared at controlled launch, during a restored X load, or on the later explicit X navigation.

Stage5 Browser 0.4.5 adds that missing boundary evidence:

1. Immediately after the native browser exits, it records privacy-safe offline target-origin database metadata and cookie-key presence.
2. Immediately after Playwright starts, before Stage5 explicitly navigates to the target, it reads the live context and reduces cookies to domain/name/expiry facts. It also records whether a target-origin tab was already restored and the initial `navigator.webdriver` value.
3. After the target route stabilizes, it takes the same privacy-safe live observation again.
4. Chromium's actual runtime Profile Path is obtained from a live browser diagnostic surface, canonicalized for macOS filesystem aliases, and compared with the configured binding. Raw command-line arguments are never returned.
5. `lossBoundary` distinguishes `playwright_start`, `playwright_start_or_restored_target_load`, `target_load`, `none`, and `unverified`. `automationCorrelation` reports only whether loss followed an observed automated context; it does not claim that webdriver caused it.

Interpret the next result conservatively. `playwright_start` directs investigation toward profile/keychain or controlled-launch defaults. `playwright_start_or_restored_target_load` requires preventing or accounting for session restore before separating those causes. Repeated `target_load` plus `loss_after_automation_exposure` is the evidence threshold for prototyping extension-based control inside native Brave. `none` plus logged-out UI means cookie-key presence survived but X rejected, expired, or otherwise did not accept the state; values remain deliberately unavailable.

## Resume condition

0.4.5 is a compatible output/behavior patch: tool count 22, input schemas, tool-catalog version 3, and worker protocol 3 are unchanged. A directly registered live host rolls its worker forward on the next operation without a reconnect, reinstall, or deployment, unless a private handoff is currently in progress. Before one new X handoff, verify `restartRequired: false` and worker version `0.4.5`, explicitly select Brave, and use a non-root post-login URL when stable. After resume, report `runtimeProfile`, `lossBoundary`, `automationCorrelation`, `targetOriginLoadedAtControlledStart`, all three storage observations, and the fresh visible X state. Do not repeat login or begin extension-control work until those results establish the boundary. The Rick Rubin workflow remains paused until this verification.
