# Browser support

Stage5 Browser exposes one semantic automation surface across multiple isolated browser backends. An agent chooses a named backend; it never supplies an executable path or attaches to a person's everyday profile.

| Selection | Engine | Runtime source | Isolated profile |
| --- | --- | --- | --- |
| `chromium` | Chromium | Pinned Playwright runtime | `profiles/default` |
| `chrome` | Chromium | Discovered Google Chrome installation | `profiles/chrome` |
| `brave` | Chromium | Discovered Brave installation | `profiles/brave` |
| `edge` | Chromium | Discovered Microsoft Edge installation | `profiles/edge` |
| `firefox` | Firefox | Pinned Playwright runtime | `profiles/firefox` |
| `webkit` | WebKit | Pinned Playwright runtime | `profiles/webkit` |

The installed Safari application is not the same runtime as Playwright WebKit. Supporting Safari itself requires a separate WebDriver adapter and user-enabled Safari Remote Automation; Stage5 Browser does not claim that support yet. Other Chromium brands can be used only through a trusted operator-supplied `STAGE5_BROWSER_EXECUTABLE_PATH`, never through an agent argument.

## Agent workflow

For any workflow that depends on a particular browser or authenticated profile:

1. Call `browser_available`.
2. Confirm the requested backend reports `available: true`. If it does not, stop and report its structured reason; do not guess or silently fall back.
3. Call `browser_status`. If no backend is running, call `browser_start` with the requested browser; this path does not require closing tabs. If a different backend is already running, call the explicitly destructive `browser_switch`, which preflights again before closing current tabs.
4. Call `browser_status` again and verify the returned `browser` matches the request.
5. Call `browser_auth_status` when the workflow requires an account. If the profile needs login, explicitly select the intended backend, then call `browser_request_login_handoff` with the login URL. It releases Playwright and launches the same exact executable/profile binding as an uncontrolled native browser. Match the returned application name and short label to the static Stage5 marker tab next to the sign-in tab; this distinguishes simultaneous handoffs in Brave, Chrome, Chromium, Edge, or Firefox. While the result is `awaiting_user`, do not call browser-control or recovery tools. Let the user complete credentials/passkey/CAPTCHA/OTP privately and quit that exact application normally so its process exits. Then call `browser_resume_after_login` with a non-root post-login URL if one is stable, or no URL expectation. A stale Chromium `crashed` marker does not block a current zero exit with no signal and no locks. If the process exit is abnormal or unavailable, follow the returned one-time unlocked-profile override without deleting locks, forcing shutdown, or repeating login. Stop on a mismatched identity or `AUTH_NOT_PERSISTED`. Compare the actual runtime profile and the after-human, after-controlled-start, and after-target-load storage observations before interpreting a failure. Treat `automationCorrelation` as evidence, not causality. Inspect the returned semantic preview immediately, then take a new full snapshot and prove the site's signed-in state; neither storage continuity nor the sanitized boundary comparison alone proves authentication.
6. Call `browser_frames` before interacting with an embedded application. Select only a frame ID returned by that observation, then pass it as `frameId` to frame-aware tools. Use `frameId: null` for the main document.
7. Continue with snapshots and semantic actions. When `browser_snapshot` reports `scope: "modal"`, use the controls and refs from that single active-modal capture. If it warns `ambiguous_visible_modals`, inspect without guessing. If navigation replaces or detaches a frame, discard its old ID and call `browser_frames` again; frame IDs are intentionally session-scoped capabilities.
8. When a snapshot exposes an unnamed element reference, pass both its `snapshotId` and observed `ref` to `browser_click_ref`. A reference is valid only for the latest snapshot of that exact frame and document and is consumed by an action.
9. For a click that is supposed to change state, supply a postcondition such as an expected URL, selected state, or visible element. `POSTCONDITION_FAILED` means the click was already dispatched but the requested result was not observed; inspect before any retry.
10. Use `browser_scroll` to advance infinite timelines and `browser_find_text` to search what is currently rendered. A scroll warning that the document position did not change is evidence to inspect for a nested scroll container or timeline end, not permission to guess coordinates.
11. After a click stalls or fails, call `browser_diagnostics`. Use its sanitized target visibility, enabled-state, viewport, pointer-interception, dispatch, page-error, and request/response classifications to choose the next step; never infer safety from a generic timeout or replay a possibly dispatched action.

Authentication storage is profile-specific and persistent by design. A session accepted in `profiles/brave` does not authenticate `profiles/chrome`; none of these profiles reuse the user's daily browser profile. The first login uses the request/resume bootstrap so the user completes a password, passkey, CAPTCHA, or OTP in a native window with no Playwright control or automation flags. The user quits that dedicated browser normally before the agent reattaches. Stage5 Browser verifies binding and storage continuity, but the site's visible post-resume UI remains the authority on whether the session is authenticated. See `agent-setup.md` for the full lifecycle.

Cross-origin frames use the same semantic action surface as same-origin frames because Playwright owns the browser context. Stage5 Browser does not expose arbitrary JavaScript or CSS selectors as a workaround for inaccessible iframe DOM.

Chromium-engine backends (`chromium`, `chrome`, `brave`, and `edge`) run with Chromium sandboxing explicitly enabled on macOS. Other platforms retain Playwright's platform launch policy until they receive their own verified compatibility coverage. `browser_diagnostics` states the effective safe policy and marks its argument list incomplete rather than exposing a raw command line.

During human authentication, Chromium-engine and Firefox backends instead run as their native executable with only pinned dedicated-profile arguments, a new-window directive, a static Stage5 marker data URL, and the target URL. WebKit has no native human-bootstrap adapter and fails with `AUTH_HANDOFF_UNAVAILABLE`; it does not silently fall back to another browser.

## Recovery behavior

After a successful switch, the supervisor records the selected backend. If a later operation wedges the worker, hard recovery starts the same backend and profile rather than falling back to Chromium. A failed preflight leaves the current browser and its tabs running.
