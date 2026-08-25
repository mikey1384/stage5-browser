# Coinbase release gate: durable ownership, click certainty, and private input

Date: 2026-08-25
Release: 0.6.6 (compatible runtime update; tool catalog 5, worker protocol 5)

Coinbase onboarding was paused before account or KYC work after dogfooding exposed three release-blocking browser-control defects. This note records the generic fixes; it contains no Coinbase account data.

## 1. Durable profile ownership

Every persistent-profile launch now claims a private atomic `.stage5-browser-ownership.json` lease before the browser starts. The lease records only the browser/engine, a profile-path fingerprint, exact worker and browser process start identities, canonical executable fingerprint, control mode, phase, timestamps, and heartbeat. It is written with user-only permissions.

Inspection distinguishes:

- `current_owner`
- `busy_other_stage5_session`
- `owned_orphaned`
- `abandoned`
- `invalid`
- no Stage5 lease

Only a non-private orphan whose exact process start identity, executable fingerprint, expected browser family, and Chromium singleton owner still agree can be reattached or terminated automatically. A competing takeover uses an exclusive claim, so one worker wins. Invalid, mismatched, or external owners fail closed. Stage5 never deletes browser locks or signals an unknown process.

`browser_available` now combines installation and ownership evidence into `startable`, `owned_active`, `owned_orphaned`, `busy_other_stage5_session`, `external_owner`, or `unavailable`, with an exact safe next action.

## 2. One deadline-safe click engine

Role and snapshot-ref clicks now share the same exact-target dispatcher. One absolute deadline covers resolution, viewport preparation, foreground activation, normal input, guarded fallback, postcondition checks, and evidence finalization. A bounded reserve remains before the supervisor deadline.

The capture guard retains only privacy-safe booleans for target connectivity, geometry stability, trusted pointer/mouse/click events, interception, and state change. Its evidence is mirrored outside the page document, so a successful link navigation cannot erase proof of the click when the old execution context disappears. The terminal evidence is one of:

- click confirmed;
- no input dispatched;
- dispatch ambiguous, requiring authoritative inspection and no replay.

A Chromium/Firefox OneTrust-style consent fixture exercises role and ref paths and confirms exactly one click.

## 3. Firefox handoff release

Private handoff release is retained as:

```text
close_requested → process_exited → profile_unlocked → native private window
```

If one operation budget is insufficient, another `browser_request_login_handoff` continues the same phase instead of launching a second browser. Resume similarly uses its remaining budget to observe the exact native process exit and actual profile unlock.

On macOS, Firefox may leave `.parentlock` on disk after a clean exit. Stage5 now treats that file as active only when the operating system reports a live holder; an unavailable or errored ownership probe fails closed. Chromium shutdown preference markers remain advisory rather than authoritative.

The real native smoke also established a separate limitation: Playwright's pinned Firefox binary reports `navigator.webdriver: true` even when launched directly with no automation flags. Its release/session-continuity gate still passes, but bot-sensitive login/KYC should use Brave, Chrome, or Edge until Stage5 has an unmodified controllable Firefox backend.

## 4. General private interaction

The existing login handoff now explicitly covers passwords, passkeys, CAPTCHAs, OTPs, EINs, identity documents, selfies, and other KYC/private steps. The agent drives the non-sensitive workflow, releases only the exact isolated profile screen, and resumes afterward. Private values and documents never enter agent arguments, conversation messages, or Stage5 diagnostics.

Chromium-family browsers remain open for same-process attachment. Firefox exits normally and restarts only after exact process-exit and unlock evidence. A fresh semantic snapshot remains required after resume; storage continuity is never treated as proof of account state.

## Acceptance coverage

- durable lease atomicity, permissions, heartbeat classification, orphan proof, and competing takeover
- honest backend availability for current, competing, orphaned, external, and startable profiles
- shared role/ref consent dispatch in Chromium and Firefox
- navigation-safe trusted-click evidence
- retained Firefox handoff release and delayed unlock
- stale macOS Firefox `.parentlock` handling
- generic private-input instructions and privacy boundaries
- opt-in native Chromium and Firefox handoff smoke tests using dedicated temporary profiles

Coinbase onboarding remains out of scope for the release tests. It should resume only after the standard suite, MCP smoke test, plugin validation, and native handoff gates pass.
