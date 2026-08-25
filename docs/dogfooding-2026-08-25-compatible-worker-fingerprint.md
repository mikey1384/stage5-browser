# Compatible worker fingerprint handoff

Date: 2026-08-25
Release: 0.6.8 (compatible runtime update; tool catalog 5, worker protocol 5)

## Observed failure

A private Facebook authentication handoff retained its state while the completed Stage5 Browser build advanced from 0.6.6 to 0.6.7. The old worker disconnected as designed, but its replacement loaded the compatible new build while the resident MCP host still held the earlier exact build fingerprint. Initialization returned `MCP_RESTART_REQUIRED` even though both sides reported worker protocol 5.

Relevant operations:

- old-worker disconnect: `d693f154-d86c-45bf-b64c-660ac32f97ed`
- false restart requirement: `611ae3a3-4cd3-42ae-bb54-5fbb1eb37970`

No Facebook action was performed.

## Root cause

The normal compatible-update path refreshes the supervisor's expected fingerprint before replacing a worker. Private handoff intentionally defers that path. When the old worker exited inside that deferred window, recovery spawned the completed worker with the retained old fingerprint.

Both the worker and supervisor then treated exact fingerprint inequality as though it were a worker-protocol mismatch. That was the wrong boundary: a fingerprint identifies one exact compiled artifact, while compatibility is defined by the versioned tool catalog and MCP-to-worker protocol.

## Remedy

Stage5 Browser 0.6.8:

1. validates initialization compatibility by worker protocol rather than exact artifact fingerprint;
2. adopts the current completed fingerprint before recovery-driven replacement, including the private-handoff race;
3. records the loaded replacement fingerprint after a successful handshake so the next operation cannot trigger a redundant reload; and
4. provides a one-operation bridge for already-running legacy MCP hosts that still enforce fingerprint equality. The bridge explicitly marks its mode and retains the worker's true loaded fingerprint as diagnostic evidence. Once the private operation completes, the normal compatible-update path adopts the true identity.

A true tool-catalog or worker-protocol change still returns `MCP_RESTART_REQUIRED`. A fingerprint-only mismatch never does.

## Regression gate

Automated coverage now proves:

- same-protocol workers with different fingerprints initialize successfully;
- a worker that exits during a retained private handoff is replaced by the compatible completed build without an MCP reconnect;
- legacy fingerprint-gated hosts can finish the retained operation without hiding the replacement worker's actual identity; and
- a real worker-protocol mismatch still fails with `MCP_RESTART_REQUIRED`.

The paused agent should retry `browser_resume_after_login` once through the existing host, then call `browser_status` and take a fresh semantic snapshot. It should not repeat login and should not perform a Facebook action until the visible signed-in state is verified.
