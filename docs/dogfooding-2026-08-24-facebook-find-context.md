# Facebook text inspection dogfooding: Stage5 Browser 0.6.1

## Acceptance evidence

Stage5 Browser 0.6.0 loaded successfully with 23 tools and `restartRequired: false`. The agent used the preserved Chrome session to scroll two Facebook feeds, waited for loading indicators to disappear, and inspected real posts without failed requests, HTTP errors, or Facebook mutations.

- Successful scroll: `165ea07e-1e5f-43c6-a47a-07dbce7f98a9`
- Clean diagnostics: `ba3fbda6-6dc1-4d88-a946-0647a339c1f8`

The workflow confirmed that nested scrolling and bounded loading waits were fixed. The remaining non-blocking friction was inspection noise: deep Facebook semantic snapshots can truncate after including management navigation and repeated quoted content, even when the agent needs only the few rendered lines surrounding one title or link.

## 0.6.1 remedy

`browser_find_text` keeps its existing input and output schema, but each `matches[].snippet` is now a bounded multi-line context block. It contains the matched rendered line, up to two unique non-empty rendered lines before it, and up to two after it. Each line retains its original rendered line number, and the match is marked with `>`.

Context collection scans at most 12 rendered lines in either direction. Repeated neighboring lines are suppressed using a generic normalized comparison, allowing the search to reach nearby useful context without Facebook-specific selectors. Non-matching context lines are capped at 160 characters, the match remains centered around the query, and the existing overall searchable-text and result-count bounds remain in force.

This deliberately does not return an entire article, widen semantic snapshot depth, accept selectors, or expose arbitrary page evaluation. Agents should use contextual search first and request another semantic snapshot only when an interaction reference is actually needed.

## Regression acceptance

The fixture suite proves that a noisy social-feed result:

1. Preserves the original matching rendered line number.
2. Includes useful title and following-link context.
3. Suppresses repeated adjacent quote blocks.
4. Returns no more than two unique context lines on either side.
5. Keeps the existing MCP and worker command schemas unchanged.

## Host pickup

This is a compatible worker behavior update: version 0.6.1 retains worker protocol 5, tool catalog 5, and 23 tools. Existing 0.6.0 MCP hosts load the completed worker build automatically on their next browser operation. No reconnect, deployment, marketplace reinstall, cachebuster, duplicate registration, or repeated login is required.
