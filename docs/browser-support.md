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
5. Call `browser_frames` before interacting with an embedded application. Select only a frame ID returned by that observation, then pass it as `frameId` to `browser_snapshot`, `browser_click_by_role`, or `browser_fill_by_role`. Use `frameId: null` for the main document.
6. Continue with snapshots and semantic actions. If navigation replaces or detaches a frame, discard its old ID and call `browser_frames` again; frame IDs are intentionally session-scoped capabilities.

Authentication is profile-specific and persistent. A successful Google or X login in `profiles/brave` survives agent and MCP restarts but does not authenticate `profiles/chrome`; none of these profiles reuse the user's daily browser profile. The first login may require the user to complete a password, passkey, CAPTCHA, or OTP in the visible Stage5 Browser window. See `agent-setup.md` for the full lifecycle.

Cross-origin frames use the same semantic action surface as same-origin frames because Playwright owns the browser context. Stage5 Browser does not expose arbitrary JavaScript or CSS selectors as a workaround for inaccessible iframe DOM.

## Recovery behavior

After a successful switch, the supervisor records the selected backend. If a later operation wedges the worker, hard recovery starts the same backend and profile rather than falling back to Chromium. A failed preflight leaves the current browser and its tabs running.
