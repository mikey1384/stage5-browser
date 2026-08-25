# Compatible-worker action evidence

Date: 2026-08-25
Release: 0.8.1 (tool catalog 7, worker protocol 6, 29 tools)

## Dogfooding evidence

Finance Agent used one separately authorized attempt on a fresh custom-control ref in the dedicated Coinbase profile. Stage5 Browser 0.8.0 observed one trusted Enter keydown on the exact native button. Before keyup or click, the application detached that node. No pointer, mouse, keyup, or click event reached the target, and the requested visible menu option was absent in the bounded postcondition and a fresh read-only snapshot. The operation correctly terminated as `reason: detached`, `actionDispatched: true`, `clickDispatched: false`; it did not rebind, switch transports, or replay.

Before the follow-up diagnostics call, the connected host adopted a compatible worker. The browser process and exact selected tab survived, but the new worker's in-memory page diagnostic buffer began empty, so `lastAction` no longer carried the terminal dispatch evidence. No live retry, form mutation, private-value entry, save, continuation, submission, funding, or transaction followed.

## Root cause and classification

The click outcome was already fail-closed and is intentionally unchanged. A trusted keydown is a partial input boundary even when no click follows, and the missing postcondition means Stage5 cannot prove either application success or safe replay.

The reproduced Stage5 defect was evidence continuity. Native CDP reattachment preserved browser ownership and the exact selected target, but the privacy-safe `lastAction` record existed only in the exiting worker's memory.

## Fix

- Controlled native Chromium retains the bounded sanitized last-action diagnostic in its private `0600` control record during graceful compatible-worker shutdown.
- The action result is already terminal before that handoff begins; retention cannot replace or relabel it.
- The retained diagnostic is bound to a private opaque CDP target identity, a private opaque main-document loader identity, and the sanitized URL. A replacement worker restores it only when all three still match.
- Selecting a different target clears stale retained evidence. A same-tab document replacement also fails the loader-identity check, even when the sanitized URL is unchanged.
- The record contains no raw page content, accessible name, entered value, request body, header, query, fragment, coordinate, credential, cookie, or private form data. Opaque identities remain private and are never returned, journaled, or sent through the Lounge.
- Invalid retained evidence is ignored without discarding the valid browser-control binding.

This is a compatible worker update. Tool catalog 7, worker protocol 6, and the 29-tool surface are unchanged, so a connected host adopts 0.8.1 at the next safe worker boundary without an MCP reconnect.

## Regression coverage

Disposable tests prove that:

- the native-button engine reports a keydown-triggered detachment as partial, non-retriable input and never sends pointer fallback or a replacement click;
- a successful action's privacy-safe diagnostic round-trips through the private native-control record and is restored for the exact same target and document;
- a different document identity restores no action evidence;
- a query-bearing or otherwise invalid retained diagnostic is discarded while the underlying native control binding remains usable; and
- the full ordinary suite remains headless; no native focus-changing test is part of this release gate.

## Safe resume boundary

The consumed Coinbase authorization does not permit another opener attempt. Preserve the current page and use read-only status, snapshot, or diagnostics only. A fresh explicit user authorization plus a newly observed control would still not make replay safe until the workflow has a generic selection primitive or other evidence-backed path that avoids repeating this ambiguous partial-key transaction. The untracked Coinbase dogfooding report remains preserved because its broader first-class select and workflow defects are not all resolved.
