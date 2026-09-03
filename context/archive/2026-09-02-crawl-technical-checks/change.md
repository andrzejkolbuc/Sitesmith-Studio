---
change_id: crawl-technical-checks
title: "Broken links, sitemap and robots reconciliation, orphans, duplicates and TLS checks"
status: archived
created: 2026-09-02
updated: 2026-09-03
archived_at: 2026-09-03T17:25:07Z
---

## Notes

Roadmap item **S-04**, the other independent branch off S-01 in Stream B (S-05
closed 2026-09-02). Six must-have requirements:

- **FR-016** — broken internal and external links; redirect chains or loops
- **FR-017** — sitemap↔crawl reconciliation: sitemap URLs that fail, live pages
  absent from the sitemap
- **FR-018** — robots.txt rules blocking pages that were intended to be indexable
- **FR-019** — orphan pages: reachable via sitemap but linked from nowhere
- **FR-020** — duplicate titles and near-identical content across URLs
- **FR-030** — security header and certificate problems, including expiry

### Two things to settle before this can be planned

- **Scope.** Six requirements is the largest single roadmap item on the board,
  and they do not share an implementation: link-graph work (FR-016, FR-019),
  a new sitemap/robots fetch-and-parse channel (FR-017, FR-018), a content
  comparison (FR-020), and a transport-layer probe that has nothing to do with
  page markup at all (FR-030). Phasing, or splitting, is a planning decision
  that should be made explicitly rather than by drift.
- **Overlap with work already shipped.** FR-020's "duplicate titles" is the rule
  S-05 already built and validated (`metadata_duplicated`, 34 findings on
  yazaki-emea.com); "near-identical content across URLs" is adjacent to S-03's
  drift comparison but scoped across URLs rather than across variants. Research
  must establish what is genuinely new here before anything is rebuilt.

### The roadmap's own objection, carried forward

S-04's risk note records that the PRD's Socratic pass called these checks a
rebuild of a mature existing tool, and that they were kept must-have with the
objection acknowledged and overruled. That does not change the scope, but it
does set the bar: the value has to come from these findings sitting beside the
multilingual ones in one run, not from the checks themselves.

`context/foundation/lessons.md` still applies — every finding must trace to
something the site itself asserted. A 404 and an expired certificate are direct
assertions; "near-identical" and "intended to be indexable" are inferences and
will need the same defended-threshold treatment S-03 and S-05 both needed.

## Phase 10 results — yazaki-emea.com, 2026-09-03

Run `29fa2fc7`, same project and pacing as every previous run: two requests at a
time, 500ms apart. **533 pages in 449s**, finishing cleanly — the same page count
as the runs of 2026-08-31, 2026-09-01 and 2026-09-02.

449s is 37s above the top of the 305–412s band, and the allowance is stated
rather than waved at: this run makes requests the earlier ones did not. One
robots.txt, one sitemap index and its three children, an external sweep capped at
one request per crawled page with a 500ms per-host delay, re-verification of
failures, and every redirect hop now walked and paced by us instead of followed
invisibly by the runtime. 9% over the band for five new fetch channels is the
cost this slice was expected to add.

| | 2026-08-31 | 2026-09-01 | 2026-09-02 | 2026-09-03 |
|---|---|---|---|---|
| Pages | 533 | 533 | 533 | 533 |
| `variant_diverged` | 8 | 9 | 8 | 8 |
| `content_untranslated` | — | 0 | 0 | 0 |
| `content_structure_differs` | — | 0 | 0 | 0 |
| `metadata_duplicated` | — | — | **34** | **34** |
| `metadata_missing` | — | — | 0 | 0 |
| `canonical_missing` | — | — | 0 | 0 |
| `canonical_conflicting` | — | — | 0 | 0 |
| `canonical_target_broken` | — | — | 0 | 0 |
| `noindex_present` | — | — | 0 | 0 |
| `content_duplicated` | — | — | — | 0 |
| `link_broken` | — | — | — | **22** |
| `certificate_problem` | — | — | — | 0 |
| `security_header_contradiction` | — | — | — | 0 |
| `sitemap_url_failed` | — | — | — | 0 |
| `page_missing_from_sitemap` | — | — | — | **1** (452 URLs) |
| `robots_blocks_indexable` | — | — | — | 0 |
| `page_orphaned` | — | — | — | **1** (71 URLs) |
| `link_external_broken` | — | — | — | **1** |
| `redirect_chain` | — | — | — | 0 |
| Duration | 305s | 412s | 326s | 449s |

`—` means the rule did not exist for that run. The four hreflang rules and
`missing_locale` have never been tabulated and fired nothing here either; of the
fourteen rules shipped before this slice, only `variant_diverged` and
`metadata_duplicated` produced anything, both unchanged.

**67 findings in total, 3 of them from this slice's rules** — 22 broken links, one
broken external link, and two site-wide findings covering 452 and 71 URLs. Ten new
rules have not swamped the fourteen existing ones.

### The proof caught a rule that was wrong, which is what it is for

The first run of the day, `c80873b4`, was identical except that `page_orphaned`
reported **nothing**. That silence was false. 71 URLs the sitemap submits are live
and linked from nowhere: `/news-press` lists its seven most recent articles while
roughly sixty more remain published and submitted, plus
`/capabilities/monozukuri-ic-test-bed`.

The cause was the coverage gate added the day before, during Phase 9, to stop a
leaf start URL inventing orphans in the browser suite: it required half the
sitemap to have been crawled. This sitemap is 41% crawled **precisely because so
much of it is orphaned**, so the rule went quiet exactly when it mattered — a
threshold that fails in proportion to the defect it looks for.

It is replaced by a per-URL test that needs no number. A URL is called an orphan
only when the crawl recorded a page that would be expected to link to it: its
section index, or any ancestor up to the site root. "We looked at `/news-press`
and it does not point at this article" is evidence; "we looked at one unrelated
page" is not. The leaf-start case stays silent because it recorded neither the
section nor the root, and this site's news articles are reported because their
index was crawled and omits them.

Phase 10 was specified as "no code". This is the exception, and it is the reason
the phase exists: a rule that reported nothing on a site with 71 orphans would
have shipped.

### Every new finding, judged by hand

**`link_broken` — 22 findings, all true.** Every one of the 22 targets was
re-requested live and returned 404, and the linking pages were re-fetched and do
carry the hrefs. Two clusters:

- **`/de/dev/sunzinet-test/test-page-de` and `/fr/dev/test-page`**, each linked
  from 51 pages — an agency test page left in a navigation template, in two
  languages.
- **20 language-switcher links under `previous-career-pages/`.** The pages doing
  the linking are live; the locale siblings they offer do not exist. A reader
  switching language on an archived careers page gets a 404 in ten languages.

**`link_external_broken` — 1 finding, true.** `https://www.yazaki-group.com/global`
returns 404 and is linked from **502 of 533 pages** — the parent-company link in
the global footer. Rule 23 reports only true absence (404/410), and this is one.

**`page_missing_from_sitemap` — 1 finding, 452 URLs, true.** The sitemap carries
121 entries; the crawl recorded 533 live pages. Whole locale trees — `/bg`, `/hr`,
`/ua` and the rest — are absent from a sitemap that lists the English pages.

**`page_orphaned` — 1 finding, 71 URLs, true.** Eight sampled at random all return
200 live, and `/news-press` links only its seven most recent articles, none of
which are in the set. One nuance worth recording: `/capabilities/monozukuri-ic-test-bed`
appears in the `/capabilities` page's Nuxt hydration payload but in **no anchor**
— zero `href`s point at it. A link-following crawler cannot reach it, which is
what FR-019 asks about, so the finding stands as written.

### The six silent rules were silent, not blind

Each verified against the live site rather than assumed:

- **`certificate_problem`** — Let's Encrypt certificate, `CN=www.yazaki-emea.com`,
  valid to 2026-10-07: **34 days remaining**, four days outside the 30-day renewal
  window the rule uses. The rule saw a certificate and judged it fine; it was not
  looking at nothing.
- **`security_header_contradiction`** — `Strict-Transport-Security`,
  `Content-Security-Policy`, `X-Content-Type-Options` and `Referrer-Policy`
  present and well-formed on **6 of 6** pages re-fetched across locales and
  sections. Nothing malformed, nothing published on some pages and missing on
  others.
- **`robots_blocks_indexable`** — robots.txt disallows `/form-builder/` and `/*?`
  in each of ten locales, and blocks Bytespider entirely. **Zero** sitemap entries
  match any disallowed pattern, so the site does not contradict itself here.
- **`sitemap_url_failed`** — every sitemap entry the crawl recorded returned 200,
  and three of the entries it never reached were re-requested live and also
  returned 200. The rule reports recorded failures and never infers failure from
  absence, which is what kept the 71 orphans out of this finding and in the right
  one.
- **`redirect_chain`** — the site's redirects are single hops: the apex to `www`
  and http to https, both 301, both one step. One hop is ordinary and not a
  finding; there was no chain to report and no loop.
- **`content_duplicated`** — no two of the 533 pages shared a content digest.
  Distinct from `metadata_duplicated`'s 34: the site publishes one title and
  description across many pages while the bodies below them differ, which is
  exactly the pair of rules FR-020 asks for.

**No false positive was found in any of the ten new rules.** One false *negative*
was found, in `page_orphaned`, and fixed before this run.
