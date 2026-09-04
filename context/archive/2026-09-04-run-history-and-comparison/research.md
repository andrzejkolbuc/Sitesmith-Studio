---
date: 2026-09-04T09:27:10Z
researcher: Andrzej Kolbuc
git_commit: 1da8b1aedbb0b061c001d23cf431da45dd7644e0
branch: master
repository: Sitesmith-Studio
topic: "What S-07 needs to know: how runs and findings are stored, and what makes two runs comparable"
tags: [research, codebase, runs, findings, comparison, correlation, schema]
status: complete
last_updated: 2026-09-04
last_updated_by: Andrzej Kolbuc
---

# Research: Run history and run-over-run comparison (S-07)

**Date**: 2026-09-04T09:27:10Z
**Researcher**: Andrzej Kolbuc
**Git Commit**: `1da8b1a`
**Branch**: master
**Repository**: Sitesmith-Studio

## Research Question

S-07 claims to be cheap: "adds comparison rather than collection". Is that true of the code
as it stands? Specifically:

1. What is already stored per run, and is it enough to diff two runs?
2. What identity does a finding carry across runs?
3. Does the diff run over raw findings, over S-09's correlated problems, or both?
4. What would make a comparison *dishonest*, given `lessons.md`?

## Summary

**The collection half is genuinely done. The slice is not, however, only a read model — it
needs one new column-set on `runs` and one new per-type projection.**

Four findings drive the plan:

1. **Storage is ready and was designed for this.** `runs`, `pages` and `findings` are all
   first-class tables, and the `findings` table's own doc comment names this slice as the
   reason it exists (`schema.ts:295-299`). Findings are frozen at detection time, so a
   comparison reads *what was concluded then*, not what today's rules would say about
   yesterday's data. Nothing needs to be re-collected.

2. **A finding has no cross-run identity, and whole-row equality will not do.** `findings.id`
   is a per-row UUID and `findings.pageId` points at *that run's* page row, so neither
   survives a run boundary. Naive `detail` equality is worse than useless: `link_broken`
   carries `httpStatus` and `linkedFrom`, `certificate_problem` carries `validTo`. A
   certificate renewal, or one extra page linking to the same dead URL, would read as
   "resolved + new". S-07 needs a **per-type identity projection** — the same shape as the
   existing, tested `evidenceRoles` mapping.

3. **Diff findings, not correlated problems.** Correlation is computed at read time in the
   browser and is deliberately *not* persisted (`run-panel.tsx:195-207`). More decisively,
   its group key is built from `variantGroupKey`, which is the lexicographically smallest
   URL in a family and only unions over *pages the crawl saw* (`variants.ts:179-207`). A
   family whose smallest member 404s in run B gets a different key — so problem-level
   identity would shift for reasons about our crawl rather than about the site. Diff the
   frozen findings; let correlation apply on top at read time, as it does today.

4. **The honesty risk is run comparability, and the schema currently cannot detect it.**
   `crawlComplete` and `scopeNarrowed` are computed in `execute()` and passed to the rules,
   but neither is persisted (`run.ts:206-232`). `projects` is mutable and runs do not
   snapshot its config. So a project whose `includePaths` were narrowed between runs would
   report hundreds of findings as *resolved* — a claim about our configuration, not about
   the site. This is `lessons.md`'s first rule, in the exact shape it has already bitten
   four times.

One correction to carry into planning: **PRD Open Question 5 is resolved, not open.** Run
metadata and findings are kept **indefinitely**. The roadmap's Open Questions list still
says otherwise.

## Detailed Findings

### What already exists

**`runs`** ([schema.ts:200-238](src/server/db/schema.ts)) — `id`, `tenantId`, `projectId`,
`status` (`queued|running|done|failed|interrupted`), `startedAt`, `finishedAt`,
`pagesCrawled`, `findingsCount`, `error`, `createdAt`. Indexed on tenant and project.
Multiple runs per project already accumulate; nothing prunes them.

**`pages`** ([schema.ts:245-305](src/server/db/schema.ts)) — one row per URL per run,
enforced by `uniqueIndex("page_run_url_uq").on(runId, url)`. Carries `httpStatus`, `locale`,
`variantGroupKey`, `hreflangTargets`, `fetchError`. The unique index makes a page-level join
between two runs unambiguous, which is what a page-oriented diff needs.

**`findings`** ([schema.ts:307-352](src/server/db/schema.ts)) — `type` (one of 24), `pageId`
(nullable), `detail` (jsonb). The doc comment is explicit that these are stored rather than
derived *because* of this slice.

**Detection order is already stable.** `detectMissingVariants` documents that "Order is
stable so two runs over the same site produce comparable output — which matters because a
later slice diffs runs against each other" ([findings.ts:198-204](src/server/crawl/findings.ts)).

### What does not exist

| Needed | Status |
| --- | --- |
| A run-history query | **Missing.** Only `latestRun` exists ([project.ts:104-118](src/server/api/routers/project.ts)). |
| Any UI beyond the latest run | **Missing.** `RunPanel` is hard-wired to `latestRun` ([run-panel.tsx:170-181](src/app/(app)/projects/[id]/run-panel.tsx)). No run selector, no history list. |
| Cross-run finding identity | **Missing.** See below. |
| Run comparability metadata | **Missing.** See "The honesty risk". |
| A fixture site that can change between runs | **Missing.** See "Test harness gap". |

### Finding identity across runs

`findings.id` is `crypto.randomUUID()` per row and `findings.pageId` references a page row
scoped to one run, so a diff must join on **content**, not on keys.

The `detail` jsonb cannot be compared wholesale. Sampling the 24 rules
([findings.ts](src/server/crawl/findings.ts)):

- `link_broken` (line 1419) — `httpStatus`, `fetchError`, `confirmed`, `linkedFrom[]`. The
  dead target is the identity; the rest is volatile population.
- `certificate_problem` (line 1489) — `validTo`, `issuer`, `subject`. `validTo` changes on
  every renewal while "expires soon" stays the same problem.
- `metadata_duplicated` (line 979) — `field`, `language`, `value`, `urls[]`. Identity is the
  duplicated *string*; `urls` is who currently carries it.
- `missing_locale` (line 333) — `missingLocale`, `presentLocales[]`, `memberUrls[]`.
  Identity is (family, missing locale).
- Several types carry a `kind` sub-discriminator that **is** part of identity:
  `content_untranslated` (`placeholder_markers` / `identical_to_siblings`),
  `canonical_conflicting` (`multiple` / `chain`), `canonical_target_broken`
  (`failed` / `unreached`).

The precedent to copy is already in the tree: `evidenceRoles`
([summarise.ts:76-270](<src/app/(app)/projects/[id]/summarise.ts>)) is a per-type projection
over `detail` that splits the pages a finding names into `subject` (what is wrong) and
`origin` (where it is fixed). It is tested, covers all 24 types, and has a documented
fail-safe default. An identity projection is the same shape of object and belongs beside it.

**The fail-safe direction is a real decision.** `evidenceRoles` fails an unmapped type
towards *no origin*, so it cannot be correlated on evidence nobody described. For identity
the two directions are: fail towards a **distinct identity every run** (an unmapped type
reports as both new and resolved each run — noisy, but never claims two things are the same)
or towards **type-only identity** (silently merges distinct problems). The first is
consistent with how every rule in this codebase has been made to fail.

**Set-valued subjects are the hard case.** `metadata_duplicated`, `content_duplicated`,
`page_orphaned` and `security_header_contradiction` are about a *set* of URLs. If the set
gains one member between runs, exact set equality reads as resolve + new. Identity for these
plausibly keys on the invariant (the duplicated value, the header name) with the URL set
treated as changed *population* rather than changed identity — which suggests the diff has
three outcomes, not two: **new**, **resolved**, and **still present (changed)**.

### Diff granularity: findings vs correlated problems

Correlation lives at `src/app/(app)/projects/[id]/correlate.ts` and runs in a `useMemo` in
the browser over rows two existing queries already fetched. The decision not to persist it
is explicit and reasoned:

> Read time rather than at detection: the rule is young, and freezing its output into the
> run would mean every improvement to it left old runs describing a site by a rule nobody
> would write today. — [run-panel.tsx:195-203](<src/app/(app)/projects/[id]/run-panel.tsx>)

Note this sits deliberately *opposite* the findings table's "frozen at detection" comment.
The codebase has a two-level position: **conclusions are frozen, presentation is live.** A
run diff is a conclusion about two sets of frozen rows, so it belongs on the frozen side.

Beyond precedent, correlated-problem identity is technically unsafe across runs.
`CorrelatedProblem.key` is `namespace|families:...` or `namespace|pages:...`
([correlate.ts:184-196](<src/app/(app)/projects/[id]/correlate.ts>)), and the family half
resolves through `variantGroupKey`. That key is the lexicographically smallest URL in the
family and is documented as stable — but stable *given the same member set*
([variants.ts:179-184](src/server/crawl/variants.ts)) — and `groupVariants` only unions
pages the crawl actually saw ([variants.ts:210-220](src/server/crawl/variants.ts)). A family
that loses its smallest-URL member, because it 404'd or because the crawl stopped early,
gets a new key, and every problem keyed on it reads as resolved-and-replaced.

**Recommendation:** diff at the finding level. Correlation then folds a diff-annotated
finding list exactly as it folds a plain one today, and "3 of the 20 findings in this
problem are new" comes out for free without any new persisted identity.

### The honesty risk: two runs are not automatically comparable

This is the finding most likely to change the plan's shape.

`execute()` computes two guards and hands them to the rules but stores neither
([run.ts:206-232](src/server/crawl/run.ts)):

- `crawlComplete: result.abortedReason === null && !result.reachedPageLimit`
- `scopeNarrowed: project.includePaths.length > 0`

`runs.status` records `failed` when `abortedReason` is set, so aborts are partially
recoverable — but **hitting the 2,000-page ceiling (`MAX_PAGES`,
[run.ts:42](src/server/crawl/run.ts)) leaves `status: done` with no record that the crawl
was truncated.**

Separately, `projects` is mutable (`updatedAt` uses `$onUpdate`,
[schema.ts:180](src/server/db/schema.ts)) and no run snapshots the config it ran under.
`includePaths`, `excludePaths` and `locales` can all change between runs.

The consequence is direct and severe. Yesterday's session narrowed a real project's
`includePaths` and its page count went 472 → 2. Under a naive diff, the next run would
report **hundreds of findings as resolved** — and "resolved" is the word a user reads as
"the deploy fixed it". That is precisely `lessons.md`'s first rule:

> Every finding must be traceable to something the site itself asserted. If it depends on
> our inference or on how we collected the data, it is a claim about us, not about the
> client.

A run diff is inherently a claim about two of *our* observations, so the rule applies with
full force: the comparison must be able to say **"these two runs are not comparable"** and
decline, rather than report a difference it cannot attribute to the site.

Minimum to make that possible: persist per run whether the crawl completed, whether it hit
the ceiling, and the scope/locale configuration it ran under. That is a schema change, not a
read model — which is the one place the roadmap's "cheap" framing understates the slice.

### Test harness gap

`test/fixtures/site.ts` serves a static `const SITE: Record<string, Page>`
([site.ts:165](test/fixtures/site.ts)), and `FixtureOptions` exposes exactly one knob,
`publishesSiteFiles` ([site.ts:802-813](test/fixtures/site.ts)). `fixture.reset()` clears the
recorded request list, not the site.

**A comparison cannot be tested without a site that changes between two runs.** The fixture
needs a way to mutate — an overrides map, or a `patch()` — so a test can crawl, break one
page, crawl again, and assert exactly one new finding. The fixture's own header warns that
every page added is paid for by every test that crawls it, so an overrides layer applied at
request time is likelier the right shape than more permanent pages.

Integration tests already have the right runner: `runToCompletion`
([run.ts:104-124](src/server/crawl/run.ts)) awaits the crawl instead of backgrounding it, so
a two-run test is straightforward once the fixture can change.

## Code References

- `src/server/db/schema.ts:200-238` — `runs` table; note what is *absent* (completeness, ceiling, scope snapshot)
- `src/server/db/schema.ts:245-305` — `pages`, with the `(runId, url)` unique index
- `src/server/db/schema.ts:295-299` — the comment naming this slice as why findings are stored
- `src/server/db/schema.ts:307-352` — `findings`; `id` is a per-row UUID, `pageId` is run-scoped
- `src/server/crawl/run.ts:42` — `MAX_PAGES = 2_000`, the unrecorded ceiling
- `src/server/crawl/run.ts:206-232` — `crawlComplete` / `scopeNarrowed` computed and discarded
- `src/server/crawl/run.ts:104-124` — `runToCompletion`, the integration-test entry point
- `src/server/crawl/findings.ts:26-77` — the 24 finding types
- `src/server/crawl/findings.ts:198-204` — stable detection order, written for this slice
- `src/server/crawl/findings.ts:1419-1429` — `link_broken` detail: volatile fields inside identity
- `src/server/crawl/findings.ts:1489-1496` — `certificate_problem` detail: `validTo` changes on renewal
- `src/server/crawl/variants.ts:179-207` — union-find; group key is the smallest member URL
- `src/server/crawl/variants.ts:210-220` — only crawled pages are unioned
- `src/server/api/routers/project.ts:104-118` — `latestRun`; no history query exists
- `src/app/(app)/projects/[id]/correlate.ts:135-230` — `correlate()` and its key construction
- `src/app/(app)/projects/[id]/summarise.ts:76-270` — `evidenceRoles`, the per-type projection to copy
- `src/app/(app)/projects/[id]/run-panel.tsx:195-207` — why correlation is read-time, not frozen
- `test/fixtures/site.ts:165` — the static `SITE` map
- `test/fixtures/site.ts:802-813` — `FixtureOptions`, currently one knob

## Architecture Insights

- **Frozen conclusions, live presentation.** Findings are persisted so a comparison sees what
  was concluded then; correlation is recomputed so an improved rule improves old runs. S-07
  sits on the frozen side and should not disturb the live side.
- **Per-type projections over `detail` are the established pattern.** `evidenceRoles` shows
  the shape: exhaustive switch, documented reasoning per case, a fail-safe default, tested
  independently of the database. Identity should follow it rather than invent a scheme.
- **Every absence-reasoning rule already takes an explicit "can I trust this crawl?"
  argument,** required rather than optional so a forgetful caller gets the safe behaviour
  ([findings.ts:93-104](src/server/crawl/findings.ts)). A run comparison reasons from absence
  by construction — "this finding is gone" — so it should take the same kind of required
  guard, sourced from persisted run metadata.
- **Set equality over thresholds.** `correlate.ts` states "there is no threshold anywhere:
  sets are equal or they are not". A diff that scored findings as "similar enough to be the
  same" would break that convention.

## Historical Context (from prior changes)

- `context/changes/first-multilingual-crawl/plan.md:67` — S-01 stored runs (FR-036) and
  explicitly deferred comparison to this slice.
- `context/archive/2026-09-02-crawl-technical-checks/plan.md:87-89` — S-04 declined to persist
  the link graph, assigning a durable `page_links` table to "whichever slice first needs
  run-over-run link comparison". **S-07 does not need it** if the diff is over findings;
  `link_broken` already carries `linkedFrom` in its detail. Worth stating as an explicit
  non-goal so the deferral does not get picked up by default.
- `context/archive/2026-09-03-correlated-findings/research.md` — the S-09 research this builds
  on; documents finding evidence shapes in depth.
- `context/foundation/lessons.md` — both entries apply. Rule 1 governs the comparability
  problem above. Rule 2 ("grouping by shared evidence is not grouping by shared cause") is why
  problem-level identity is not the diff key.
- `context/archive/2026-09-01-seo-metadata-checks/plan.md:389` and
  `context/archive/2026-09-02-crawl-technical-checks/plan.md:969` — both slices verified
  themselves by comparing a new run against the previous one **by finding type, by hand**.
  That manual ritual is the thing this slice automates; its shape is a decent first
  specification of what the output should say.

## Related Research

- `context/archive/2026-09-03-correlated-findings/research.md` — finding evidence and
  correlation keys
- `context/archive/2026-08-31-page-identity-under-redirects/plan-brief.md` — page identity
  under redirects, which the `(runId, url)` unique index now enforces

## Open Questions

1. **What is a finding's identity, per type?** Recommended: a projection beside
   `evidenceRoles`, failing an unmapped type towards "distinct every run". Needs a per-type
   pass over all 24 rules during planning.
2. **Two outcomes or three?** Set-valued findings argue for **new / still present (changed) /
   resolved** rather than new-vs-existing. PRD FR-037 says "see what changed"; US-02's
   acceptance criterion says only "distinguishes new findings from findings that were already
   present" — the narrower reading is defensible and cheaper.
3. **What exactly does a run need to persist to be declared comparable?** At minimum
   completeness and scope. Whether that is a `comparable_key` hash, a config snapshot jsonb,
   or discrete columns is a design decision.
4. **What does the UI do when two runs are not comparable?** Refusing to diff is honest but
   unhelpful if it happens often. Showing the reason ("the crawl scope changed between these
   runs") is probably the answer, but it needs a design.
5. **Does the roadmap's Open Questions list need correcting?** PRD Open Question 5 was
   resolved on 2026-08-31 (runs and findings kept indefinitely; only snapshots are bounded),
   but `context/foundation/roadmap.md` still lists it as unresolved and blocking S-08 and
   S-12. Not S-07's problem to fix, but it is the reason S-07 can assume unbounded history.
