# Snapshot-ref activation rebinding

Date: 2026-08-25
Release: 0.7.4 (tool catalog 6, worker protocol 6)

## Dogfooding evidence

After Stage5 Browser 0.7.3 reattached the existing signed-in Brave session, one fresh Coinbase funding-source ref failed before input with `reference_resolution_changed`. Operation `5dcd1331-b8a5-48cc-bace-f38ca1649135` truthfully returned `actionDispatched: false`, `clickDispatched: false`, and no trusted key or pointer event. A fresh follow-up snapshot proved that no menu opened and no selection changed. Nothing was retried, saved, submitted, or privately entered.

## Root cause

Version 0.7.3 moved role-target binding behind necessary page activation, but snapshot-ref clicks still depended on their live Playwright ARIA ref. A React render could replace the observed control across the activation boundary. The fresh snapshot still proved the intended role, accessible name, document, frame, and modal/document scope, but the one-use action had no bounded way to bind that semantic replacement.

## Fix

- Every snapshot retains a privacy-safe role/name descriptor for each exposed ref together with its exact document and modal/document scope capability.
- A ref click activates and verifies the selected page before binding its final live target.
- If the original ARIA ref still resolves, Stage5 verifies that it remains inside the retained scope and still has the observed role/name.
- If React replaced it during that pre-input boundary, Stage5 may bind exactly one role/name-equivalent element inside the same retained scope.
- A missing descriptor, replaced scope, deadline expiry, or multiple in-scope matches fails closed with definite zero-dispatch evidence.
- The capability is still consumed after one attempt. Rebinding is impossible after any keyboard or pointer input.

This is generic browser behavior. Development and validation use disposable localhost fixtures and isolated temporary profiles; no Coinbase or signed-in browser is opened.

## Regression coverage

Headless fixtures prove that:

1. a fresh modal-scoped ref survives one activation-triggered React replacement and clicks exactly once;
2. an identically named control outside the retained modal is never selected; and
3. two matching replacements inside the retained scope fail as `reference_semantic_rebind_ambiguous` with both dispatch booleans false.

This is a compatible worker behavior update. Tool catalog 6, worker protocol 6, and the 24-tool surface are unchanged, so live hosts adopt 0.7.4 automatically at the next state-safe worker boundary.
