# Native draft handoff continuity — 2026-08-26

## Sanitized finding

A social-page workflow had an unpublished composer open when a Stage5 Browser 0.12.2 temporary background-tab inspection could not prove restoration of the exact prior renderer. The reporting agent stopped without retrying or publishing. A later 0.13.0 MCP reconnect inspected configured-default Chromium instead of the intended Chrome backend; 0.14.0 corrected that agent-context error and reattached the uniquely proven Chrome process and all three exact targets. One passive inspection then showed the intended page but no composer modal or unpublished draft.

No live input, activation, navigation, close, replay, or publication was used to investigate this finding. The missing draft is not recoverable and must not be reconstructed from agent memory.

## Boundary analysis

The exact Chrome process and target set survived. The 0.14 lifecycle stream contained no Facebook document-replacement or close event during reattachment, but the pre-0.13 control record did not always retain a selected loader identity when no action diagnostic existed. Therefore the evidence cannot prove when the site state changed or attribute that change to the 0.14 reattachment.

The demonstrated ambiguity belongs to the older boundary:

- 0.12.2 had already reported `temporary_tab_activation_restore_failed`, so controller selection was not proof that the composer renderer was actually active;
- the long uncontrolled gap left same-document application state subject to autonomous site behavior, renderer lifecycle, and memory pressure;
- 0.13.0 added one exact same-target restoration recovery and began retaining target plus loader identity even when no last-action diagnostic exists;
- 0.14.0 added per-agent backend restoration so a reconnect no longer silently inspects configured-default Chromium instead of the agent's Chrome profile.

This is correlation, not a claim that Chrome discarded the tab or that Facebook performed a particular transition.

## Decisive current-version regression

`tests/native-worker-handoff.test.ts` exercises the real generic boundary with no account or native focus change:

1. launch one disposable project Chromium profile headlessly with a private loopback CDP port;
2. attach a controller through the exact native control record and ownership lease;
3. open a localhost modal, fill a non-sensitive textarea, and retain the exact target and loader identities;
4. gracefully detach the first controller while leaving the exact browser process alive;
5. mark only the simulated first worker identity exited and attach a second controller;
6. prove the same process, target, loader, modal, and unsaved textarea value remain;
7. prove no selected-document replacement was emitted after the handoff cursor, then close only the disposable owned browser.

The regression passes on 0.14.0. It demonstrates that the current Stage5 worker handoff does not itself reload or erase the selected document. Existing replacement-document tests separately prove truthful state-risk events and no replay when loader continuity fails.

## Safe workflow disposition

The historical unpublished draft remains lost and the live workflow remains paused. No Stage5 or Lounge authority permits reconstructing it. A future user-authorized workflow must begin from a fresh page observation and newly supplied intent. A future reproduction on the current runtime should report the exact version, target/loader continuity result, and durable page events; it must not retry or publish merely because the prior UI state is absent.
