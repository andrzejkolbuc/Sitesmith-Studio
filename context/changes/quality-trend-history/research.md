---
date: 2026-09-04T18:05:24Z
researcher: Andrzej Kolbuc
git_commit: c3ba0d3dd84ee54f81cadc555f782d200c41e8ca
branch: master
repository: Sitesmith-Studio
topic: "What S-12 can honestly draw: scores, issue counts, and what makes two runs points on the same line"
tags: [research, codebase, runs, trend, scores, comparability, rule-drift]
status: complete
last_updated: 2026-09-04
last_updated_by: Andrzej Kolbuc
---

# Research: Quality trend history (S-12)

**Date**: 2026-09-04T18:05:24Z
**Researcher**: Andrzej Kolbuc
**Git Commit**: `c3ba0d3`
**Branch**: master
**Repository**: Sitesmith-Studio

## Research Question

S-12 says "scores and issue counts tracked over time". Three things needed
settling before a plan was worth writing:

1. What is a "score"? Nothing in the product computes one.
2. What makes two runs points on the same line?
3. Counts of what — findings, correlated problems, or per-type series?

## Summary

**The slice is smaller than the roadmap thinks, and blocked in a way the
roadmap does not record.**

1. **"Scores" are not ours to invent — they are S-06's.** FR-039's wording
   traces to FR-028, "Core Web Vitals and standard page performance scores"
   ([prd.md:247](context/foundation/prd.md)), and to the PRD's regression
   catalogue at [prd.md:62](context/foundation/prd.md). S-06 delivers those and
   is `proposed`. **S-12 cannot deliver the scores half of FR-039 at all**, and
   the roadmap lists its prerequisites as S-07 only.

2. **The issue-counts half needs no new collection and, for a plain total, no
   new query.** `project.runs` already returns every field a counts trend reads
   ([project.ts:151-168](src/server/api/routers/project.ts)).

3. **A total finding count is not honest to trend, and the real data proves
   it.** yazaki's ten runs read 12 → 0 → 8 → 8 → 9 → 42 → 66 → 67 → 67 → 67.
   Almost none of that is the site. Per-type series are honest where a total is
   not, because a rule arriving shows up as a series beginning rather than as a
   site degrading.

4. **But the product cannot currently tell which rules ran on a given run.** A
   type with no rows is indistinguishable from a type whose rule did not exist
   yet. This is the same shape of problem S-07 solved for scope, and it wants
   the same shape of answer: record it on the run.

5. **There is exactly one honest score-shaped number already in the product**,
   and S-07 accidentally made it trendable: the parity ratio.

## Detailed Findings

### "Scores" means Core Web Vitals, and they belong to S-06

FR-039 reads "User can see scores and issue counts tracked over time to reveal
quality drift" ([prd.md:287](context/foundation/prd.md)). The word is not
defined there, but it is used twice more in the PRD and means the same thing
both times:

- [prd.md:62](context/foundation/prd.md) — "**Performance regression** — Core
  Web Vitals or page performance scores dropped versus the previous run on the
  same page."
- [prd.md:247](context/foundation/prd.md) — FR-028, "User can see Core Web
  Vitals and standard page performance scores for a representative sample of
  pages".

`grep -i score` over `src/` returns nothing. The product computes no score, and
the PRD never asked it to invent one — it meant the numbers a browser reports.

Those come from **S-06 `browser-observed-checks`** (FR-015, FR-028, FR-029),
whose status is `proposed`. The roadmap records S-12's prerequisites as **S-07
only** ([roadmap.md:66](context/foundation/roadmap.md)), which is wrong for the
scores half of FR-039.

**This is a scoping decision for planning, not a blocker**: the counts half is
independently useful and independently deliverable. But the slice should say out
loud that it delivers half of FR-039, or the requirement will be recorded as met
when it is not.

### What is already stored, and what a trend can read for free

`runs` carries, per run: `status`, `createdAt`, `startedAt`, `finishedAt`,
`pagesCrawled`, `findingsCount`, `error`, and — since S-07 —
`crawlComplete`, `reachedPageLimit` and a `scope` snapshot
([schema.ts:200-262](src/server/db/schema.ts)).

`project.runs` returns those rows whole, newest first
([project.ts:151-168](src/server/api/routers/project.ts)). **A total-count trend
therefore needs no new query and no new column** — the run history view already
fetches its data.

Per-type series do need a new query, but a cheap one: `findings` is indexed on
`(runId, type)` via `finding_type_idx`
([schema.ts:345](src/server/db/schema.ts)), so a `group by runId, type` over a
project's runs is an index-only aggregate.

### The total is not honest, and the data says so

The ten stored yazaki runs, in order:

| date | run | pages | findings | `crawlComplete` |
| --- | --- | --- | --- | --- |
| 08-30 | `4a17fff0` | 569 | 12 | null |
| 08-31 | `2088797b` | 0 | 0 | null (interrupted) |
| 08-31 | `71708289` | 533 | 8 | null |
| 08-31 | `23ec31e8` | 533 | 8 | null |
| 09-01 | `af97d198` | 533 | 9 | null |
| 09-02 | `8a2e9cc9` | 533 | 42 | null |
| 09-03 | `c80873b4` | 533 | 66 | null |
| 09-03 | `29fa2fc7` | 533 | 67 | null |
| 09-04 | `547cac73` | 533 | 67 | **true** |
| 09-04 | `68770541` | 533 | 67 | **true** |

Drawn naively this is a site collapsing from 12 problems to 67. Every step has a
cause in *this repository*:

- **569 → 533 pages** — page identity under redirects, which stopped counting
  aliases as pages (`context/archive/2026-08-31-page-identity-under-redirects/`).
  Even the denominator moved.
- **12 → 8** — the same change, plus rule 5 being narrowed.
- **9 → 42** — S-05 shipped the SEO metadata rules on 09-02.
- **42 → 66** — S-04 shipped the crawl-level technical checks on 09-03.
- **the 0** — an interrupted run, which is not a data point at all.
- **8 of 10 runs have null comparability metadata** and predate S-07.

### Per-type series are honest where a total is not

Per-type first appearance across those runs:

| type | first seen | runs present |
| --- | --- | --- |
| `hreflang_family_inconsistent` | 08-30 | **1** |
| `variant_diverged` | 08-30 | 9 |
| `metadata_duplicated` | 09-02 | 5 |
| `link_broken` | 09-03 | 4 |
| `link_external_broken` | 09-03 | 4 |
| `page_missing_from_sitemap` | 09-03 | 4 |
| `page_orphaned` | 09-03 | **3** |

Read as series, the rule history becomes visible rather than hidden: the 09-02
and 09-03 clusters are S-05 and S-04 arriving. `hreflang_family_inconsistent`
appearing in exactly one run is the rule being narrowed afterwards.
`page_orphaned` in three of the four runs since it shipped is yesterday's
scope-narrowed suppression removing it from the latest.

A total conflates all of that with the site. A per-type series at least puts each
change where a reader can see it.

### The gap per-type series do not close

**Nothing records which rules ran on a given run.** A type with no rows in run N
could mean the rule found nothing, or that the rule did not exist. Both render as
zero, and the second is a claim about us.

This is exactly the shape of problem S-07 solved. `execute()` computed
`crawlComplete` and `scopeNarrowed` and discarded them, so no comparison could
tell a truncated crawl from a complete one; the fix was to record them on the
run ([schema.ts:233-262](src/server/db/schema.ts)). The rule set is the same kind
of fact — something true of the run, knowable only at run time, and unrecoverable
afterwards.

`FINDING_TYPES` is a single frozen object
([findings.ts:26-77](src/server/crawl/findings.ts)), so recording the set — or a
version derived from it — costs one column and one line in `execute()`.

### The one honest score already in the product

`buildParity` produces `clean` — families with nothing wrong — against the total
family count, rendered as "50 of 51 page families in step"
([parity.ts:30-40](<src/app/(app)/projects/[id]/parity.ts>),
[run-panel.tsx:501-512](<src/app/(app)/projects/[id]/run-panel.tsx>)).

It is the only score-shaped number here, and it is honest in the way an invented
weighting would not be: families come from the site's own hreflang graph, and
"in step" is a property of what the site publishes, not a severity we assigned.

**S-07 made it trendable without meaning to.** Parity needs two inputs: the
pages of a run (stored, with `locale` and `variantGroupKey`) and the project's
expected locales — which were mutable and unrecorded until S-07 began
snapshotting them into `runs.scope.locales`. A historical parity ratio computed
against *today's* expected locales would be a claim about today's configuration;
computed against the run's own recorded locales it is a claim about that run.

So parity is trendable **for runs from S-07 onward**, and not before — the same
boundary the comparison already draws.

## Code References

- `context/foundation/prd.md:62,247,287` — the three uses of "score"; all mean Core Web Vitals
- `context/foundation/roadmap.md:60` — S-06, which owns those scores, is `proposed`
- `context/foundation/roadmap.md:66` — S-12's prerequisites, which omit S-06
- `src/server/db/schema.ts:200-262` — `runs`, including S-07's three columns
- `src/server/db/schema.ts:345` — `finding_type_idx` on `(runId, type)`
- `src/server/api/routers/project.ts:151-168` — `project.runs`, already returning everything a total-count trend needs
- `src/server/crawl/findings.ts:26-77` — `FINDING_TYPES`, the rule set that is not recorded per run
- `src/server/crawl/run.ts:229-262` — where a rule-set column would be written, beside `crawlComplete`
- `src/app/(app)/projects/[id]/parity.ts:30-40` — `Parity.clean`, the one honest score-shaped number
- `src/app/(app)/projects/[id]/run-panel.tsx:501-512` — where it is rendered today

## Architecture Insights

- **Record what was true of the run, or the reader gets a claim about us.** S-07
  established this for completeness and scope. Rule set is the same category of
  fact, and the trend is the feature that needs it.
- **Frozen conclusions, live presentation** still holds. Findings are frozen, so
  a per-type series over them is recorded history. Correlated problems are
  recomputed at read time, so a trend over them would be *today's rule applied to
  old data* — a different and weaker claim. Trend the frozen rows.
- **A comparability guard generalises to a trend.** S-07 refuses to compare two
  runs of differing scope. A line through the same runs has the same defect, so
  the guard is a filter on trend points rather than a new idea.
- **Prefer the ratio the site defines to a score we weight.** Parity is
  `clean / total families`, both counted from the site's own declarations. Any
  weighted severity index would be the first number the product asserts rather
  than observes.

## Historical Context (from prior changes)

- `context/archive/2026-09-04-run-history-and-comparison/` — S-07. Its research
  and proof carry the comparability argument this slice inherits, and its
  `proof.md` records the real-run behaviour of the columns a trend would filter on.
- `context/archive/2026-08-31-page-identity-under-redirects/` — the 569 → 533
  page change, which is why the earliest yazaki runs are not on the same axis as
  the later ones.
- `context/archive/2026-09-01-seo-metadata-checks/` and
  `context/archive/2026-09-02-crawl-technical-checks/` — the 09-02 and 09-03
  jumps in the count series.
- `context/foundation/lessons.md` — rule 1 governs the score question directly:
  a weighted index would depend on our inference rather than the site's
  assertion, and so would be a claim about us.

## Related Research

- `context/archive/2026-09-04-run-history-and-comparison/research.md` — run
  storage, comparability, and why the diff is over frozen findings

## Open Questions

1. **Does S-12 ship without scores, or wait for S-06?** The counts half is
   deliverable now; the scores half is not deliverable at all. Recommended:
   ship counts, and say in the roadmap that FR-039 is partly met.
2. **Is the rule set recorded, and how?** The full `FINDING_TYPES` array in
   jsonb, or a version string bumped when the set changes. The array is
   self-describing and needs no discipline to maintain; a version needs someone
   to remember.
3. **What does a trend point require?** At minimum `crawlComplete` — an
   interrupted run is not a data point. Probably also equal scope, matching the
   comparison. Whether a rule-set difference excludes a point or just annotates
   the series is a design decision.
4. **Total, per-type, or parity ratio — which is the default view?** Per-type is
   the honest one but is 24 series; parity is one line but describes only the
   multilingual half of the product.
5. **Do pre-S-07 runs appear at all?** They can be plotted as raw counts, but
   nothing about them can be qualified. Showing them greyed with the reason, or
   omitting them, is the same choice the comparison already made for its refusal.
