# Plan — Detection-rule confidence

Rollout Phase 3. One risk, one test layer, and a method chosen specifically to
beat the oracle problem.

## Approach

The existing rule tests crawl `test/fixtures/site`. That fixture and the rules
were written by the same author in the same sitting, so the tests can only
confirm what their author already believed. Adding more cases to that fixture
would have produced more of the same confirmation.

Instead the shapes came from outside the implementation:

- **hreflang guidance** — `x-default` is defined as the page for users whose
  language matches nothing. It is a fallback pointer, not a language.
- **ISO 639-1** — which two-letter strings actually name languages.
- **BCP 47 practice** — regional refinements such as `en-gb` refine `en`.
- **The PRD's own guardrail** — a finding that does not matter is a defect, not
  a rough edge.

Each case states its expectation and the source of that expectation, written
before the rules were run against it. Four disagreed. In each the rule was
wrong, and the expectation stood.

## Progress

- [x] 1.1 A complete family produces nothing — aed47ea
- [x] 1.2 A family missing one expected locale reports exactly that — aed47ea
- [x] 1.3 hreflang values are case-insensitive — aed47ea
- [x] 1.4 A broken sibling is reported once, not also as missing — aed47ea
- [x] 1.5 An out-of-scope sibling is not reported as unreached — aed47ea
- [x] 1.6 `x-default` is not treated as a language — aed47ea
- [x] 1.7 Findings do not depend on hreflang markup order — aed47ea
- [x] 1.8 Two-letter non-language segments produce nothing — aed47ea
- [x] 1.9 A genuine locale segment is still recognised — aed47ea
- [x] 1.10 A regional variant satisfies the language it refines — aed47ea
- [x] 1.11 A bare language does not satisfy a requested region — aed47ea
- [x] 1.12 A page whose only alternate is itself is reported — aed47ea
- [x] 1.13 The 184-code list is complete for the languages in use — aed47ea
- [x] 1.14 The residual market-segment ambiguity is pinned — aed47ea
- [x] 1.15 The existing fixture-based tests still pass unchanged — aed47ea
- [x] 1.16 `npm run test:all` green — 76 unit, 28 integration, 11 end-to-end — aed47ea
- [x] 1.17 Type checking and linting pass — aed47ea

## What this phase found

Four defects, all in shipped detection logic, all of the exact class R1 names.

**1. `x-default` was read as a language.** It commonly points at the same URL as
the site's primary language, so a site publishing English at `/` was reported as
missing English — with the finding pointing at the English page. It was also
order-dependent: the locale came from the first self-referencing tag found, so
two sites differing only in the order of their link tags produced different
findings.

**2. Any two-letter path segment became a locale.** `/us/`, `/go/`, `/ok/` — a
market, a redirect path, a status. An ordinary English site earned one "no
language variants declared" finding per section. This is the same failure the
pattern was narrowed to prevent for `/design/` and `/media/`; two-letter
segments slipped straight through the narrowing.

**3. A regional variant did not satisfy the language it refines.** A site
publishing `en-us` and `en-gb` was told it was missing `en`, in a finding whose
own evidence listed two English pages.

**4. A page whose only alternate was itself went unreported.** Self-referencing
links are standard practice; such a page has declared it has no siblings, which
is exactly what the no-alternates rule exists to say.

## Known limits

**Some market segments are genuinely ambiguous.** `uk` is Ukrainian and `br` is
Breton, and both are also how English-language sites label their United Kingdom
and Brazil markets. Nothing in a URL separates the two readings, so this rule
cannot either. The product's intended answer is FR-008 — the derived language
mapping is reviewable and correctable — rather than a cleverer pattern. A test
pins the current behaviour so changing it is a decision.

**FR-025 names a finding that does not exist yet.** The requirement covers
"non-reciprocal, incomplete, or pointing at dead URLs". Dead URLs are covered by
rules 2 and 3, but nothing reports non-reciprocity as such: `variants.ts`
deliberately treats a one-directional declaration as a sibling relationship,
which is correct for *grouping* and leaves the asymmetry itself unreported. In
practice a page declaring nothing back is usually caught by rule 4, but only
when its URL is locale-shaped. This is a scope gap rather than a defect, and
belongs to a slice rather than to this phase.

**The shapes are hand-built page records, not crawled HTML.** They exercise the
rules and the grouping, not hreflang extraction. A change to how `<link>` tags
are parsed would not be caught here; `crawler.test.ts` covers that boundary.
