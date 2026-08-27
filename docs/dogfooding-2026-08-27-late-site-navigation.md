# Late site navigation classification

## Finding

YouTube Agent opened an authorized public watch target in a new tab. The open result reported the intended document after a requested 1,500 ms stabilization. The next agent turn's passive snapshot showed an authentication document, so the agent stopped without retry or login.

## Telemetry correlation

The durable operation journal and page-lifecycle manifest establish the causal order without page content or private values:

- open completed at `2026-08-27T01:26:55.395Z` after 3,865 ms;
- the target's cross-origin document replacement occurred at `2026-08-27T01:27:08.152Z`, 12,757 ms after open completed;
- snapshot began at `2026-08-27T01:27:09.470Z`, 1,318 ms after that replacement, and completed successfully on the current document.

The later replacement was outside the caller's completed stabilization window. The snapshot did not return stale state, and Stage5 dispatched no element input or replay. Other room-wide page lifecycle events cannot be attributed to this target merely because their sequences are nearby.

## Contract and disposition

`stabilizationMs` is a bounded observation window, not authority to suppress arbitrary future site navigation. Extending every open until an unbounded website becomes permanently quiet would make the hand rigid, slow, and still could not prove future stability. Stage5 instead preserves the real transition, invalidates old document capabilities, and exposes the current document on the next observation. That behavior is correct and needs no navigation retry or site-specific patch.

Keep the affected tab frozen and discard its old refs. Resume the authorized public-source workflow through an official API/CLI when available, or obtain fresh direct controlling-thread authority for a login handoff. This classification authorizes neither another open nor login.
