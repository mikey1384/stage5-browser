# Chromium exact-process foreground recovery

Date: 2026-08-25
Release: 0.6.10 (compatible runtime update; tool catalog 5, worker protocol 5)

## Observed failure

Stage5 Browser 0.6.9 loaded successfully and truthfully diagnosed the original hidden-application problem, but one fresh Facebook click still failed closed before input. The exact owned signed-in Chrome process was unhidden, the target page was controller-selected, and AppKit accepted the activation request; the process nevertheless remained non-frontmost and the renderer remained hidden.

Independent Coinbase Business dogfooding reproduced the same boundary in the dedicated Brave profile. The exact target was visible, enabled, in view, pointer-receiving, and uncovered. Controller selection, CDP `bringToFront`, native target-window resolution, and the AppKit request all succeeded, but the unhidden exact owned process did not become frontmost. The click returned in about 1.9 seconds with definite false dispatch evidence. No trusted input, fallback click, replay, state change, save, submission, or transaction occurred.

Evidence:

- Facebook worker recovery: `0f9df40d-e14c-48a4-978d-5bdc9261adea`
- Facebook snapshot: `b7b43e15-2692-49d0-8bd3-c62739a6eb25`
- Facebook blocked click: `ea0661df-5949-4cd0-afac-27f3e79c9365`
- Facebook diagnostics: `9f1c983c-a3b3-4e82-a923-613618bc36c5`
- Coinbase snapshot: `295120f6-12c9-402a-b82c-25fd2e5e95c6`
- Coinbase blocked click: `2256dec2-0c0d-4d4e-8c14-751d1db7ffec`
- Coinbase diagnostics: `59f84119-48ec-43b2-a97c-5f5f9acddec4`

No signed-in browser profile or service was used during development.

## Root cause

`NSRunningApplication.activateWithOptions` only sends an activation request. Modern AppKit explicitly does not guarantee that the target becomes active, and current macOS cooperative-activation policy may leave an already-unhidden process non-frontmost even when the request is accepted. Version 0.6.9 correctly exposed this distinction but had no second exact-process recovery mechanism.

## Remedy

Stage5 Browser 0.6.10 retains AppKit as the first bounded request. When its sanitized state proves the exact owned application is unhidden but still non-frontmost, Stage5 uses only the remaining native-activation deadline for one public Process Manager `SetFrontProcess` request against the same already-proven PID. The fallback:

1. resolves a `ProcessSerialNumber` only from that numeric PID;
2. never selects an application by bundle identifier, display name, title, or window geometry;
3. never marks the request as caused by direct user activity;
4. separately reports fallback attempt, exact-process resolution, request success, and observed front-process state; and
5. still requires a fresh CDP target reselection and `document.visibilityState === "visible"` before any input can be dispatched.

If the system runtime or deprecated public Process Manager API is unavailable, the fallback returns bounded failure evidence and the existing `page_not_active` boundary remains fail closed.

Apple documents both relevant constraints: [`activateWithOptions` is an activation attempt rather than a foreground guarantee](https://developer.apple.com/documentation/appkit/nsrunningapplication/activate(options:)), while [`SetFrontProcess` targets one `ProcessSerialNumber`](https://developer.apple.com/documentation/applicationservices/1501042-setfrontprocess) and remains available as a deprecated compatibility API.

## Regression gate

Unit coverage forces AppKit to return an accepted-but-nonfrontmost state and proves exactly one remaining-deadline fallback is attempted, surfaced, and never confused with renderer visibility. The opt-in native smoke launches two disposable Chromium profiles, makes the competing exact-owned process frontmost, proves the intended process is not frontmost, then exercises the production fallback and verifies the intended PID becomes the observed front process. Existing minimized/hidden recovery and final renderer-visibility checks continue in the same smoke. No persistent profile, Facebook page, Coinbase page, or private data is touched.
