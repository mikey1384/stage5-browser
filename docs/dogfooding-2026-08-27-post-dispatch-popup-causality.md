# Post-dispatch popup causality

Release contract: Stage5 Browser 0.17.0, MCP host behavior 6, worker protocol 13, tool catalog 15, and 55 tools. The reconnect is required by the Lounge contract change; the popup correction itself preserves the worker protocol. This release grants no browser or account authority.

## Reproduction

Finance received fresh direct authority for one exact popup opener after adopting 0.16.2. Operation `1b352135-079f-4750-a4a4-d61823ce5fb1` dispatched that opener once and trace `d42d1563-f653-42e0-b562-6756cb66c991` retained `actionDispatched=true`, one rendered popup surface, and a spatial ownership tie among five bounded candidates. The agent correctly froze the live page and did not replay the opener.

A disposable fixture reproduced the privacy-safe shape: two exterior candidates, three overlapping candidates, two overlap candidates covered by the popup, one uncovered overlap, and exactly one popup surface created by a framework-replacing `mousedown` opener. Static geometry could not select an owner, even though the operation itself had observed zero rendered popup surfaces immediately before the exact opener and exactly one afterward.

## Governing invariant

Static association and causal effect are different proof classes.

- Passive inspection retains the existing ownership order. A spatial tie remains zero-input ambiguity.
- Reveal preparation records the authoritative rendered-surface baseline before input.
- If that baseline is zero, one exact opener then possibly receives input, and reconciliation observes exactly one newly rendered bounded surface, the transition itself proves `post_dispatch_unique` association for that operation.
- The causal inference is unavailable if any popup was already rendered, if no opener input was possible, or if zero or several surfaces appear.
- Possible input remains exactly-once. Reconciliation may adopt the observed effect, but it never retries the opener.

This makes the hand reason from its own contact and the page's resulting motion without weakening ambiguity for an already-chaotic scene.

## Regression and safe resume

`tests/browser-controller/core/control-popup-composition.test.ts` covers the five-candidate causal case and proves one opener dispatch, one option surface, retained categorical ownership diagnostics, and `associationProof: post_dispatch_unique`. Existing passive tied-owner and different-owner fixtures still prove zero input. The focused popup/reveal matrix and complete headless release suite remain required; no native focus-changing or live-account test is used.

Reconnect once for 0.17.0, rejoin the same Lounge identity, require MCP/worker/current 0.17.0 with host behavior 6, protocol 13, catalog 15, 55 tools, and `restartRequired:false`, then discard every old control capability. Never replay the reported opener. A later passive `browser_inspect_control(revealOptions=false)` is safe only if fresh direct controlling-thread scope still covers that observation; if the popup is absent or not uniquely associable from current state, stop without input.
