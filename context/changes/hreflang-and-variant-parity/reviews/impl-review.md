<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: hreflang graph and cross-variant parity

- **Plan**: `context/changes/hreflang-and-variant-parity/plan.md`
- **Scope**: Full plan — Phases 1–3 of 3 (29/29 criteria complete)
- **Date**: 2026-08-30
- **Verdict**: APPROVED — triaged 2026-08-30 (3 fixed, 1 accepted)
- **Findings**: 0 critical, 1 warning, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Automated criteria re-run during this review: `npm run typecheck` clean,
`npm run check` clean (1 pre-existing scaffold info), `npm run test:all` green —
114 unit, 34 integration, 15 browser.

Scope guardrails from "What We're NOT Doing" verified against the diff:
`src/server/db/schema.ts` untouched (no migration, as planned),
`src/server/api/routers/project.ts` and `src/server/crawl/run.ts` untouched
(the known `startRun` status-code defect was left alone as stated), and no
run-to-run comparison was introduced.

## Findings

### F1 — The hreflang graph is traversed three times per detection pass

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/server/crawl/findings.ts:83, 174, 281
- **Detail**: `detectMissingVariants` calls `groupVariants(pages)` directly for
  rule 1, then calls `groupFamilies(pages)` twice — once for rule 6 and again for
  rule 5. `groupFamilies` calls `groupVariants` internally
  (`src/server/crawl/variants.ts:134`), so the union-find over the whole hreflang
  graph, plus the map-building passes around it, now run three times on every
  run. Before this slice it ran once. The ceiling is 2,000 pages
  (`src/server/crawl/run.ts`), and union-find is near-linear, so this is waste
  rather than danger — but it is waste on the one function that runs on every
  check, and it grew silently because each rule was added independently.
- **Fix A ⭐ Recommended**: Hoist `groupFamilies(pages)` into a single `const`
  above rule 6 and reuse it in rule 5.
  - Strength: One line, no behaviour change, removes one of the two duplicate
    traversals immediately. The two loops already consume the same shape.
  - Tradeoff: Leaves two traversals rather than one — rule 1 still builds its own
    grouping from `groupVariants`.
  - Confidence: HIGH — the two call sites take identical arguments and neither
    mutates the result.
  - Blind spot: None significant; the full suite covers all six rules.
- **Fix B**: Rewrite rule 1 on top of `groupFamilies` so the graph is walked once.
  - Strength: Reduces three traversals to one and removes the last direct
    `groupVariants` call from this file. `VariantFamily` already carries
    `groupKey`, and `FamilyMember` carries `url` and `locale` — everything rule 1
    reads.
  - Tradeoff: Touches shipped, mutation-verified rule-1 behaviour for a
    performance gain that no measurement has shown to matter.
  - Confidence: MEDIUM — the data is equivalent, but rule 1 counts *all* members
    including errored ones, whereas the family consumers filter them; the
    rewrite must preserve that distinction or rule 1 changes meaning.
  - Blind spot: No profiling exists for a 2,000-page run, so the size of the win
    is unmeasured.
- **Decision**: FIXED via Fix A — `groupFamilies` hoisted to a shared `const variantFamilies`; three traversals reduced to two. The hoist surfaced a name shadow with rule 1's local `families`, resolved by the rename.

### F2 — Four files changed that the plan never named

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: src/app/(app)/projects/[id]/summarise.ts, summarise.test.ts, src/server/crawl/run.test.ts, vitest.unit.config.ts
- **Detail**: The plan's "Changes Required" names seven files; the diff touches
  eleven. The extras are each defensible and each explained in a commit message —
  `summarise.ts`/`summarise.test.ts` were extracted to make criterion 3.8
  verifiable and then to hold the page-count rule the user asked for in 3.7;
  `run.test.ts` had a timeout raised after fixture growth pushed a pre-existing
  test past its limit; `vitest.unit.config.ts` gained an include for the new
  tests. None is scope creep in the sense of unrequested feature work. The gap is
  bookkeeping: the plan was amended twice mid-flight for design changes but never
  to name these files, so a future reader comparing plan to diff sees four
  unexplained entries.

  Related and minor: the Phase 3 fixture Contract says "leaving every existing
  path and its declarations untouched", but two links were added to `/` so the
  new pages are reachable. The intent behind that wording — protecting existing
  assertions — was honoured and verified (`missing_locale` 2,
  `hreflang_target_failed` 1, `no_hreflang` 1, all unchanged).
- **Fix**: Add a short addendum to the plan naming the four files and why each
  changed, so plan and diff agree.
- **Decision**: FIXED — addendum appended to plan.md naming the four unplanned files, the fixture-link deviation, and the F1 fix.

### F3 — The shared fixture is now a silent cost surface

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: test/fixtures/site.ts, src/server/crawl/run.test.ts:271
- **Detail**: Adding six pages to the crawlable fixture broke an integration test
  that had nothing to do with this slice — it goes through `project.create` and
  so inherits the real 500ms politeness delay, and was already running at 5017ms
  against a 5000ms limit. It was fixed by raising the limit to 30s, which is the
  right call for that test, but it makes the underlying hazard explicit: every
  page added to this fixture slows every test that crawls it, and nothing warns
  when one gets close to its budget. The next person to extend the fixture will
  hit the same wall with less context about why.
- **Fix**: Note the cost in the fixture's header comment — that pages added here
  are paid for by every crawling test, and that one test runs at real politeness
  pacing.
- **Decision**: FIXED — the cost is now stated in the fixture's header comment, including the 5017ms/5000ms incident and the instruction to raise the budget rather than remove the pacing.

### F4 — Criterion 3.8 is complete but its rendering is unverified

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: context/changes/hreflang-and-variant-parity/plan.md (Progress 3.8)
- **Detail**: 3.8 — "a wide family's truncation states how many members were not
  shown" — is marked complete. The truncation *rule* is tested at its boundary in
  `summarise.test.ts`, and an off-by-one fails four cases. The *rendering* of
  "and N more pages" is asserted nowhere, because no fixture family is wide
  enough to truncate, so no crawl the suite performs can produce the case. This is
  recorded in the plan row itself rather than hidden, which is why it is an
  observation rather than a warning — but it is the one criterion in this slice
  whose user-visible half rests on inspection that nobody could actually perform.
- **Fix**: Either accept as recorded, or add a fixture family with more than five
  members so the rendered case exists and can be asserted.
- **Decision**: ACCEPTED — the rule is boundary-tested and the rendering gap is recorded in the plan row. Closing it would mean growing the fixture again, which is the cost F3 documents.
