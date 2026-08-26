# Durable private-handoff recovery

Date: 2026-08-26
Release: 0.15.1 (compatible worker update; tool catalog 13, worker protocol 12, 54 tools)

## Reproduced failure

A consequential click dispatched exactly once, after which the agent requested private control so the user could handle a one-time secret. Browser release could remain in `close_requested` even though the Playwright context had closed. A worker or host restart then lost the in-memory handoff while the exact dedicated Chromium-family process and its v1 `awaiting_user` control record remained alive. Status could simultaneously expose a stale `process_exited` lease phase and recommend another request.

The live private browser, page, secret, and account were not attached to, inspected, closed, killed, or replayed during investigation.

## Root invariants restored

- A Playwright context close is no longer treated as browser-process exit. Only the retained process ID plus process-start identity can advance the ownership lease to `process_exited`.
- An `awaiting_user` v1 native record can reconstruct the handoff after worker loss when the exact ownership lease still proves the browser process.
- The narrower crash window before browser-process lease persistence is recoverable only after independently proving the configured executable, dedicated profile owner, exact process, unique private loopback CDP endpoint, and Stage5 marker.
- Passive status and availability may reconstruct the in-memory state but never attach. Only one explicit `browser_resume_after_login` may claim the inactive lease, flip the record to controlled, and attach to that same process.
- `browser_request_login_handoff` recognizes the reconstructed handoff and fails closed instead of launching a duplicate browser.
- Native capability records reject unknown top-level fields and malformed timestamps. No URL, page content, form value, secret, or credential is persisted in the handoff record.

## Regression evidence

The disposable headless-CDP regression preserves an unsaved textarea value across recovery, proves the native process was not relaunched, rejects a duplicate handoff request, covers both stale `process_exited` and pre-establish `launching` lease states, and verifies that explicit resume attaches without document replay. Related request, resume, reattachment, lifecycle, ownership-lease, native-control, and native-worker continuity tests pass.

## Safe resume

1. Keep the exact dedicated Chromium-family browser open; do not request another handoff, start or switch a backend, close the process, change locks, inspect the private page, or replay the click.
2. Call `browser_status`, then `browser_auth_status` once. Require version 0.15.1, `restartRequired: false`, `state: awaiting_user`, and a recoverable exact private-handoff owner.
3. Let the user complete only the private step without sending the secret to any agent or Lounge message.
4. Call `browser_resume_after_login` once. If it returns a mismatch or ambiguous result, stop without another attach or action.
5. After `ready_for_agent_verification`, discard old capabilities and take a fresh semantic snapshot before any new authorized action.
