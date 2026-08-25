# Facebook native-window activation dogfooding: Stage5 Browser 0.6.5

## Finding

Stage5 Browser 0.6.4 correctly proved that the intended Facebook page was controller-selected and that Playwright's `Page.bringToFront` completed. The renderer also reported document focus, but `document.visibilityState` remained `hidden`. The exact-ref guard therefore failed safely as `page_not_active` and dispatched no input.

That evidence isolates the missing boundary: selecting a browser target is not the same as restoring and foregrounding its native Chromium window when macOS has hidden or minimized the application.

Privacy-safe evidence supplied by the dogfood agent:

- status: `879ef63c-2645-4644-8bd9-5daaf374d4d1`
- fresh snapshot: `00f90273-d442-4c9e-9e5a-03f1f300a491`
- blocked click: `f0305c94-6406-409b-aa14-02747946e10b`
- diagnostics: `b4ce5d00-e31b-4cb7-87f4-8e951b91bcf8`

No Facebook action completed during the failed run.

## 0.6.5 remedy

When the selected controlled page remains hidden after the normal Playwright foreground request, Stage5 Browser now performs a bounded owned-window activation sequence:

1. Confirm that the page is still the controller-selected page and that the controlled launch identity is Chromium.
2. Resolve the exact target's Chromium window through its page-scoped CDP session.
3. If that exact window is minimized, restore only that window to its normal state and verify that it is no longer minimized.
4. Foreground only the exact Stage5-owned browser process on macOS. The PID comes from the authenticated native-control record or the live singleton lock of the already-controlled dedicated profile. Stage5 never chooses by application name, browser brand, window title, URL, or page text.
5. Bring the exact page target forward again and poll `document.visibilityState` for a bounded 750 ms.
6. Dispatch input only if the final renderer observation is `visible`; otherwise retain `page_not_active` with `actionDispatched: false`.

The macOS implementation uses the operating system's running-application API through a bounded native helper process. It does not require Accessibility-driven coordinate automation and cannot target the user's default browser profile. Unsupported platforms, missing or dead owned PIDs, unresolved target windows, failed restoration, failed native activation, and unchanged visibility all remain fail-closed.

`pageActivation.nativeWindow` now reports only privacy-safe facts: whether recovery was required and attempted, support and owned-process availability, target-window resolution, an allowlisted window-state category, restoration and application-activation booleans, and a sanitized result. It never returns the PID, native window ID, title, geometry, executable arguments, URL, or page content.

## Regression acceptance

Automated regressions prove that:

- singleton ownership accepts only a live PID encoded by the dedicated Chromium profile's symlink and rejects regular files or dead owners;
- the native adapter invokes only the exact verified PID and sanitizes failure/timeout outcomes;
- a hidden selected page can become visible through target-window preparation plus owned-process activation, after which the original exact ref clicks once and satisfies its postcondition; and
- a native activation call that does not make the renderer visible still dispatches no input and reports `visibility_unchanged` under `page_not_active`.

A gated macOS smoke also launches only a temporary isolated Chromium profile, puts its exact native window into the real minimized state, verifies the asynchronous restore with a bounded poll, activates the exact owned process through AppKit, and confirms that screenshot capture remains usable:

```bash
STAGE5_BROWSER_NATIVE_WINDOW_SMOKE=1 \
STAGE5_BROWSER_ALLOW_FOCUS_CHANGE=1 \
PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers \
npx vitest run tests/native-window-activation-smoke.test.ts
```

This smoke necessarily takes desktop focus because foreground activation is its acceptance criterion. Run it only for native-activation work and disclose the expected interruption; the opt-in is a technical safeguard, not a repetitive approval gate. The ordinary headless suite never moves desktop focus.

## Update lifecycle

This is a compatible worker behavior and additive diagnostic update. Stage5 Browser 0.6.5 retains worker protocol 5, tool catalog 5, and the 23-tool surface. The direct `stage5_browser` registration loads the completed worker on the next operation. No deployment, marketplace reinstall, cachebuster, host reconnect, duplicate registration, or repeated login is required.

The paused agent must take a fresh snapshot because the blocked click consumed the old ref, then retry once with the same visible-state postcondition.
