# Facebook hidden-application activation

Date: 2026-08-25
Release: 0.6.9 (compatible runtime update; tool catalog 5, worker protocol 5)

## Observed failure

A fresh signed-in Facebook snapshot succeeded and exposed one exact `See more` reference for the intended post. The single click attempt failed safely as `page_not_active` with both dispatch booleans false. The target was connected, visible, enabled, in the viewport, pointer-receiving, and uncovered. Controller selection, Playwright `bringToFront`, target-window resolution, window normalization, and the native application activation request all reported success, but the renderer remained `hidden` before and after. No trusted pointer, mouse, or click event was observed; no fallback or retry ran.

Evidence:

- snapshot operation: `e74b476f-a6de-4c46-816f-07e5f4e0d934`
- snapshot ID: `dc4ae748-e8a1-4021-8f85-217b0f493fa0`
- consumed exact ref: `e1442`
- blocked click: `39272677-3017-4d5e-98c6-38241206b3a7`
- diagnostics: `2a7580bf-5aa9-46bd-9693-44f682608341`

No Facebook action was performed, and the signed-in Chrome profile was not used during development.

## Root cause

The macOS helper called `NSRunningApplication.activateWithOptions` with only the ignore-other-apps option and treated its Boolean return as successful native activation. That return proves only that AppKit accepted the activation request. Stage5 neither explicitly unhid a hidden application nor requested that every window in the exact owned browser process be brought forward, and it did not observe the process's hidden/frontmost state after the request.

## Remedy

Stage5 Browser 0.6.9 keeps the same exact-process safety boundary and now:

1. resolves only the proven Stage5-owned browser process and exact CDP target window;
2. observes whether that application is hidden and explicitly unhides it when necessary;
3. combines AppKit's all-windows and ignore-other-apps activation options for that exact process;
4. advances the AppKit run loop within a fixed bound and returns only bounded Boolean state evidence;
5. distinguishes request acceptance, unhide outcome, frontmost state, and final renderer visibility; and
6. reselects the exact Playwright page once the owned application is unhidden, while still blocking all input unless the renderer finally reports `visible`.

The native helper captures at most 4 KiB of fixed-shape JSON and never returns the PID, native window ID, title, geometry, URL, page text, or raw command output.

## Regression gate

Unit coverage proves that an accepted activation request is not classified as a verified foreground application when AppKit's resulting state disagrees. The opt-in macOS native smoke uses only a disposable Chromium profile: it restores a minimized exact window, explicitly hides the exact owned application, proves Stage5 observed that hidden state, unhides it, reselects the renderer, verifies final visibility, and closes the profile.

Because the failed ref was consumed, the Facebook agent must take a fresh snapshot before any later action. It must not reuse `e1442` or repeat login. After verifying worker 0.6.9 and the signed-in page, it may perform at most one newly observed click under its existing workflow authorization.
