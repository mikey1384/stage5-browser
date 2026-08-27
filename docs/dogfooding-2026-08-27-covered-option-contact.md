# Covered option contact dogfooding

Release contract: Stage5 Browser 0.16.1 with unchanged MCP host behavior 5, worker protocol 13, tool catalog 14, and 54 tools. This is a compatible worker correction after the one-time 0.16.0 host reconnect. It grants no browser or account authority.

## Reported boundary

The first authorized 0.16.0 desired-state correction completed with one dispatch, and a fresh passive inspection proved that its exact selected representation disappeared while another selected peer remained. The next fresh exact option operation stopped during reversible viewport preparation with `target_covered_after_scroll`:

- nested vertical movement completed;
- the retained target was visible, enabled, and geometrically in the viewport;
- every bounded exact-target hit point landed on a sibling option;
- dispatch attempts, action dispatch, and click dispatch were all zero.

No replay, form continuation, submission, navigation, private entry, funding, or trading occurred. The failed capability is discarded.

## Generic correction

The shared exact-target preparation loop previously ended as soon as clipped geometry first intersected the viewport. In a scrollable option surface, that first sliver can remain wholly underneath a sticky or overlapping sibling even though more safe scrolling is available.

Preparation now continues while the same retained target is either outside the viewport or explicitly fails exact pointer hit testing. When it is geometrically visible but covered, Stage5 moves it toward the center of the nearest movable scroll surface, waits once, and repeats the canonical exact-target geometry probe. The existing bounded step count, absolute deadline, exact semantic rebind after virtualization, and synchronous pre-input guard still apply. If no surface moves or no exact hit is proven, the action stops before input. It never clicks through the covering sibling and never uses force as a substitute for contact.

Privacy-safe phase telemetry records only `pointerContactRecovery:true` plus the existing categorical movement, surface, target-state, dispatch-count, and outcome fields. It does not retain coordinates, option names, labels, selectors, URLs, values, or page content.

## Regression evidence

A disposable local modal fixture starts with the exact target above a nested scroll viewport. Ordinary preparation makes only a covered edge visible beneath a sticky sibling option. The new bounded interior movement exposes an exact hit point, dispatches one trusted click, and records pointer-contact recovery. Existing vertical, horizontal, composed-tree, covered-button, virtualization, action-phase, and telemetry cases remain in the focused gate.

No live account, native focus-changing operation, or private data was used for reproduction or validation.

Release validation completed with the file-size gate and TypeScript build passing, 63 focused exact-target/selection/virtualization/phase/telemetry/runtime tests passing, and the complete headless gate passing 281 tests with three intentional native-only skips across 79 test files.

## Safe adoption

An MCP host already on the 0.16.0 contract does not reconnect. At a safe boundary call `browser_status`, require worker/current version 0.16.1 with host behavior 5, protocol 13, catalog 14, 54 tools, and `restartRequired:false`, and discard the failed inspection/option capability.

The failed operation remains non-retriable. A new attempt requires fresh direct controlling-thread authority, one new exact inspection proving the intended current state, and a new one-use option capability. Any possible dispatch remains no-replay, and no release or Lounge message authorizes continuation or another account action.
