---
date: 2026-09-05T18:19:39Z
researcher: Claude Opus 5
git_commit: 4498737
branch: master
repository: Sitesmith-Studio
topic: "Browser-observed checks (S-06): console errors, sampled performance, image weight"
tags: [research, codebase, crawl, rendering, performance, images, run-duration]
status: complete
last_updated: 2026-09-05
last_updated_by: Claude Opus 5
---

# Research: Browser-observed checks (S-06)

**Date**: 2026-09-05T18:19:39Z
**Researcher**: Claude Opus 5
**Git Commit**: `4498737`
**Branch**: master
**Repository**: Sitesmith-Studio

## Research Question

What does S-06 actually require, what does the codebase already have, and does
adding page rendering to a run break the run-duration property S-01 measured?

## Summary

**The slice is two slices wearing one coat.** FR-029 (image weight and
optimisation) needs no browser at all — everything it asks for is either in HTML
the crawl already fetches and throws away, or in a response header obtainable by
a HEAD sweep on the pattern `external.ts` already established. FR-015 (console
errors) and FR-028 (Core Web Vitals) need a real browser, which is a runtime
dependency, a container-image decision, and a multiplication of run duration.
They should be sequenced apart.

**The answer to the open unknown is yes — rendering does break run duration,
unless the sample is capped by an absolute number.** Measured on the real yazaki
project: 533 pages crawl in ~320s, which is pacing-dominated (~0.6s per page at
concurrency 2 / 500ms delay). A browser render that settles enough to report Core
Web Vitals costs 5–15s and is *not* pacing-bound. The naive reading of FR-028's
sample — one page per template per language variant — computes to **143 renders**
on yazaki, or 12–36 minutes on top of a 5-minute crawl. Any formula of the shape
*templates x locales* multiplies, and the multiplier is whatever the site happens
to publish.

**FR-028's "page template" is not a thing this product can observe**, and the
obvious proxy fails hardest on exactly the sites this product exists for. The
first URL path segment is *translated* on a multilingual site: yazaki publishes
`products`, `produkte`, `produits`, `capabilitati` for one concept, giving **113
distinct "sections" for roughly ten real ones**. Grouping by `variantGroupKey`
does not help either — a family is the same page across locales, so family x
locale is approximately the page itself (74 families over 533 pages ≈ 7.2 per
family ≈ the locale count). Whatever sample rule ships has to be named to the
reader rather than claimed as template coverage.

**Two requirements will be only partly met, and should be recorded that way** —
the discipline S-12 just set with FR-039. FR-015 says console errors are captured
on *each* page; only rendered pages can produce them, and rendering each page is
the cost the PRD already rejected under FR-028. FR-028 asks for "standard page
performance scores" alongside Core Web Vitals; a 0–100 composite is an index this
product would be asserting, which is the thing S-12 refused to invent and what
`lessons.md` rule 1 forbids.

## Detailed Findings

### The three requirements, read exactly

- **FR-015** ([prd.md:202](context/foundation/prd.md)) — "The product captures
  JavaScript console errors encountered on each page." Must-have. Note *each
  page*.
- **FR-028** ([prd.md:247](context/foundation/prd.md)) — "Core Web Vitals and
  standard page performance scores for a representative sample of pages - one per
  page template per language variant - rather than for every crawled URL."
  Must-have. The PRD's own Socrates note records why: measuring performance page
  by page takes tens of seconds each, and across 1,200 URLs that is hours per run,
  which directly destroys the primary success criterion.
- **FR-029** ([prd.md:256](context/foundation/prd.md)) — "image weight and
  optimization problems - oversized images, missing modern formats, missing
  dimensions." Must-have.

FR-015 and FR-028 contradict each other on cost, and the PRD resolved the
contradiction for FR-028 only.

### FR-029 needs no browser

Three sub-questions, three sources, none of them a rendering engine:

| Problem | Where the answer is | Cost |
| --- | --- | --- |
| Missing dimensions | `img` elements without `width`/`height` — in HTML the crawl already fetches | zero requests |
| Missing modern formats | the image URL's extension or `Content-Type`, and whether a `picture`/`source type` offers one | zero or one HEAD |
| Oversized images | `Content-Length` on a HEAD request | one HEAD per image |

The crawl currently extracts only anchor hrefs
([crawler.ts:322-335](src/server/crawl/crawler.ts)) — no images, no `srcset`, no
`picture`. So FR-029 needs one new extractor producing a fixed-size per-page image
summary, plus a bounded sweep.

**Every one of those facts is the site's own assertion** — its markup, its
headers — which is what `lessons.md` rule 1 requires. An "oversized" threshold is
ours and must be defended or expressed as a bare number rather than a verdict.

### `external.ts` is the sweep pattern to copy

[external.ts:1-70](src/server/crawl/external.ts) is the product's existing answer
to "make many extra requests after the crawl without wrecking anything":

- it **shares the crawl's pacer** rather than keeping its own, so the total rate
  stays what the operator configured;
- it carries a **per-host delay**, a **request ceiling derived from the pages
  crawled** (a sweep can at worst double the run — a bound an operator can reason
  about), and a **failure budget of its own** so third-party failure cannot abort
  the client's crawl;
- it reports `complete: boolean`, and the comment states the rule that matters:
  *a rule must stay silent about an incomplete sweep — an unchecked link is not a
  broken one.*

An image sweep is the same shape and should inherit all four properties. A render
pass needs the `complete` discipline too: an unmeasured page is not a fast one.

### The sampling problem, measured on real data

From the dev database, yazaki's most recent 533-page run:

- **533 pages, 74 variant families, 10 distinct discovered locales**
- **113 distinct first-path-segments** — because the segments are translated:
  `products` / `produkte` / `produits` / `capabilitati`, `about-us` / `ueber-uns`
  / `carrieres`, `contact-us` / `kontakt`
- **143 distinct (locale, section) pairs** — the naive sample is 27% of the site
- path depth histogram: `0:10  1:105  2:259  3:159`

So:

- **section x locale → 143 renders.** Fails.
- **family x locale → ~533.** A family *is* the cross-locale grouping; multiplying
  it by locale returns the page. Fails.
- **family alone → 74**, but then only one locale per family is measured, and
  FR-028 explicitly says per language variant.

**The one lever that actually bounds this is the project's declared locales.**
yazaki's project row declares `locales: ["en","de"]` while the crawl discovered
ten. The product already reasons from declared locales everywhere else —
`expectedLocales` feeds the detection rules via `detectMissingVariants`
([run.ts](src/server/crawl/run.ts)) — so sampling per *declared* locale is the
codebase's own convention, and it is bounded by configuration the operator
controls rather than by what the site happens to publish. For yazaki that is 2,
not 10.

Even so, a formula alone is not enough: two declared locales x ten sections is
still twenty renders. **An absolute cap is required**, and what the cap sampled
has to be stated to the reader.

### Run-duration arithmetic

| Measured | Value |
| --- | --- |
| yazaki crawl, 533 pages | 305–449s (median ~322s) |
| per page | ~0.6s, pacing-dominated (concurrency 2, 500ms delay) |
| Tecalliance crawl, 2 pages | ~7s |

A browser render that settles enough to report LCP/CLS is 5–15s and is bound by
the page, not by our pacer — the crawl's politeness knobs do not make it cheaper.

| Sample size | Added time | Effect on a yazaki run |
| --- | --- | --- |
| 10 renders | 50–150s | +15–45% |
| 30 renders | 2.5–7.5 min | roughly doubles it |
| 143 renders (naive) | 12–36 min | 3–7x |

**The answer to the roadmap's open unknown**: rendering breaks the run-duration
property at any sample defined by a multiplicative formula, and preserves it at a
small absolute cap. There is no run-duration *target* to test against — the PRD
declined every numeric threshold ([prd.md:344-348](context/foundation/prd.md)) —
so "breaks it" here means "multiplies the only measured baseline we have".

### Do not invent a performance score

FR-028's "standard page performance scores" most naturally means Lighthouse. The
PRD's own note prices it at 10–30s per page, and shape-notes records it as Open
Question 6, carried into the PRD unresolved
([shape-notes.md:560-562](context/foundation/shape-notes.md)):

> Is full-scope run time compatible with a go-live gate at all? Crawling up to
> 1,200 URLs, capturing a snapshot per page, and sampling Lighthouse may be
> structurally incompatible with a check the user runs casually before every
> launch.

Two options: add Lighthouse (a second heavy dependency and 10–30s per sampled
page), or report the Core Web Vitals themselves and no composite. The second is
consistent with the product's established position — S-12 refused to invent a
quality score on the grounds that the counts are observations while a score would
be an assertion, and `lessons.md` rule 1 says a finding must trace to the site's
own assertion. A measured LCP is the site's behaviour; a 0–100 grade is our
opinion of it.

### Deployment consequence

`@playwright/test` is a **devDependency** ([package.json](package.json)), present
only for the e2e suite. Using a browser at run time makes `playwright` (or
`playwright-core` plus a browser) a **runtime dependency**, and the container must
then ship browser binaries — several hundred megabytes and a set of system
libraries.

**F-02 `container-deploy-skeleton` is `ready` and unbuilt**
([roadmap.md](context/foundation/roadmap.md)). S-06 therefore constrains F-02's
shape before F-02 has been planned. This belongs in the plan rather than being
discovered during deployment.

### Storage

`pages` ([schema.ts:311-360](src/server/db/schema.ts)) carries url, httpStatus,
locale, variantGroupKey, hreflangTargets, fetchError — no room for per-page
observations, and a `uniqueIndex(runId, url)` already enforces one row per page
per run. Per-page measurements need either new nullable columns on `pages` (null
meaning *not measured*, exactly as `crawlComplete` and `ruleSet` use null for *not
recorded*) or a separate table keyed by page.

`findings.detail` is `Record<string, unknown>` and already carries arbitrary
evidence, so the findings side needs no schema change.

### Rule-set bookkeeping — expected, not a defect

New finding types change `Object.values(FINDING_TYPES)`, which S-12 records into
`runs.ruleSet` ([run.ts](src/server/crawl/run.ts)). The first comparison spanning
this slice's deployment will therefore refuse with `rules_changed` rather than
reporting the new findings as the client's site breaking. **That is the guard
working.** It is also the first live exercise of S-12's Phase 2, which has only
ever run against fixtures, and is worth confirming on a real project.

## Code References

- `src/server/crawl/crawler.ts:322-335` — `extractLinks`; anchors only, no images
- `src/server/crawl/crawler.ts:38-62` — `CrawlOptions`, including the `onPage` hook a second pass could reuse
- `src/server/crawl/crawler.ts:64-175` — `CrawledPage`; note the fixed-size constraint, held for every page of a crawl that can reach two thousand
- `src/server/crawl/external.ts:1-70` — the bounded-sweep pattern: shared pacer, per-host delay, derived ceiling, own failure budget, `complete` flag
- `src/server/crawl/content.ts:1-80` — `ContentSummary`; the precedent for reducing a page to fixed-size facts, and its explicit refusal to add a DOM parser
- `src/server/db/schema.ts:311-360` — `pages`, with `uniqueIndex(runId, url)`
- `src/server/crawl/run.ts` — where a second pass would slot, beside the existing external sweep and before `detectMissingVariants`

## Architecture Insights

- **Fixed-size per page is a hard constraint, stated twice.** Both `CrawledPage`
  and `ContentSummary` carry comments explaining that anything held per page is
  multiplied by a two-thousand-page ceiling. Console errors are unbounded text by
  nature and must be capped at capture — a count plus the first few messages,
  truncated — never stored whole.
- **"Not measured" must be representable.** Every recent slice has needed a null
  meaning *we did not observe this*: `crawlComplete`, `scope`, `ruleSet`. A sampled
  measurement needs the same, for the same reason — an unmeasured page is not a
  page with good vitals.
- **The product refuses rather than guesses.** `comparability` refuses; the
  external sweep goes silent when incomplete; the parity grid renders
  "not expected" as nothing. A render pass covering part of the site must say what
  it covered.
- **No composite scores anywhere.** Counts, measurements, glyphs — never an index.

## Historical Context (from prior changes)

- `context/archive/2026-09-04-quality-trend-history/` — set the precedent for
  recording a requirement as *partly met* rather than silently done, and for
  refusing to invent a score. FR-039's scores half is waiting on this slice.
- `context/archive/2026-09-02-crawl-technical-checks/plan.md:918-945` — the last
  slice to touch the browser suite; records that Playwright's per-test timeout is
  thirty seconds, which is shorter than some renders will want.
- `context/archive/2026-08-25-politeness-under-stress/` — the politeness
  guarantees any new request-making pass inherits.
- `context/foundation/shape-notes.md:560-562` — Open Question 6, the exact risk
  this slice makes real, carried into the PRD unresolved by user decision.

## Related Research

- `context/archive/2026-09-04-quality-trend-history/research.md` — established
  that FR-039's "scores" are this slice's Core Web Vitals, and that S-06 is the
  unrecorded prerequisite for the remainder of FR-039.

## Open Questions

1. **What is the sample, said in one sentence a client would accept?** It must be
   nameable ("the entry page and the two most-linked pages in each declared
   language"), bounded by an absolute cap, and honest that it is not template
   coverage.
2. **Lighthouse, or Core Web Vitals alone?** Recommendation: vitals alone, with
   FR-028 recorded as partly met on the "standard performance scores" clause —
   consistent with S-12 and `lessons.md` rule 1. Owner: user.
3. **Does FR-015 get re-scoped to the rendered sample?** As written it cannot be
   met at a cost the primary criterion tolerates. Recommendation: scope it to
   rendered pages and record it partly met. Owner: user.
4. **Does the browser ship in the same container as the app, or a separate
   worker?** Bears directly on F-02, which is unbuilt. A separate worker also
   solves the "one hanging render stalls the run" problem the crawl solved with
   per-request timeouts.
5. **What counts as an oversized image?** A byte threshold is ours. Reporting the
   measured weight and the rendered dimensions, and letting the number speak, is
   the alternative that asserts nothing.
