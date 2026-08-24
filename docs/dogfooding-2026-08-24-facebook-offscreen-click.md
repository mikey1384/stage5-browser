# Facebook offscreen interaction dogfooding: Stage5 Browser 0.6.1

## Workflow evidence

The agent inspected four matching posts across the two intended Facebook destinations and confirmed their distinct publishing formats. It paused before posting because one remaining question required expanding a truncated caption, and the fresh `See more` reference was outside the viewport.

- Fresh snapshot: `802403a0-6c11-44f3-9b24-4662e4bf990d`
- Offscreen click failure: `64559b1f-9e19-4253-9d12-20962ba42d2f`
- Click diagnostics: `bc4d794a-6743-44df-b9b0-dca9e34e2d4c`
- Earlier stale-ref rejection: `233a38b4-6da5-4b7c-a4c1-cd9fbb605962`

The target was visible and enabled in the rendered document but outside the viewport. The old path delegated viewport preparation to the eventual Playwright click. When it timed out, Stage5 could no longer prove whether dispatch had begun and correctly returned `unknown`; however, it had missed the safer opportunity to perform a non-consequential scroll and actionability check first.

Two document-scroll waits also timed out after the intended posts were visibly present because unrelated loading indicators elsewhere on the page remained CSS-visible:

- Scroll: `6033fbda-b202-4b91-9128-0357dc435713`
- Diagnostics: `c135d6b0-4133-43f3-8b7b-d5c45c3147bf`

## 0.6.1 remedies

`browser_click_ref` now performs one bounded scroll-into-view step, capped at two seconds, before the consequential click whenever the observed target is offscreen. It then revalidates that the same ref still resolves uniquely and that the element remains attached, visible, enabled, inside the viewport, and able to receive pointer events. Only after those checks does click dispatch begin.

If scrolling fails, the ref detaches or becomes ambiguous, or actionability remains false, Stage5 consumes the snapshot and returns a structured pre-dispatch failure with both `actionDispatched: false` and `clickDispatched: false`. A click attempted after successful preparation retains the existing outcome-unknown protection when Playwright cannot prove whether dispatch occurred.

Loading-indicator observations are now spatially scoped. A nested target counts only indicators intersecting that target's visible clipped surface. For document scrolling, one uniquely visible semantic `[role="feed"]` becomes the observation root; otherwise the current viewport is used. Article counts and heuristics use the same semantic root, so unrelated offscreen or out-of-feed page loaders cannot hold a feed wait open.

## Regression acceptance

The fixture suite proves that:

1. A fresh offscreen ref is brought into view and clicked with a passing postcondition.
2. Successful diagnostics record the revalidated target as in-view.
3. An impossible fixed offscreen ref fails within the preparation bound without dispatch.
4. Every attempted ref click consumes its snapshot capability.
5. A feed loader can disappear successfully while an unrelated fixed management loader remains visible outside the feed.
6. No MCP input/output shape or worker command changes were needed.

## Host pickup

These are compatible worker behavior fixes in 0.6.1. Worker protocol 5, tool catalog 5, and the 23-tool surface are unchanged. Existing 0.6.0 hosts load the completed worker automatically on their next browser operation. No reconnect, deployment, marketplace reinstall, cachebuster, duplicate registration, or repeated authentication is required.
