# Surface-covered popup owners

Release contract: Stage5 Browser 0.15.8, MCP host behavior 2, tool catalog 13, worker protocol 12, 54 tools. This is a compatible worker update.

This privacy-safe record contains only categorical trace facts and disposable fixture geometry. No live URL, account value, option text, form value, coordinate, credential, payment/tax value, page content, or private data is retained.

## Live evidence and corrected invariant

After 0.15.7 adoption, Finance performed exactly one separately released passive `revealOptions=false` inspection. Operation `a2942ce5-65ee-43c8-9325-b55eb3db12ed`, trace `3cc88b07-acd3-430a-9eff-ca77ce04b9eb`, completed in 605 ms under `form_manager` on worker 0.15.7. It reported one rendered surface, `ambiguous_control_popup`, zero actions, and `actionDispatched:false`. No live input or retry followed.

That result falsified ordinary nearest-edge ranking. Rectangle edge gap becomes zero both for an exterior trigger touching the popup and for later controls whose rectangles sit underneath the popup. The old resolver therefore discarded the positional fact that the surface itself occluded those siblings.

The 0.15.8 resolver keeps structural, focused, expanded, and spatial tiers intact. In the spatial tier only, it measures material rectangle overlap and probes one bounded point inside that overlap. A sibling is classified as surface-covered only when the authoritative browser hit test returns the popup or its descendant. Covered siblings may be excluded only when the surviving exterior candidate is tightly adjacent. Uncovered overlap, a distant exterior candidate, stronger-tier conflicts, and true exterior ties remain ambiguous with zero input.

This is a generic contact invariant: a popup that physically occupies a page region constrains which underlying controls can establish ownership through geometry alone. It does not use a site, URL, label, option meaning, selector, or business declaration.

## Proprioceptive telemetry

Successful control results and errors now include a privacy-safe `popupOwnership` record containing only:

- the proof tier;
- bounded total, exterior, overlapping, and surface-covered candidate counts; and
- a categorical decision such as `decisive_distance`, `covered_siblings_excluded`, `tie_or_near`, or `structural_conflict`.

Coordinates, rectangles, names, selectors, values, options, URLs, and page content remain omitted. A freshly started host built from this source also retains the record in `browser_execution_traces`. The live Finance host predated the new host-side privacy parser, however, so its durable trace correctly kept the old allowlist and omitted `popupOwnership` even though the canonical worker result returned it. That deployment-boundary finding is fixed separately by the 0.15.9 host-behavior increment; a worker-only update must never promise a new host-owned trace field.

## Regression and adoption

`tests/browser-controller/core/control-reveal-recovery.test.ts` proves that:

- a uniquely nearest exterior anchor still resolves;
- one tightly adjacent exterior anchor wins over a materially overlapped sibling only when the popup hit-test path proves that sibling is covered;
- an exact exterior tie remains ambiguous with zero input; and
- the decision and bounded candidate classes are returned categorically.

`tests/execution-telemetry.test.ts` proves the same categories survive the privacy allowlist without semantics. Focused adjacent-boundary gate: 3 files and 22 tests passed. Complete headless release gate: 71 files and 260 tests passed; the 3 native focus-changing/handoff cases remained intentionally skipped. Total release-gate duration was 178.36 seconds.

The preserved live page then accepted exactly one passive inspection. Operation `0c6864de-484b-431b-a562-55c63b74633b` succeeded in 888 ms with zero action phases, one positioned option-group surface, spatial association, and categorical ownership of five candidates: two exterior, three overlapping, and two hit-test-proven surface-covered; decision `covered_siblings_excluded`. Seven options were observed within the caller's existing bound. No option was selected and no further page action occurred. The corresponding old-host trace retained the success, manager, timing, zero actions, association, surface, and rendered count but omitted the newly added owner record, directly proving the host-contract issue above.

The functional browser defect is accepted on 0.15.8 and requires no replay or further live verification. Durable owner categories require the 0.15.9 fresh-host gate documented separately; old trace rows are immutable and are not rewritten.
