# Reconnect and control-transition acceptance — 2026-08-26

Release contract: 0.14.0, tool catalog 12, worker protocol 11, MCP-host behavior 1, 53 MCP tools.

## Reconnect root cause and invariant

The native Chromium-family process and exact target continuity were already durable, but the supervisor's selected backend was only process-local. A YouTube workflow using the isolated Chrome profile could therefore reconnect into the configured Chromium default and report `stopped`, zero pages, and no owner even while the intended Chrome lease remained recoverable. A single global last-browser value would be incorrect because Finance and YouTube may concurrently use different isolated backends.

Joining the Lounge now binds the stable agent identity to a hashed context record containing only:

- the last successfully established Stage5 backend enum;
- the explicit `normal` or `review_only` action-policy mode.

The record never contains URLs, titles, tabs, page/document identities, page content, form values, credentials, or private data. Lounge and context storage have their own serialization lanes and never wait behind the browser queue. The next browser operation reconciles restored state inside the browser queue before worker initialization or input.

`hostBehaviorVersion` is now a build contract. A changed already-running MCP lifecycle implementation sets `restartRequired` just like a tool or worker-protocol change; an ordinary worker-only fix remains hot-reloadable.

## Control-inspection document replacement

`browser_inspect_control` may reveal a custom option surface, so it can dispatch one reversible opener or one exactly owned competing-popup dismissal. If that preparation crosses a reload, authentication redirect, or replacement document, the outer form manager now:

1. combines action and click dispatch evidence from every preparation layer;
2. aborts all old-document control and option capabilities;
3. returns `TARGET_NOT_FOUND` with `reason=document_changed_during_control_inspection` and `inspectionAborted=true`;
4. directs the caller to durable `browser_page_events` and fresh tabs;
5. never replays the opener.

This lifecycle result supersedes an inner selected/expanded postcondition failure. A `document_replaced` event remains the authoritative signal that all unsaved form state may have been lost.

## Regression evidence

- `tests/supervisor-agent-context.test.ts` proves independent Chrome and Brave context restoration for two stable agent identities, review-policy restoration, and context binding while a browser operation is hung.
- `tests/browser-controller/core/control-options.test.ts` drives one exact opener through application → sign-in → application replacement, proves the sign-in route was requested once, verifies no replay, asserts the specialized transition error, and reads the durable state-loss event.
- `tests/runtime-info.test.ts` proves a host-behavior change requires reconnect while an ordinary compatible worker rebuild does not.
- `tests/native-worker-handoff.test.ts` launches one disposable headless Chromium process over real loopback CDP, fills a local modal textarea, detaches the first controller, marks only its simulated worker identity exited, reattaches a second controller to the exact process and target, and proves the loader identity, modal, and unsaved value survived without a selected-document replacement.
- Existing exact-target and diagnostic tests continue to cover stale/missing identity, replacement-document warnings, and privacy-safe evidence restoration.

## Safe migration and resume

0.13.0 could not pre-populate a context record that did not exist. On the first 0.14.0 connection:

1. reconnect the MCP host once and rejoin the same Lounge identity before browser tools;
2. require 0.14.0 / protocol 11 / catalog 12 / 53 tools / `restartRequired=false`;
3. call `browser_available` and identify the intended backend only from a uniquely proven recoverable Stage5 ownership lease;
4. call `browser_start` once with that explicit backend; this reattaches the preserved native process and seeds future context restoration;
5. take fresh page events and tabs and discard all pre-reconnect capabilities.

If several profiles are plausible, do not guess. A passive `browser_inspect_tab` with `temporaryActivation=false` may inspect one fresh exact duplicate-tab ID without changing controller selection or issuing element-action refs; a hidden dynamic renderer may return incomplete content, which is evidence to stop rather than permission to activate or retry. Possible prior input and any document-replacement boundary remain observation-only.
