# Native draft handoff continuity — 2026-08-26

## Sanitized finding

A social-page workflow had an unpublished composer open when a Stage5 Browser 0.12.2 temporary background-tab inspection could not prove restoration of the exact prior renderer. The reporting agent stopped without retrying or publishing. A later 0.13.0 MCP reconnect inspected configured-default Chromium instead of the intended Chrome backend; 0.14.0 corrected that agent-context error and reattached the uniquely proven Chrome process and all three exact targets. An initial client-truncated view of a passive inspection appeared to show no composer, but the complete 35,909-character result authoritatively contained the composer textbox, attached media, and Next control near its tail. The unpublished draft survived.

No live input, activation, navigation, close, replay, or publication was used to investigate this finding. The draft remains frozen and intact.

## Boundary analysis

The exact Chrome process, target set, document, modal, and draft survived. The false negative came from a separate observation bug: `browser_inspect_tab` captured the whole document even when one unique visible modal existed. Large underlying Page content consumed the front of the result, while decisive modal evidence appeared only after the client's context boundary.

Two boundaries remain relevant:

- 0.12.2 had already reported `temporary_tab_activation_restore_failed`, so controller selection was not proof that the composer renderer was actually active;
- the long uncontrolled gap left same-document application state subject to autonomous site behavior, renderer lifecycle, and memory pressure;
- 0.13.0 added one exact same-target restoration recovery and began retaining target plus loader identity even when no last-action diagnostic exists;
- 0.14.0 added per-agent backend restoration so a reconnect no longer silently inspects configured-default Chromium instead of the agent's Chrome profile.
- the tab-inspection path bypassed the canonical snapshot-root selector even though ordinary snapshots already promoted one unique active modal.
- 0.15.0 routes passive exact-tab inspection through that canonical selector and bounds priority-first MCP results so decisive action evidence cannot be displaced by underlying page detail.

The later complete snapshot supersedes the earlier absence inference. There is no evidence that Chrome discarded the tab or that the site erased the draft.

## Decisive current-version regression

`tests/native-worker-handoff.test.ts` exercises the real generic boundary with no account or native focus change:

1. launch one disposable project Chromium profile headlessly with a private loopback CDP port;
2. attach a controller through the exact native control record and ownership lease;
3. open a localhost modal, fill a non-sensitive textarea, and retain the exact target and loader identities;
4. gracefully detach the first controller while leaving the exact browser process alive;
5. mark only the simulated first worker identity exited and attach a second controller;
6. prove the same process, target, loader, modal, and unsaved textarea value remain;
7. prove no selected-document replacement was emitted after the handoff cursor, then close only the disposable owned browser.

The handoff regression and the new modal-root regression pass on 0.15.0. Together they demonstrate that current worker handoff does not itself reload or erase the selected document and that passive inspection exposes the surviving unique modal compactly. Existing replacement-document tests separately prove truthful state-risk events and no replay when loader continuity fails.

## Safe workflow disposition

The unpublished draft remains frozen and the live workflow remains paused. After the reporting agent reconnects once to 0.15.0 and reattaches only its uniquely proven intended Chrome profile, one passive exact-tab inspection may verify the unique modal through a compact `scope: "modal"` result. That read-only evidence does not authorize editing, advancing, discarding, or publishing. A future reproduction should report the exact version, operation ID, target/loader continuity result, durable page events, semantic scope, bounded-delivery state, and privacy-safe execution trace; it must never infer absence from a truncated result.
