# Facebook authentication-route false negative

Date: 2026-08-25
Release: 0.6.7 (compatible runtime update; tool catalog 5, worker protocol 5)

A Facebook private-login handoff preserved its cookies and visible signed-in profile, but resume returned `AUTH_NOT_PERSISTED`. No Facebook action was taken after that result.

Evidence:

- resume operation: `8a43fa58-620f-49a8-b2a7-605ade7bd151`
- verification snapshot: `87a1deb6-a8b8-48cf-bf23-3b2408fd9c3d`
- storage state: preserved
- loss boundary: none
- expected route: the signed-in personal-profile pathname without a query
- observed route: the same origin and pathname with site-added `checkpoint_src` metadata

The failure came from reusing the generic literal `exact` URL matcher for authentication verification. That matcher remains correct for navigation waits and click postconditions, where every URL component may be consequential.

Authentication resume now uses a narrower route rule:

- origin must match exactly;
- pathname must match exactly;
- fragment must match exactly;
- when the expectation contains a query, the full URL remains exact;
- when the expectation omits a query, the site may append query metadata without producing `AUTH_NOT_PERSISTED`.

This rule is authentication-only. It does not treat storage continuity or a route match as proof of sign-in: the bounded verification preview and a fresh semantic snapshot remain required before any account action.
