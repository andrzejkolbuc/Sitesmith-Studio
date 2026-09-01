<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Cross-variant content drift

- **Plan**: `context/changes/cross-variant-content-drift/plan.md`
- **Scope**: Phases 1–4 of 4 (full plan)
- **Date**: 2026-09-01
- **Verdict**: APPROVED (post-triage; NEEDS ATTENTION as first reported)
- **Findings**: 0 critical, 2 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS (F1 fixed) |
| Scope Discipline | PASS |
| Safety & Quality | PASS (F2 fixed) |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Findings

### F1 — `<article>` before `<main>` wins the region, contradicting "prefer"

- **Severity**: WARNING
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `src/server/crawl/content.ts` — `MAIN_REGION`
- **Detail**: The plan's phase 1 contract says "Prefer `<main>` or `<article>` when present". The
  implementation is a single alternation, `<(main|article)\b[^>]*>([\s\S]*?)</\1\s*>`, so the region
  appearing **first in document order** wins rather than `<main>` winning.

  Verified empirically: a page with a sidebar `<article>` before its `<main>` digests the sidebar
  (479 chars) instead of the main content (719 chars), and produces a different digest from the same
  page with the sidebar removed. Every downstream claim — rule 7's identity comparison and rule 8's
  block presence — is then made about the wrong region.

  Did not fire on yazaki, where all 14 sampled pages resolved `<main>` correctly, so this is latent
  rather than observed in the wild.
- **Fix**: Try `<main>` first and fall back to `<article>` only when no `<main>` exists, matching the
  word "prefer" in the plan.
  - Strength: One-line change to region resolution; the `isolated` flag and every existing test stay
    meaningful without modification.
  - Tradeoff: None identified — no current test depends on document-order precedence.
  - Confidence: HIGH — reproduced directly against the extractor.
  - Blind spot: None significant.
- **Decision**: FIXED — <main> tried first, <article> only as fallback; regression test added

### F2 — A listing page digests only its first `<article>`

- **Severity**: WARNING
- **Impact**: MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/server/crawl/content.ts` — `MAIN_REGION`, consumed by `findings.ts` rule 7
- **Detail**: `MAIN_REGION` is non-global and lazy, so on a page containing several `<article>`
  elements it captures only the first. Verified: a two-article listing page produces a digest
  **identical** to that of its first article alone.

  This matters for rule 7, whose entire justification is conservatism. Two locale variants of a
  listing page whose leading item happens to be the same untranslated article would digest
  identically and be reported as untranslated content — a finding about one item presented as a
  finding about the page. It also under-represents the page for rule 8, since blocks in later
  articles are invisible.

  Not observed on yazaki, whose pages all carry `<main>`, so `<article>` never became the region.
- **Fix A (Recommended)**: After preferring `<main>`, fall back to `<article>` only when the document
  contains exactly one; otherwise fall back to the whole body with `isolated: false`.
  - Strength: Keeps isolation for genuine single-article pages (the case `<article>` was added for)
    while refusing to speak about listings — the same "decline rather than guess" discipline
    `isolated` already encodes and that rule 8 depends on.
  - Tradeoff: Blog listings lose isolation and drop out of rule 8 entirely. Correct, but it narrows
    coverage on content-heavy sites.
  - Confidence: HIGH — mirrors the existing fallback path, which is already tested.
  - Blind spot: Have not measured how many real pages carry multiple `<article>` elements without a
    `<main>`. Yazaki cannot answer this, because it always has `<main>`.
- **Fix B**: Concatenate every `<article>` in the document as the region.
  - Strength: Represents the whole page rather than a fragment; keeps listings inside rule 8.
  - Tradeoff: A concatenated region is not "the main content" in any sense the site asserted — it is
    our construction, which is the kind of inference `context/foundation/lessons.md` warns produces
    claims about us rather than about the client.
  - Confidence: MEDIUM — behaviour is predictable, but the semantics are ours to justify.
  - Blind spot: Digest stability across pagination and reordering is unexamined.
- **Decision**: FIXED via Fix A — <article> accepted only when the document holds exactly one; listings fall back with isolated:false

### F3 — The new test file needed a config edit the plan never mentioned

- **Severity**: OBSERVATION
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: `vitest.unit.config.ts`
- **Detail**: `vitest.unit.config.ts` uses an explicit `include` list, so `content.test.ts` had to be
  added by hand. The plan did not mention this. It was caught only because the unit count stayed at
  138 after 25 tests were written; without that check the extractor's entire test file would have
  silently never run.

  The change itself is correct and necessary. Recorded because the near-miss belongs to the same
  family as the three vacuous tests found during implementation: a test that exists but does not
  execute is indistinguishable from one that passes.
- **Fix**: None needed. Worth remembering that this config does not glob.
- **Decision**: SKIPPED

### F4 — Content extraction walks the full document twice per page

- **Severity**: OBSERVATION
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/server/crawl/content.ts` — `extractContent`
- **Detail**: `extractContent` calls `visibleText` twice — once over the whole document (with code
  samples stripped) to find markers, once over the isolated region to produce the digest. Each call
  runs four regex passes. Against a 2,000-page ceiling with large pages this is real CPU.

  It is off the network path, so NFR-1 is untouched, and the yazaki run's 412s over 533 pages is
  dominated by the deliberate inter-request delay (533 × 0.5s ≈ 267s) rather than by parsing. No
  action proposed; recorded so a future performance question starts from a known fact.
- **Fix**: None proposed. Revisit only if crawl duration becomes the constraint.
- **Decision**: SKIPPED

### F5 — Phase 4's key criteria pass only vacuously

- **Severity**: OBSERVATION
- **Impact**: MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: `plan.md` Progress 4.3, 4.4
- **Detail**: Criteria 4.3 and 4.4 ask that every new finding names a real defect. The yazaki run
  produced **zero** findings from either rule, so both are satisfied without testing anything.

  The evidence behind that zero is strong and was verified rather than assumed — 14/14 pages
  isolated, 14/14 digested, 51 families covering 510 of 533 pages — so the rules had full visibility
  and chose silence. That is real evidence against the PRD's noise objection, which is the risk that
  could kill this product.

  It is not evidence that either rule detects anything. No true positive has been observed outside
  the fixture, and F1 and F2 are both latent defects that a site without `<main>` would have exposed.
  The distinction should be explicit when S-03 is marked done.
- **Fix**: Record the vacuous pass in the roadmap's S-03 entry rather than letting "criteria met"
  imply the rules are proven in both directions. Optionally crawl a second client site before
  closing.
- **Decision**: SKIPPED

## Triage — 2026-09-01

| Finding | Decision |
|---|---|
| F1 | FIXED — `<main>` tried first; `<article>` only as fallback |
| F2 | FIXED via Fix A — `<article>` accepted only when the document holds exactly one |
| F3 | SKIPPED — recorded here, not promoted to a lessons rule |
| F4 | SKIPPED — no action; cost is invisible beside the politeness delay |
| F5 | SKIPPED — 4.3 and 4.4 accepted as met without qualification |

Both fixes are mutation-verified: restoring the single alternation fails the two
new extractor cases, and accepting any number of `<article>` elements fails the
listing case.

Verification after triage: `npm run typecheck` clean, `npm run check` clean,
192 unit and 35 integration tests pass. The browser suite could not run — a dev
server already holds port 3000 — so its last green result predates these two
edits. Those edits touch region selection in `content.ts` and its unit tests
only; no UI code changed.
