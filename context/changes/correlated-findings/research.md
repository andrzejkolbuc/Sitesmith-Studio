---
date: 2026-09-03T20:32:14+02:00
researcher: Andrzej Kolbuc
git_commit: b01be52143e730f5623887287fa87b9c6641f2e4
branch: master
repository: Sitesmith-Studio
topic: "S-09 correlated-findings: what evidence do the 24 rules actually store, and what operationally counts as the same underlying cause?"
tags: [research, codebase, findings, correlation, variants, hreflang, evidence-schema]
status: complete
last_updated: 2026-09-03
last_updated_by: Andrzej Kolbuc
---

# Research: S-09 correlated-findings

**Date**: 2026-09-03T20:32:14+02:00
**Researcher**: Andrzej Kolbuc
**Git Commit**: `b01be52`
**Branch**: master
**Repository**: Sitesmith-Studio

## Research Question

How do the twenty-four existing rules store evidence — `detail` schemas, `pageId` conventions,
the site-wide `url: null` pattern — and what does that evidence support as an operational test
for "the same underlying cause"? FR-040 states the rule but not the test for it; the roadmap
assigns that decision to planning. This research is meant to establish what the data will bear
before the plan guesses.

## Summary

**FR-040's literal join key does not exist in the data.** The requirement says findings "produced
by different check types **on the same page**". Only nine of twenty-four rule types file against a
page at all; fourteen file against nothing and one against a family key. On run `29fa2fc7` — the
only real-site run we have — **all 67 findings have `pageId = NULL`**. A same-page correlation
would have produced exactly zero groups. The correlation FR-040 describes is real, but the axis it
names is the wrong one.

**The naive alternative is worse, and this is measurable.** `pagesInvolved()` already computes,
per finding, every URL it concerns. Correlating on "shares at least one involved URL", with
transitive closure, collapses **66 of 67 findings into a single group spanning all 533 pages**.
Three hub findings do it: `link_external_broken` reaches 503 URLs through its `linkedFrom` list,
`page_missing_from_sitemap` 452, `page_orphaned` 71. They bridge everything to everything. This is
the change brief's warning — *grouping by shared evidence is not grouping by shared cause* — with a
number on it.

**There is an axis that works, and the site asserts it itself.** Every finding's evidence separates
into two roles the current schema conflates: the **subject** (the URL that is wrong) and the
**origin** (the pages that emit it — `linkedFrom`, `declaredBy`, `affectedUrls`, the `urls` of a
duplicate set). Correlating on *the set of hreflang variant families the origin pages occupy*
reduces **67 findings to 7 explained problems**, with no threshold anywhere:

| findings | → | types folded together | joined by |
|---:|---|---|---|
| 28 | 1 | `variant_diverged`×8, `link_broken`×20 | origin is one variant family (2 pages) |
| 20 | 1 | `metadata_duplicated`×20 | origin occupies the same 6 families |
| 10 | 1 | `metadata_duplicated`×10 | origin occupies the same 5 families |
| 4 | 1 | `metadata_duplicated`×4 | origin occupies the same 2 families |
| 3 | 1 | `link_broken`×2, `link_external_broken`×1 | origin occupies the same 51 families |
| 1 | 1 | `page_missing_from_sitemap` | site-level; never correlated |
| 1 | 1 | `page_orphaned` | site-level; never correlated |

The headline group is the product's whole argument in one row: **twenty broken links and eight
diverged variants, two different check types, reported as one problem**, because the site's own
hreflang graph says the two pages emitting all twenty-eight are the same page in two languages.
No inference of ours is involved — which is precisely what `lessons.md` demands.

**One group in that table is probably a false correlation, and it is instructive.** The 3-finding
group merges two dead `/dev/` test pages with a dead partner link on `yazaki-group.com`. They share
an origin — the same 51-family site layout — but not a cause: an agency artefact left in a template
is not the same event as a third party deleting a page. A shared *layout* is a shared *location*.
That is the boundary the rule has to be narrowed at, and Open Questions proposes how.

**Nothing needs to be added to the crawl to build this.** `variantGroupKey` is already computed
from the hreflang graph and persisted per page (`src/server/db/schema.ts:285`), with an index on
`(runId, variantGroupKey)`. `pagesInvolved()` already exists and is tested. The missing pieces are a
role split on that mapping, and a decision about the layout case.

## Detailed Findings

### 1. The finding schema, and the three places identity lives

A finding is `{ type, url: string | null, detail: Record<string, unknown> }`
([findings.ts:79-86](src/server/crawl/findings.ts)), persisted with a nullable `pageId` resolved
from `url` at write time ([run.ts:246-254](src/server/crawl/run.ts)):

```ts
pageId: finding.url ? (pageIdByUrl.get(finding.url) ?? null) : null,
```

`url` is documented as "the page the finding is about; null for family-level findings", and the
`pageId` column as "null for findings about a group rather than a single page"
([schema.ts:343-344](src/server/db/schema.ts)). How the 24 types actually use it:

- **Nine file against a page** (`url: page.url`): `hreflang_target_failed`,
  `hreflang_target_unreached`, `no_hreflang`, `content_untranslated` (placeholder kind only),
  `metadata_missing`, `canonical_missing`, `canonical_conflicting`, `canonical_target_broken`,
  `noindex_present`.
- **One files against a family key** (`url: groupKey`): `missing_locale`.
- **Fourteen file against nothing** (`url: null`): `variant_diverged`,
  `hreflang_family_inconsistent`, `content_untranslated` (identical-to-siblings kind),
  `content_structure_differs`, `metadata_duplicated`, `content_duplicated`, `link_broken`,
  `certificate_problem`, `security_header_contradiction`, `sitemap_url_failed`,
  `page_missing_from_sitemap`, `robots_blocks_indexable`, `page_orphaned`,
  `link_external_broken`, `redirect_chain`.

This is not sloppiness — it is the rules already collapsing by cause one level down. `link_broken`
files one finding per dead *target* carrying every page that links to it, not one per linking page.
`metadata_duplicated` files one per duplicated *string* carrying every page publishing it. Filing
those against a page would name one arbitrary member of the set the finding exists to describe. The
comment on `pagesInvolved`'s `metadata_duplicated` case says so directly: it is filed against none
of them, and counting one of them would understate exactly the thing that makes it a problem
([summarise.ts:98-103](src/app/(app)/projects/[id]/summarise.ts)).

**Consequence for FR-040.** A `pageId`-based correlation can only see nine of twenty-four types, and
on run `29fa2fc7` it sees none of the six that fired:

```
page_id_null | page_id_set
          67 |           0
```

The requirement's wording predates the rules it now has to correlate.

### 2. `pagesInvolved()` is the join-key infrastructure, already built and tested

[summarise.ts:52-190](src/app/(app)/projects/[id]/summarise.ts) maps every finding type to the URLs
it concerns, exhaustively, with a per-type rationale comment and a `default` that falls back to
`finding.url` so a new type "never reports as affecting nothing". It exists because the results list
needed an honest page count next to each group heading
([run-panel.tsx:530-533](src/app/(app)/projects/[id]/run-panel.tsx)), and it is covered by
[summarise.test.ts](src/app/(app)/projects/[id]/summarise.test.ts) (521 lines).

It is the right foundation and the wrong granularity. It deliberately unions two different things:

```ts
// The dead URL and every page pointing at it. The linking pages are where
// the fix happens, so a count that named only the target would understate
// how much of the site has to be edited.
case "link_broken":
case "link_external_broken":
  return [...one(detail.target), ...strings(detail.linkedFrom)];
```

Correct for "how many pages does this touch". Fatal for correlation: the union makes a single dead
footer link adjacent to every page on the site.

### 3. What correlating on shared evidence actually does — measured

Applying `pagesInvolved` to run `29fa2fc7` and taking the transitive closure of "shares ≥1 URL":

```
findings: 67
groups by shared-URL: 2
  66 findings |  533 urls | variant_diverged×8, metadata_duplicated×34,
                            link_broken×22, page_missing_from_sitemap×1,
                            link_external_broken×1
   1 findings |   71 urls | page_orphaned×1
```

Reach per type explains it — the hubs are two to three orders of magnitude wider than everything
else:

| type | n | involved-URL reach (min–max) |
|---|---:|---|
| `link_external_broken` | 1 | 503–503 |
| `page_missing_from_sitemap` | 1 | 452–452 |
| `page_orphaned` | 1 | 71–71 |
| `link_broken` | 22 | 2–52 |
| `metadata_duplicated` | 34 | 2–6 |
| `variant_diverged` | 8 | 3–3 |

The one finding that stayed out is `page_orphaned`, and only by accident: its 71 URLs are the only
involved URLs in the run that are **not crawled pages** (they are sitemap entries nothing links to),
so they can never intersect anything page-derived. That is worth remembering — the sitemap/orphan
pair the change brief nominates as "the same story told twice" cannot be joined on URLs at all.

### 4. The role split: subject vs origin

Re-reading the 24 `detail` shapes, each carries at most two role-distinguishable URL sets.

**Subject — the thing that is wrong:**

| field | types |
|---|---|
| `target` | `link_broken`, `link_external_broken` |
| `brokenUrl` | `variant_diverged` |
| `url` | the nine page-filed types |
| `urls` | `metadata_duplicated`, `content_duplicated`, `page_missing_from_sitemap`, `page_orphaned`, `robots_blocks_indexable` |
| `from` / `hops` | `redirect_chain` |
| `entries[].normalised` | `sitemap_url_failed` |
| `origin` | `certificate_problem` (an origin host, not a page) |

**Origin — the pages that emit it, where an editor would go:**

| field | types |
|---|---|
| `linkedFrom` | `link_broken`, `link_external_broken`, `redirect_chain` |
| `declaredBy` | `variant_diverged`, `hreflang_target_failed`, `hreflang_target_unreached` |
| `affectedUrls` | `security_header_contradiction` |
| `memberUrls` | `missing_locale`, `hreflang_family_inconsistent`, `content_structure_differs` |
| `urls` | `metadata_duplicated`, `content_duplicated` (subject and origin coincide) |
| — none — | `page_missing_from_sitemap`, `page_orphaned`, `robots_blocks_indexable`, `sitemap_url_failed`, `certificate_problem` |

That last row is the useful one. Five types have **no page-level origin at all**: they are statements
about the corpus, made by reconciling the site's sitemap or robots.txt against the crawl. They are
already one-finding-per-cause. They should be excluded from correlation by construction rather than
by a size threshold — which also removes two of the three hubs that broke the naive approach.

### 5. The variant family is a site-asserted grouping, already persisted

`variantGroupKey` is derived from the hreflang graph, not from URL shape — the schema comment is
explicit that it is "derived from the hreflang graph rather than from any single URL, so the key is
stable regardless of which page the crawl reached first"
([schema.ts:281-285](src/server/db/schema.ts)). It is written per page during a run
([run.ts:209-215](src/server/crawl/run.ts)) and indexed on `(runId, variantGroupKey)`.

On run `29fa2fc7`: 533/533 pages carry a family key; 528 carry a locale. The distribution is

```
 members | families
       1 |       23
      10 |       51
```

— 510 pages in 51 ten-member families, 23 singletons. This is a heavily family-linked site, which is
why the axis pays so well here and why its limits need stating (see Open Questions).

Correlating on the *set of families the origin pages occupy* gives the 67 → 7 result in the Summary.
Two things make it defensible under `lessons.md`:

1. **The relationship is the site's own claim.** Two pages are siblings because the site's hreflang
   tags say so. We are not inferring from a locale-shaped path segment — the exact inference that
   produced one of the four false-positive classes already on the register.
2. **It degrades to silence, not to noise.** A page with no declared siblings is its own family. On a
   monolingual site every family is a singleton, so an identical family set means an identical origin
   set, and the rule only fires on findings emitted by literally the same pages. It goes quiet rather
   than guessing.

### 6. The headline group, in full

Twenty `link_broken` findings and eight `variant_diverged` findings, one cause. The mechanism is
visible in the evidence the rules already store.

`variant_diverged` names the family and the healthy members
(`detail.declaredBy` = the two pages that declared the sibling):

```json
{ "locale": "bg",
  "groupKey":   "https://www.yazaki-emea.com/bg/karieri/previous-career-pages/karieri-3",
  "brokenUrl":  "https://www.yazaki-emea.com/bg/karieri/previous-career-pages/karieri-3",
  "httpStatus": 404,
  "declaredBy": ["https://www.yazaki-emea.com/de/karriere/previous-career-pages/karriere-3",
                 "https://www.yazaki-emea.com/fr/carrieres/previous-career-pages/carrieres-3"] }
```

Each of the twenty `link_broken` findings carries a `linkedFrom` of length **1** — and every one of
those twenty referrers is one of those same two pages:

```
=== link_broken grouped by FAMILY SET OF ITS REFERRERS ===
  20 broken targets | referrer families=1  | key=…/bg/karieri/previous-career-pages/karieri-3
   2 broken targets | referrer families=51 | key=…/|…/about-us|…

=== do the 20 career referrers form one hreflang family? ===
  2 distinct referrer pages across 1 families
```

The defect itself: the language switcher on those two pages builds sibling URLs by swapping the
locale prefix while keeping the **source language's path slug** — emitting
`/bg/karriere/previous-career-pages/karriere-3` when Bulgarian's real path is `/bg/karieri/…`. Ten
locales × two source languages = twenty dead links; the eight `variant_diverged` findings are the
same fault seen from the other end. **One template bug, one fix, currently 28 list entries.**

Note what does *not* join them: the twenty dead targets are each their own singleton family (a 404
page declares no hreflang), so a subject-side family key correlates nothing. Only the origin side
carries the site's assertion. Grouping on the subject side would require noticing that the twenty
paths share `/previous-career-pages/` and differ by locale prefix — our inference, exactly the
class `lessons.md` rules out.

### 7. The candidates in the change brief, judged against the data

| brief's candidate | verdict |
|---|---|
| One dead URL, twenty-two findings (`previous-career-pages`) | **Confirmed and larger than stated** — 20 `link_broken` + 8 `variant_diverged` = 28, one origin family. The brief counted one type. |
| One footer link, 502 pages (`yazaki-group.com/global`) | **Already collapsed by its own rule**; correct precedent, and it needs no help from this slice. It is also the finding that most endangers the rule (see the layout case). |
| A test page in two navigation templates (`dev/*`) | **Confirmed** — 2 `link_broken` with *byte-identical* 51-page `linkedFrom` sets. Identical origin sets are an observation, not an inference. |
| Sitemap and orphans are the same story told twice | **Not joinable on this axis.** Both have empty page-level origins; `page_orphaned`'s 71 URLs are not crawled pages at all. Correlating them means asserting "the sitemap and the site disagree" — a claim about two rules' relationship, not about shared evidence. Recommend leaving it out of this slice. |
| 34 `metadata_duplicated` from a handful of CMS templates | **Confirmed, and it resolves to three, not "a handful."** 20 (title+description × 10 locales over the same 6 families), 10 (description × 10 locales over 5 families), 4 (2 locales × 2 fields over 2 families). |

Four of five hold. The fifth is the one that would have required inference.

## Code References

- `src/server/crawl/findings.ts:25-76` — `FINDING_TYPES`, all 24, each with the one-line claim it makes
- `src/server/crawl/findings.ts:79-86` — the `Finding` shape: `type`, nullable `url`, opaque `detail`
- `src/server/crawl/findings.ts:1403-1416` — `link_broken`: `target` + `confirmed` + `linkedFrom`, the clearest subject/origin split in the file
- `src/server/crawl/findings.ts:963-970` — `metadata_duplicated`: `field`, `language`, `value`, `urls`
- `src/server/crawl/findings.ts:2093-2110` — `redirect_chain`: `from`, `to`, `hops`, `linkedFrom`
- `src/server/db/schema.ts:325-360` — `findings` table; `pageId` nullable, `detail` jsonb, index on `(runId, type)`
- `src/server/db/schema.ts:262-311` — `pages` table; `locale`, `variantGroupKey`, `hreflangTargets`, index on `(runId, variantGroupKey)`
- `src/server/crawl/run.ts:209-215` — where `variantGroupKey` is written per page
- `src/server/crawl/run.ts:236-254` — where findings are persisted and `pageId` resolved
- `src/app/(app)/projects/[id]/summarise.ts:52-190` — `pagesInvolved`, the existing exhaustive type→URLs mapping
- `src/app/(app)/projects/[id]/summarise.ts:196-205` — `countPages`
- `src/app/(app)/projects/[id]/run-panel.tsx:511-545` — the current presentation: grouped by `type`, two counts per heading
- `src/server/api/routers/project.ts:128-148` — `project.findings`, ordered by `(type, id)`; the query a correlated view would replace or wrap
- `src/server/crawl/variants.ts:141-176` — `groupFamilies`, the hreflang-graph grouping the key comes from

## Architecture Insights

- **The rules already correlate; this slice raises the level, it does not introduce the idea.**
  `link_broken` collapses by dead target, `metadata_duplicated` by duplicated string,
  `link_external_broken` by external URL. The precedent for "one cause, one finding, evidence lists
  the rest" is established and tested. S-09 applies the same move one level up.
- **`detail` is deliberately opaque in the database and structured in exactly one place.**
  `pagesInvolved` is already the single point where per-type evidence structure is decoded, with a
  safe `default`. A correlation layer belongs beside it, not scattered into 24 call sites — and the
  existing three-place ritual for adding a finding type would become four.
- **Site-level findings must be excluded by construction, not by size.** Five types have no
  page-level origin. Excluding them because they are *wide* would be a threshold that scales with
  the defect it hunts — S-04's Phase 10 lesson exactly. Excluding them because they are *statements
  about the corpus* is structural and cannot go quiet.
- **The subject/origin distinction has a second payoff.** "How many pages does this touch"
  (`pagesInvolved`, existing) and "where do I go to fix it" (origin) are different questions the UI
  currently answers with one number. A correlated problem wants both.
- **Every rule declares whose claim it rests on** — the S-05 *Signal | Whose claim is it? | Oracle*
  table. This rule's answer: the claim is the site's hreflang graph; the oracle is that two pages
  the site calls translations of each other emitting the same defect is one edit, verifiable by
  opening them.

## Historical Context (from prior changes)

- `context/foundation/lessons.md` — "Trace every finding to the site's own assertion." Four
  false-positive classes so far, one of them *any two-letter path segment read as a locale*. It rules
  out the subject-side path-shape grouping that would otherwise be the obvious way to join the twenty
  broken career URLs, and it is what makes the origin-side hreflang key the only defensible one.
- `context/archive/2026-09-02-crawl-technical-checks/research.md:389-405` — "Suppression is the design
  discipline, not an afterthought"; "an expectation adjusted to match the output is just the output
  written twice." Both bite here: the 67→7 number is attractive enough to tune toward.
- `context/archive/2026-08-31-cross-variant-content-drift/` — the answer to a threshold was "not a
  threshold but a decomposition", and exact-digest matching was chosen because "exact match needs no
  threshold". The family-set key is the same move: set equality, not similarity.
- `context/archive/2026-09-01-seo-metadata-checks/` — the length threshold measured against the real
  client, found to fire on 5 of 12 with "none of them a defect a human would name", and dropped. The
  same test should be applied to whatever the layout case is narrowed to.
- `context/archive/2026-08-25-detection-rule-confidence/` — the oracle discipline and
  `site-shapes.test.ts`; confidence is a tiering convention, not a data model. Relevant because a
  "correlation confidence score" is the tempting wrong answer the change brief already names.
- **No prior change has touched correlation.** A case-insensitive search for `correlat` across
  `context/` matches only this change's own `change.md`. This is new ground rather than a resumption.

## Related Research

- `context/archive/2026-09-02-crawl-technical-checks/research.md` — the rules architecture, the
  site-level facts channel into `DetectOptions`, and the phasing precedent
- `context/archive/2026-09-01-seo-metadata-checks/research.md` — the `normaliseUrl` comparison trap
  (relevant: family keys and `linkedFrom` URLs must be compared in the same normalised spelling; the
  orphan bug fixed in S-04 Phase 10 was exactly a trailing-slash mismatch), and the three-place ritual
- `context/archive/2026-08-31-cross-variant-content-drift/research.md` — decomposition over thresholds

## Open Questions

1. **The layout case — is a shared template a shared cause?** The 3-finding group merges two dead
   `/dev/` pages with a dead partner link, on the strength of a 51-family shared origin. Two dead
   test pages left by an agency are one cause; a third party deleting `yazaki-group.com/global` is
   another. Three candidate narrowings, in ascending order of inference:
   - **(a) Same type only, above some origin breadth.** Groups whose origin spans the whole site
     correlate only same-type findings. Splits the group 2+1 correctly here. Cheap, but "some
     breadth" is a threshold, and this project has now been bitten by one.
   - **(b) Internal and external never correlate.** `link_broken` and `link_external_broken` are
     different events by definition — one is the site's own URL rot, the other is somebody else's
     site. Splits it 2+1, needs no number, and is defensible as a statement rather than a tuning.
   - **(c) Require an identical origin *set*, not an identical family set, once the family set is
     larger than the finding's own subject count.** Most conservative; also splits it 2+1 (the two
     dev findings have byte-identical 51-page `linkedFrom`; the external one does not).

   **Recommendation: (b), possibly with (c).** Both are structural. (a) is the shape of mistake the
   S-04 lesson names. — Owner: user, during planning.

2. **What does a correlated problem say, in words?** The rule has to *explain*, not just group —
   FR-040's own resolution note says the product "infers that a slow page, a shifted layout and a
   failed asset constitute one broken deploy, **and says so**". "28 findings, same variant family" is
   a grouping. "Two pages in one language family emit twenty dead language-switcher links" is an
   explanation. The second requires naming the *shape* of the correlation, of which the data supports
   at most three: *one family emits it*, *the same family set exhibits it*, *the same pages emit it*.
   Whether three named shapes are enough, or whether that is the wrong vocabulary entirely, is a
   planning decision. — Owner: user.

3. **Where does correlation run — at detection, at read, or at both?** Detection-time means a
   `correlations` table and a migration, correlations frozen with the run, and comparability across
   runs for S-07/S-14. Read-time means no schema change, free iteration on the rule, and
   recomputation on every view (67 findings is nothing; a far larger site might not be). S-14 depends
   on this output being "tens of items rather than hundreds" and cached against the run, which argues
   for persistence eventually — but not necessarily in this slice. — Owner: user.

4. **What does this slice deliver on a monolingual site?** The axis is the hreflang graph. Yazaki has
   51 ten-member families over 533 pages, which is why 67→7. A single-language client gets 533
   singleton families, and the rule reduces to "identical origin sets only" — still correct, far less
   valuable. FR-040 is a must-have and US-01 is explicitly the multilingual story, so this may be
   entirely acceptable; it should be a stated limit rather than a discovered one. If it is not
   acceptable, the second axis would have to be something other than hreflang, and nothing else in
   the crawl is site-asserted in the same way. — Owner: user.

5. **Does correlation change what is displayed, or only how it is summarised?** The current view
   groups by `type` with a finding count and a page count
   ([run-panel.tsx:511-545](src/app/(app)/projects/[id]/run-panel.tsx)). A correlated view competes
   with that grouping rather than nesting inside it — a problem spanning `link_broken` and
   `variant_diverged` has no home under a type heading. Whether S-09 replaces the type grouping,
   sits above it, or ships behind the existing one is a scope decision that materially changes the
   size of the slice. — Owner: user.

6. **Verification: what is the oracle?** The rule's correctness cannot be checked by counting groups
   — 67→7 is only good if the 7 are right. The available oracle is the yazaki run plus manual
   confirmation of each group ("would one edit fix all of these?"), which held for 6 of 7 and failed
   for the layout case. `site-shapes.test.ts` is where synthetic shapes go, and expectations must be
   written before running the rule against them. — Owner: implementation.
