---
change_id: seo-metadata-checks
title: "Title, meta description, canonical and noindex checks"
status: implementing
created: 2026-09-01
updated: 2026-09-02
archived_at: null
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
