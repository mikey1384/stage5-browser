# Uniquely nearest popup anchor

Release contract: Stage5 Browser 0.15.7, MCP host behavior 2, tool catalog 13, worker protocol 12, 54 tools. This is a compatible worker update.

This privacy-safe record contains only categorical trace facts and disposable geometry. No live URL, account value, option text, form value, coordinate, credential, payment/tax value, page content, or private data is retained.

## Evidence and root invariant

After 0.15.6 adoption, the passive dogfood operation again reported exactly one rendered popup surface, `ambiguous_control_popup`, no action phases, and `actionDispatched:false`. This ruled out the separated-branch partition class without touching the preserved page.

`src/controller/controls/popup-ownership.ts` previously reduced spatial relation to a boolean threshold. A popup immediately adjacent to its intended control and a farther control still inside that broad threshold entered the same pool, so the resolver discarded real positional information and failed ambiguous.

The resolver now retains normalized edge gap for every plausible owner. Explicit/structural ownership remains dominant and is never broken by geometry. Within focused, expanded, or plain spatial tiers, one candidate may win only when its normalized gap has a decisive lead over the runner-up. An exact or near tie remains `ambiguous` with zero input. This is positional proof, not a site label, selector, regex, option meaning, or URL rule.

## Regression and adoption

`tests/browser-controller/core/control-reveal-recovery.test.ts` proves all adjacent boundaries:

- separate positioned portals associate with their unique controls;
- strict branches under one broad portal partition only across a real gap;
- contiguous option wrappers stay one surface;
- an immediately adjacent target wins over a farther but threshold-plausible control; and
- two equidistant controls remain fail-closed with no input.

Focused adjacent-boundary gate: 3 files and 20 tests passed. Complete headless release gate: 71 files and 258 tests passed; the 3 native focus-changing/handoff cases remained intentionally skipped. Total release-gate duration was 172.78 seconds.

At the preserved native-browser safe boundary, the existing host calls `browser_status` once, requires worker 0.15.7 with host behavior 2/protocol 12/catalog 13/54 tools and `restartRequired:false`, discards old control capabilities, and performs only the separately released passive `revealOptions=false` verification. Any new ambiguity stops without replay or further page action.
