---
change_id: seo-metadata-checks
title: "Title, meta description, canonical and noindex checks"
status: archived
created: 2026-09-01
updated: 2026-09-02
archived_at: 2026-09-02T20:47:48Z
roadmap_ref: S-05
prd_refs: [FR-021, FR-022, FR-023]
---

## Notes

Roadmap item **S-05**. Its risk note calls it the best effort-to-value ratio on
the board: small, self-contained, and covering the regression a client site can
least afford — a `noindex` shipped to production, which quietly removes pages
from search and is invisible until traffic drops.

Three requirements:

- **FR-021** — missing, duplicated, or out-of-range titles and meta descriptions
- **FR-022** — canonical problems: missing, self-conflicting, or pointing at a
  non-canonical URL
- **FR-023** — pages carrying a `noindex` directive in production

### A correction to carry into planning

The roadmap says this "reads from crawled markup S-01 already has". **It does
not.** S-03 established that the crawl reads each page's HTML, extracts hreflang
and links, and discards the rest; `CrawledPage` holds no title, no meta, no
canonical. This is extraction work, not row-reading, and the estimate should say
so.

The good news is that the path is well worn. `src/server/crawl/content.ts` is a
pure `(html, isHtml) → summary` extractor sitting beside `extractHreflang` and
`extractLinks` over the same in-memory body, and it has been through
implementation review twice. It is the template.

### What is likely to be harder than it looks

- **`noindex` is not only a meta tag.** It is equally valid in an `X-Robots-Tag`
  response header, and `CrawledPage` keeps no headers at all — `crawler.ts:247`
  reads `content-type` and drops the rest. Checking only the markup would miss
  the half of real cases served at the CDN or framework layer, and would report
  a clean page as clean while it is deindexed.
- **"Out-of-range" needs a defended number.** Title and description length
  guidance is pixel-based and shifts with search-engine rendering. This is the
  same shape as the word-count threshold deferred out of S-03, and it deserves
  the same scepticism: a rule that fires on every slightly-long title is the
  noise failure the PRD calls fatal.
- **"Duplicated" needs a scope.** Across the whole site, or within a language?
  Two locale variants legitimately share a canonical; two English pages sharing
  a title do not. The variant families S-02 built are probably the unit.
- **Canonical interacts with work already done.** `normaliseUrl` drops query
  strings and trailing slashes; a canonical pointing at a URL that differs only
  in those respects is not a defect, and treating it as one would repeat the
  page-identity false positive under a new name.

### Carried forward

`context/foundation/lessons.md` — every finding must trace to something the site
itself asserted. A `noindex` tag is about as direct an assertion as exists; a
length threshold is entirely our inference. Expect the same staging that worked
for S-03: ship the signals with an external oracle first.

## Phase 5 results — yazaki-emea.com, 2026-09-02

Run `8a2e9cc9`, same project and pacing as every previous run: two requests at a
time, 500ms apart. **533 pages in 326s**, finishing cleanly — the same page count
as the runs of 2026-08-31 and 2026-09-01, and inside their 305–412s band.

| | 2026-08-31 | 2026-09-01 | 2026-09-02 |
|---|---|---|---|
| Pages | 533 | 533 | 533 |
| `variant_diverged` | 8 | 9 | 8 |
| `content_untranslated` | — | 0 | 0 |
| `content_structure_differs` | — | 0 | 0 |
| `metadata_duplicated` | — | — | **34** |
| `metadata_missing` | — | — | 0 |
| `canonical_missing` | — | — | 0 |
| `canonical_conflicting` | — | — | 0 |
| `canonical_target_broken` | — | — | 0 |
| `noindex_present` | — | — | 0 |

### The duplicate rule found the defect, and it is larger than the sample showed

Research saw the legal page serving the homepage's title and description in
`pt`, `ro` and `de`. The crawl shows the same defect in **every language the
site publishes**: 10 languages × (homepage + 5 legal pages) sharing one title
*and* one description. Spot-checked live and confirmed byte for byte —
`/imprint` and `/s172-statement` both serve
`Powering the Future of Mobility Since 1929 | Yazaki EMEA`, and
`/de/rechtliches/impressum` serves the German homepage's pair.

Two clusters the sample never reached:

- **Press releases, 10 languages × 5 articles.** Five distinct articles, five
  distinct titles, and one shared description — the text belonging to a *sixth*
  article about the Prahova Companies Awards. Verified live on the CES 2026
  release, whose description is about the awards gala. This is a real defect and
  a genuinely new find; nothing in the research predicted it.
- **`/de/karriere` and `/fr/carrieres`**, each sharing title and description with
  a page under `previous-career-pages/` — an archived page still live and
  competing with the current one.

34 findings covering **114 of 533 pages**, 12 on titles and 22 on descriptions.
Every one traces to a string the site published on more than one URL, which is
the oracle `lessons.md` asks for. **No false positive was found.**

### The five silent rules were silent, not blind

A 6-page live re-fetch spread across the site shows the extractor had full
visibility on every channel the silent rules read:

- **Canonical present and self-referential on 6 of 6**, resolved from a relative
  href. So `canonical_missing` had a site that uses them and no page lacking
  one; `canonical_conflicting` saw exactly one canonical per page; and
  `canonical_target_broken` saw every canonical pointing at the page itself.
- **Title and description present on 6 of 6** — `metadata_missing` was offered
  no page to report.
- **Both robots channels present on 6 of 6**, `index,follow` in markup and
  `index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1`
  in the header. `noindex_present` correctly said nothing.

That last value is worth recording. The header carries three colon-bearing
directives, and `parseRobotsHeader` keeps them as directives rather than reading
`max-image-preview` as a crawler scope — the reason its guard is a closed list
of directive names rather than of crawler names. Guarded the other way round,
this run would have misparsed the header on all 533 pages.

### What this does and does not establish

One rule of the six found a real, previously-unknown defect at scale on a site
nobody built for it, and no rule produced a finding a human would call wrong.
The other five were correct to stay quiet, and the re-fetch shows they could
see. It is **not** evidence that the canonical or `noindex` rules find anything
in the wild — no true positive has been observed for them — and that
distinction should not be blurred when S-05 is judged. This client's site is
simply well configured on those axes.
