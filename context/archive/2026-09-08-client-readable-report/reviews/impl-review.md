<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Client-readable report (S-11)

- **Plan**: context/changes/client-readable-report/plan.md
- **Scope**: Phases 1-3 of 3 (all complete)
- **Date**: 2026-09-13
- **Reviewed at**: 0998faf
- **Verdict**: REJECTED (triaged 2026-09-13 — all 10 findings fixed; re-verification pending)
- **Findings**: 1 critical, 7 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | WARNING |
| Safety & Quality | FAIL |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | WARNING |

All automated criteria pass at this commit: `typecheck`, `check`, `test:unit` (802),
`test:integration` (122), `test:e2e` (23). All 8 manual criteria are checked, and the two
carried over from the earlier session were confirmed to have observable evidence rather
than being rubber-stamped.

## Findings

### F1 — Expired snapshots render as two broken images

- **Severity**: CRITICAL
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/app/(app)/projects/[id]/report/[runId]/page.tsx:113-115
- **Detail**: The section filters on `differsMeaningfully` alone. That reads only
  `row.comparison` (visual.ts:204-208) and never `expiredAt` or `captureError`. Retention
  (retention.ts:102) sets `image: null, byteSize: null, expiredAt: now` and deliberately
  **preserves `comparison`** so an expired picture stays distinguishable from one never
  taken. An expired row therefore still passes the filter, and the image route returns
  `notFound()` on a null image (route.ts:116). `runsToExpire` keeps only the
  `SNAPSHOTS_KEPT` most recent runs plus the pinned baseline, so **any report printed from
  a run outside that window is certain to render broken images** — and a hand-over document
  is exactly the thing re-opened later. The sibling gets this right: visual-panel.tsx:333
  computes `uncomparedReason(row)`, which checks `expiredAt` at visual.ts:177.
  Verified independently against all four files.
- **Fix**: Filter on `uncomparedReason(row) === null && differsMeaningfully(row)`, as
  visual-panel.tsx does — or print the reason in words, which is what `uncomparedReason`
  returns and what the report's own register would prefer.
- **Decision**: FIXED — filter now requires `uncomparedReason(row) === null`, matching visual-panel.tsx

### F2 — The report states speed coverage it never shows

- **Severity**: WARNING
- **Impact**: MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: src/app/(app)/projects/[id]/coverage.ts:273-284
- **Detail**: Phase 3's contract names `runObservations` among the procedures the view
  renders from. It is never called, so the report carries no speed or loading-error
  section. Meanwhile `clientCoverageSentences` still prints "Speed and loading errors were
  measured on N of M pages — a sample, not the whole site." Confirmed in a generated PDF:
  the fixture report says exactly that, and its only sections are "What this check
  covered", "What we found" and "Pages that look different". The omission is arguably
  compelled by Phase 2 — client-vocabulary.test.ts:159 bans `ttfb|lcp|cls` and no client
  sentence exists for a speed observation — but as shipped the document promises more than
  it delivers.
- **Fix A (Recommended)**: Drop the sample-coverage sentences from
  `clientCoverageSentences` and record the decision in the plan.
  - Strength: Restores the document's internal consistency without inventing a vocabulary
    Phase 2 deliberately refused; smallest change that makes the report honest.
  - Tradeoff: The client is told less; a run where speed was unmeasurable says nothing.
  - Confidence: HIGH — the sentences have no consumer in the report.
  - Blind spot: Have not checked whether anything else reads those two branches.
- **Fix B**: Add a speed section in client register, extending the Phase 2 vocabulary.
  - Strength: Delivers what the coverage sentence already promises.
  - Tradeoff: Re-opens a scope Phase 2 closed on purpose, and needs new banned-jargon
    wording for metrics whose names are the jargon.
  - Confidence: MEDIUM — the plan did contract for `runObservations`.
  - Blind spot: Unclear that a client contact can act on TTFB/LCP at all.
- **Decision**: FIXED via Fix A — sample-coverage sentences removed from `clientCoverageSentences`; operator `coverageSentences` untouched

### F3 — `?view=baseline` resolves against the current baseline, not the compared one

- **Severity**: WARNING
- **Impact**: MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/app/(app)/projects/[id]/report/[runId]/page.tsx:232-233, 248
- **Detail**: The route resolves the baseline view against `project.baselineRunId` as it is
  now (route.ts:133-140), while the "differs" verdict beside it came from the baseline in
  force at run time. After a re-pin, the report can show a page under "Pages that look
  different" with two identical pictures, or 404 if the URL is absent from the new baseline.
  `runSnapshots` already returns `projectBaselineRunId` (project.ts:619) precisely so
  callers can detect this, and visual.ts:163 computes `supersededBaseline` from it. The
  report reads neither. The caption "Compared against the reference pictures set for this
  site" is ambiguous enough to hide the problem, which is worse on paper.
- **Fix**: Compare `snapshots.projectBaselineRunId` against `summary.baselineRunId`; when
  they differ, say so in the caption or omit the section.
- **Decision**: FIXED — caption states when the reference pictures were replaced after the check

### F4 — The route defends none of its own preconditions

- **Severity**: WARNING
- **Impact**: MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/app/(app)/projects/[id]/report/[runId]/page.tsx:79-84
- **Detail**: Two gaps with one shape. (a) The "settled run only" rule lives solely in the
  link (run-panel.tsx:363), whose own comment says a report of an in-flight crawl "would
  describe a site by however much of it had been seen — which is the one thing this slice
  exists to stop". A bookmark or shared link renders exactly that, and its coverage sentence
  is the bland `not_recorded` line because `crawlComplete` is still null mid-run. (b) The
  first `Promise.all` is wrapped (:59-68); the second is not, and there is no `error.tsx`
  anywhere under `src/app`, so a transient failure shows Next's unstyled error page on the
  one URL a non-technical client is expected to open.
- **Fix**: `notFound()` or a "still running" state when `run.status` is `queued`/`running`,
  and wrap the second batch or add an `error.tsx` for the report segment.
- **Decision**: FIXED — `notFound()` for queued/running runs, plus a client-register `error.tsx` for the segment

### F5 — The report's distinguishing claims have no end-to-end guard

- **Severity**: WARNING
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: e2e/journeys/client-report.spec.ts
- **Detail**: Phase 3's contract requires the journey to assert "that a truncated run's
  report states its coverage". All three tests crawl the same complete fixture
  (:22-24, :59-61, :87-89), so only the `whole_crawl` branch of `clientCoverageSentences`
  is ever exercised end to end. The sentence the slice exists to produce — "your site is
  larger than what is described here" — is covered only by unit tests and by manual step
  3.10. Separately, the project/run pairing guard at page.tsx:77 has no test at any level:
  nothing requests `/projects/{A}/report/{runB}`. That guard is the only thing preventing a
  document confidently headed with the wrong project's name and start URL.
- **Fix**: Two tests — a run with `reachedPageLimit` asserting the partial-coverage
  sentence, and a mismatched project/run pair asserting 404.
- **Decision**: FIXED — two journeys added: a truncated run asserting the partial-coverage sentence, and a mismatched project/run pair asserting 404

### F6 — Redundant findings query with an unreachable fallback

- **Severity**: WARNING
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/app/(app)/projects/[id]/report/[runId]/page.tsx:79-84, 92-95
- **Detail**: `comparison.findings.length > 0 ? comparison.findings : findings.map(...)`.
  Verified that **every** branch of the `comparison` procedure returns the current findings:
  first run (project.ts:390-396), incomparable (:400-405), and comparable via
  `compareFindings` (:418). So `comparison.findings` always contains all current findings,
  and the fallback can only fire when both are empty — where it produces the same `[]`. The
  extra call costs a run lookup, an `assertProjectAccess` and a full second read of the
  findings table.
- **Fix**: Drop the `findings` call and the ternary; derive `annotated` from
  `comparison.findings`. If the fallback was meant to survive a *failed* comparison, that
  needs a try/catch, not a length check.
- **Decision**: FIXED — `findings` call and the ternary removed; `annotated` derives from `comparison.findings`

### F7 — No caps, and no backstop either

- **Severity**: WARNING
- **Impact**: HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Architecture
- **Location**: src/app/(app)/projects/[id]/report/[runId]/page.tsx:194-219, 245-255
- **Detail**: The no-caps decision is correct and well argued — "and 3 more" cannot be
  expanded once printed. But it is unbounded in every direction at once. One observed
  finding names 502 URLs in a single list; the yazaki report is 40 printed pages built and
  serialised in one server pass. On a 2000-page crawl (the crawler's own ceiling) with
  several family-level types this is tens of thousands of nodes. Snapshot images compound
  it: fetched eagerly, two per changed page, uncapped, with no `loading` attribute, and the
  route's first `findFirst` (route.ts:74) takes no `columns` projection, so the full PNG
  blob is read even on the `view=baseline` path that discards it. Every sibling caps
  (summarise.ts:47, parity.ts:136, trend.ts:235); this one removes every bound with no
  ceiling at which it says so.
- **Fix A (Recommended)**: Keep the no-caps rule; add a ceiling above which the report says
  in plain words that the list is too long to print and points to the console.
  - Strength: Preserves the documented reasoning while bounding the pathological case;
    the report's own register already has a vocabulary for saying what it did not do.
  - Tradeoff: A threshold is another number to justify, as `MAX_UNBROKEN_PAGES` was.
  - Confidence: MEDIUM — no observed failure yet; 502 URLs rendered fine.
  - Blind spot: Have not measured where the render actually degrades.
- **Fix B**: Leave rendering alone; only add the `columns` projection to the snapshot route.
  - Strength: Removes the largest wasted cost (blob reads) for a few lines.
  - Tradeoff: Node count and payload size stay unbounded.
  - Confidence: HIGH — the projection is unambiguously correct.
  - Blind spot: Does nothing for the 2000-page case.
- **Decision**: FIXED via Fix A — `MAX_LISTED_PAGES` withdraws (never trims) an over-long list and says so; snapshot route now projects columns and reads bytes only where returned

### F8 — Page count fetched wholesale, and may disagree with the coverage sentences

- **Severity**: WARNING
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/app/(app)/projects/[id]/report/[runId]/page.tsx:80, 117
- **Detail**: `runPages` pulls every page row of the run — including the `images` jsonb
  payload, up to 2000 rows — solely to compute `new Set(pages.map(p => p.url)).size`.
  `run.pagesCrawled` is on the run row already and is what coverage.ts:132,146 uses as the
  denominator in the sentences printed a few lines above. So the header and the coverage
  statement can print two different page counts for the same run, with no comment saying
  the difference is intended.
- **Fix**: Use `run.pagesCrawled`, or document why the distinct-URL count is deliberately
  different.
- **Decision**: FIXED — header uses `run.pagesCrawled`, the same number the coverage sentences divide by; `runPages` call dropped

### F9 — "No longer reported" prints identical lines instead of grouping

- **Severity**: OBSERVATION
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/app/(app)/projects/[id]/report/[runId]/page.tsx:263-283
- **Detail**: One `<li>` per resolved finding printing only `CLIENT_LABEL[finding.type]`.
  Fifty resolved `link_broken` findings print fifty byte-identical lines, which on paper
  reads as fifty distinct fixes. The present-findings path twenty lines above (:106-111)
  groups by type for exactly this reason.
- **Fix**: Group and count, as the section above does.
- **Decision**: FIXED — resolved findings grouped by type with an instance count

### F10 — Unplanned band carrier, and two smaller convention slips

- **Severity**: OBSERVATION
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline / Pattern Consistency
- **Location**: src/app/(app)/projects/[id]/performance-table.tsx:138-159
- **Detail**: Phase 3 contracted the non-colour band carrier as print CSS; it was
  implemented instead as a `BAND_MARK` glyph with `sr-only` text in the component. The
  mechanism is better than planned — it works on screen, serves colour-blind and
  screen-reader users, and does not depend on a print sheet — but it landed in a component
  no phase's "Changes Required" names, and it has no test. (The plan's own citation
  `performance-table.tsx:55-60` was already stale when written; `BAND_STYLE` has been at
  :26-31 throughout.) Two smaller slips: report page.tsx stacks two doc-comment blocks with
  nothing between them, so the file's central rationale is syntactically attached to
  `MAX_UNBROKEN_PAGES` while `ReportPage` carries no doc — every sibling does module-doc-
  above-imports or doc-on-the-symbol; and globals.css:115-121 still gives bare `figure` an
  unconditional `break-inside: avoid`, the same shape `MAX_UNBROKEN_PAGES` was introduced
  to avoid, which can reintroduce a near-blank page if the print viewport falls below
  Tailwind's `sm` breakpoint and `sm:grid-cols-2` stacks the two 22cm images.
- **Fix**: Add a test for `BAND_MARK` and a plan addendum; move the module doc above the
  imports; bound the figure height in print.
- **Decision**: FIXED (all three) — BAND_MARK/BAND_MEANING moved to performance.ts with 4 new tests; module doc moved above imports; print CSS pins the figure grid to two columns and halves figure image height

## What held

- **All seven "What We're NOT Doing" boundaries.** No severity or ranking, no correlation
  layer, the 845-line `Evidence` switch untouched, no PDF pipeline or tokenised link or env
  var, **no server-side change at all** across the four commits — so no new tRPC procedure
  and no schema change — `STATUS_LABEL` keys and `comparability()` unchanged, and nothing
  touching read-time reproducibility.
- **Authorization.** Verified rather than assumed: the `(app)` layout establishes session
  and tenant structurally per request, every procedure the page calls resolves under
  `tenantScope` then `assertProjectAccess`, and that helper throws a bare `NOT_FOUND` so
  cross-tenant and cross-project are indistinguishable from non-existent. The pairing guard
  at page.tsx:77 defends document *truthfulness*, not confidentiality.
- **No XSS.** No `dangerouslySetInnerHTML` in the change. All crawled third-party data
  reaches the DOM as JSX text or `alt`. The only attribute interpolation is our own UUID.
- **Nullable discipline.** `coverage.ts` is the strongest part of the change: three-state
  handling on every nullable column, with `crawlCoverage` explicitly refusing to infer
  completeness from `reachedPageLimit === false` alone, and `coverage.test.ts:74-94`
  locking it down.
- **The doc-comment convention**, at a high standard throughout.
