# Facebook editor viewport preparation

Date: 2026-08-25
Release: 0.7.5 (tool catalog 6, worker protocol 6)

## Dogfooding evidence

Stage5 Browser 0.7.3 received one fresh unnamed Facebook composer textbox capability, then failed before input with `fillPhase: target_preparation`, `fillPreparationStep: viewport_preparation`, `reason: target_preparation_timeout`, `actionDispatched: false`, null target state, and null input evidence. Operation `ffd5af71-aedf-4293-8f1a-6e97456c3633` was followed by fresh snapshot `e9d80aa5-b1e0-4ac2-8c6c-ddf86d69c2ba`, which proved that the modal and editor were still visible, the editor was empty, and Next remained disabled. Diagnostics operation `e73fa2af-79ad-44eb-a0b2-a4e0a5f0a636` showed a healthy 0.7.3 worker and no browser or network failure.

No retry or live-site development action was performed. The signed-in Facebook profile and open composer were not touched during the fix.

## Root cause

`browser_fill_ref` called Playwright's stability-gated `scrollIntoViewIfNeeded` before it inspected the exact retained editor's current geometry. A reactive contenteditable can remain visibly usable while never satisfying that stability wait. The scroll then consumed the fill preparation budget even though the editor required no movement.

## Fix

- Inspect the exact retained editor handle before viewport movement.
- Fail closed with structured target evidence when the handle is detached, hidden, or the deadline is exhausted.
- Skip viewport movement entirely when the editor is already visible and in view.
- For a genuinely offscreen editor, use one fixed 500 ms exact-handle DOM `scrollIntoView` call, then revalidate normally.
- Preserve the one-use snapshot capability, retained modal/document scope, privacy-safe result, and zero-replay rules. The supplied text is never logged or returned.

This is a compatible worker update. The tool catalog and worker protocol remain at version 6, so a connected host does not need an MCP restart.

## Regression coverage

Disposable headless fixtures prove that:

- a visible unnamed Facebook-style contenteditable fills even when the retained handle's Playwright stability-scroll method would never complete;
- an offscreen unnamed contenteditable is moved into its modal's visible region using the bounded exact-handle path, then accepts multiline Korean text and a URL;
- neither path calls Playwright's stability-gated `scrollIntoViewIfNeeded`; and
- the existing structured timeout, detached-scope, capability-consumption, value-privacy, and logical-value evidence tests continue to pass.
