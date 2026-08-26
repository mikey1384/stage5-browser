# Temporary-tab visibility recovery

Date: 2026-08-26
Release: 0.12.1 (compatible worker update)

## Finding

Version 0.12.0 pinned and temporarily activated the correct background tab, but the renderer became hidden again during its bounded loading wait. The wait timed out and the capture reported only the shell/loading placeholders with `rendererVisibility: hidden`. The exact draft tab was restored and no element action occurred, so the reporting agent stopped without retrying or disturbing preserved state.

An initial successful activation was not sufficient evidence that the renderer stayed visible throughout a dynamic read-only wait. Capturing a hidden renderer also could not prove that its semantic content had advanced.

## Compatible fix

Temporary inspection now guards the pinned target renderer before every bounded loading observation and immediately before semantic capture. If visibility is lost, Stage5 may call `bringToFront` one additional time on only that same exact page and wait for it to become visible. It does not invoke native application activation, select by URL/title/index, expose refs, or dispatch element input.

A second visibility loss, failed same-tab recovery, or hidden semantic-capture boundary raises a structured zero-element-action failure. Whether inspection succeeds or fails, the exact previously selected page is restored in `finally`, and restoration still must be proven before the operation returns.

## Regression coverage

A disposable local duplicate-tab fixture keeps an unpublished draft selected. The exact feed renderer becomes visible, drops back to hidden 25 ms into its loading wait, then loads only after one same-tab recovery. The test requires visible semantic capture, satisfied article/loading evidence, zero refs, and exact draft restoration. A second phase forces the renderer hidden after both visibility transitions and proves Stage5 stops after the single recovery while restoring the draft on the failure path.

## Safe resume

Release 0.12.1 keeps tool catalog 11, worker protocol 9, and 32 tools, so an already-running 0.12.0 MCP host does not reconnect. Preserve the owned browser and every existing tab. Call `browser_status` once to adopt the compatible worker; require worker version 0.12.1, `restartRequired: false`, and exact profile/page continuity. Because worker replacement changes session-scoped tab capabilities, call `browser_tabs` once and discard prior tab IDs. Use `browser_inspect_tab` once on the exact fresh background ID with explicit temporary activation and the same bounded wait. Continue read-only only when target visibility at capture is visible, loading evidence is satisfied, restoration is proven, controller selection is unchanged, warnings are empty, refs remain withheld, and the intended public document appears. A second visibility loss, timeout, stale identity, modal ambiguity, or restoration failure stops the workflow without another inspection, navigation, close, dismissal, post, or private action.
