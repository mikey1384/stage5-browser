# X timeline dogfooding: Stage5 Browser 0.4

## Workflow

An agent used Stage5 Browser 0.3 to verify whether an older Stage5 X post mentioned Rick Rubin. Browser discovery, a dedicated Brave profile, navigation, tab inventory, frame inventory, and deep semantic snapshots worked. The real workflow then stopped on authentication, infinite scrolling, unnamed semantic targets, ambiguous click outcomes, redirects, and rate-limit visibility.

The agent correctly did not fall back to another browser integration and did not attempt an upload or post.

## Observed gaps and generic remedies

| Observed gap | 0.4 remedy |
| --- | --- |
| The user's everyday Brave login was unavailable in the isolated profile | Keep the isolated profile boundary and use `browser_auth_status`, `browser_request_login_handoff`, and `browser_resume_after_login`. The request tool releases Playwright and opens the same isolated profile as an uncontrolled native browser; the user signs in privately once, quits that dedicated browser normally, and the profile persists. |
| An infinite X timeline could not advance | Add bounded `browser_scroll` with before/after position, content-growth, end-state, and unchanged-position evidence. |
| Repeated deep snapshots were needed to look for one phrase | Add bounded `browser_find_text` over currently rendered text with snippets and truncation metadata. |
| Useful unnamed links had snapshot refs but no actionable accessible name | Add `browser_click_ref`, accepting only a ref from the latest `snapshotId` for the same frame and document. References fail closed when stale or reused. |
| A Media-tab click dispatched successfully but a login modal prevented the requested selection | Add optional URL, selected-state, and visible-element postconditions to both click tools. A missed condition returns `POSTCONDITION_FAILED` with `clickDispatched: true`, preventing blind replay. |
| A client-side redirect occurred after `browser_open` returned | Add a bounded stabilization phase, final and observed URLs, plus `browser_wait_for_url` for deferred URL conditions. |
| HTTP 429 returned with no warning | Classify 401, 403, 429, other 4xx, and 5xx responses as structured warnings with safe next actions. |
| Canonicalization hid whether navigation redirected | Return `redirected`, a sanitized server `redirectChain`, and the bounded sequence of observed main-frame URLs. |

No service-specific X selectors, anti-bot bypass, cookie extraction, arbitrary JavaScript evaluation, or attachment to a person's default browser profile was added.

## Regression fixture

The controller test suite now preserves the failure as one local X-like workflow:

1. A server redirect lands on a page that performs a delayed client redirect.
2. A direct endpoint returns HTTP 429.
3. A Media tab dispatches a click but remains unselected while showing a login dialog.
4. Scrolling loads an older `Rick Rubin archived post` entry.
5. Rendered-text search locates that entry.
6. A nameless link is clicked only through its observed snapshot reference and verified URL.
7. Reusing the stale reference fails.
8. Headless login handoff and resume-without-handoff both fail with explicit authentication errors.

## Resume condition for the original workflow

The Rick Rubin verification remains inconclusive until an agent starts the intended persistent Brave profile, completes the one-time uncontrolled X login bootstrap if needed, verifies the signed-in account from a fresh post-resume snapshot, then scrolls and searches the loaded timeline. The implementation should be judged by completing that same workflow through Stage5 Browser without a fallback browser tool.
