---
date: 2026-08-31T22:23:28+0200
researcher: Andrzej Kolbuc
git_commit: 1bc0b25fb217b52641de350291f08d7e399cf859
branch: master
repository: Sitesmith-Studio
topic: "What cross-variant content drift (S-03) needs, and what already exists"
tags: [research, codebase, crawler, findings, content-drift, s-03, fr-027]
status: complete
last_updated: 2026-08-31
last_updated_by: Andrzej Kolbuc
---

# Research: Cross-variant content drift (S-03)

**Date**: 2026-08-31T22:23:28+0200
**Researcher**: Andrzej Kolbuc
**Git Commit**: `1bc0b25`
**Branch**: `master`
**Repository**: Sitesmith-Studio

## Research Question

S-03 was unblocked when PRD Open Question 3 was answered: FR-027 ships as three
independent rules in ascending order of noise — untranslated placeholder text,
structural missing sections, then word count last and extreme-only. Before
planning, three things needed grounding:

1. The crawl stores no page body. What does capturing content actually cost, and
   does it threaten NFR-1 (never degrade the client's site)?
2. How does a rule get added, and what does the existing rule architecture
   require of a new one?
3. What downstream surfaces does a new finding type touch?

## Summary

**The feared cost is not there.** The response body is already fetched, already
parsed, and already in memory at the exact point the other extractors run
(`crawler.ts:238`). A content extractor slots in beside `extractHreflang` and
`extractLinks` with the same signature and **zero additional requests**. NFR-1
is not engaged by this slice at all.

**The real cost is memory, and it dictates the design.** `CrawledPage[]`
accumulates every page for the lifetime of the crawl (`crawler.ts:209, 302`),
and `MAX_PAGES` is 2000. Putting raw body text on `CrawledPage` would hold up to
2000 page bodies in RAM at once and contradict the flat-memory property
`schema.ts:259` claims. **Extract metrics at fetch time and never retain the
text.** This also disposes of the "third retention class" worry raised when the
change was opened: derived metrics are a handful of scalars per page, so they
are rows, and rows are the class the retention decision keeps indefinitely.

**The rule architecture is a precedence chain, not a list.** Rules suppress each
other deliberately — rule 6 is computed before rules 2 and 3 because it decides
what they may say; rule 5 populates `describedByFamily`, which rule 4 reads. Six
rules and four historical false-positive classes have converged on one
discipline: *never let two rules describe one problem*. Content rules must join
that chain or they will re-create the bug the project has now fixed four times.

**The single largest correctness risk is a broken page reading as drift.** A
page that 404s or times out has no body, therefore zero words and no sections.
Ranked against its family it looks like the most extreme drift on the site —
and rules 2 and 6 already report it, correctly, as a broken variant. Every
content rule must skip non-healthy pages.

## Detailed Findings

### The extraction point already has what the rules need

`src/server/crawl/crawler.ts:237-238`:

```ts
const contentType = response.headers.get("content-type") ?? "";
const html = contentType.includes("html") ? await response.text() : "";
```

The body is read into `html`, used twice, and then dropped when `fetchOne`
returns:

```ts
hreflangTargets: extractHreflang(html, served),
links: extractLinks(html, served),
```

A third call — `content: extractContent(html)` — is structurally identical to
what is already there. This is the same shape as the page-identity fix, which
the plan for that change described as "a change of argument, not of logic".

**Consequence for NFR-1:** none. No new request, no new connection, no extra
byte off the client's server. The politeness machinery (`claimSlot`, the burst
and rate thresholds at `crawler.ts:218-223, 309-341`) is untouched.

### Memory is the constraint, and it decides the storage shape

`crawler.ts:209` declares `const pages: CrawledPage[] = []` and `crawler.ts:302`
pushes every recorded page into it. The array lives for the whole crawl —
`detectMissingVariants` needs all pages at once to build families
(`run.ts:198-207`).

`schema.ts:259-260` states the intent explicitly:

> Written as the crawl proceeds rather than batched at the end, so memory stays
> flat across a 1,200-URL run.

That comment is about the *database* write. The in-memory array is not flat and
never was, which is fine while a `CrawledPage` is five small fields. It stops
being fine if one of those fields is a page body.

**Design consequence:** `CrawledPage` gains a small fixed-size content summary,
not text. Something on the order of word count, heading counts by level, counts
of forms/tables/media, and a set of placeholder markers found. That is tens of
bytes per page instead of tens of kilobytes, keeps the array flat in practice,
and is directly insertable as columns in the `onPage` handler at
`run.ts:162-170` alongside the fields already written there.

Note that `locale` and `variantGroupKey` are *not* written at `onPage` — they
are backfilled after the crawl once families are known (`run.ts:7` imports
`groupVariants`). Content metrics are per-page and known at fetch time, so they
belong in the `onPage` insert, not the backfill.

### The rule architecture is a precedence chain with explicit suppression

Reading `findings.ts` in order reveals the ordering is load-bearing and
documented:

| Rule | Type | Suppression it participates in |
|---|---|---|
| 1 | `missing_locale` | `crawlComplete` guard (`:130`); `members.length < 2` (`:142`); counts errored members as present (`:155`) so rule 2 owns them |
| 6 | `variant_diverged` | Computed **before** 2/3 (`:175-189`); writes `collapsed` |
| 2 | `hreflang_target_failed` | Reads `collapsed` and skips (`:267`) |
| 3 | `hreflang_target_unreached` | `crawlComplete` + `inScope` guard (`:294`) |
| 5 | `hreflang_family_inconsistent` | Filters to reachable (`:327`); language-not-URL comparison (`:374-385`); writes `describedByFamily` |
| 4 | `no_hreflang` | Reads `describedByFamily` and defers (`:473`) |

Every one of these guards exists because of a false positive that was actually
observed. The comments name them: seven findings where two was correct, eighteen
findings from a truncated crawl, four `/careers` findings on a real client site,
"one problem reported twice under two different names".

`context/foundation/lessons.md` generalises it:

> Every finding must be traceable to something the site itself asserted. If it
> depends on our inference or on how we collected the data, it is a claim about
> us, not about the client.

**This rule independently validates the three-way staging**, and it is worth
noticing how cleanly it sorts them:

- **Placeholder text** — the site literally published the string `lorem ipsum`.
  That is the site's own assertion, as directly as anything this product checks.
  Passes the lessons.md test outright.
- **Missing sections** — structure is observable, but "this section should have
  been translated" is partly our inference about intent.
- **Word count** — entirely our inference. Nothing the site asserted says a page
  should be a particular length. This is the rule lessons.md is most sceptical
  of, arriving at the same conclusion the PRD's noise objection did by a
  different route.

### Two content-specific traps not present in any existing rule

**1. Non-HTML responses are indistinguishable from empty pages.** At
`crawler.ts:238`, a non-HTML content type yields `html = ""`. The resulting
`CrawledPage` is `{ httpStatus: 200, hreflangTargets: {}, links: [] }` — exactly
what an HTML page with no links and no hreflang produces. Nothing records
*which* it was. A PDF or feed URL that ends up in a family would show zero words
and read as total drift.

Family membership requires an hreflang edge, and rule 3 (word count) is proposed
to need three or more members, so the practical exposure is small — but the
signal does not exist today and the content rules are the first code that would
need it.

**2. Boilerplate dominates a naive word count.** `extractLinks` reads anchors
from the whole document, and on a real site the nav and footer are inside
`<body>` along with the content. A word count over the raw body measures the
chrome as much as the article. Real sites frequently ship an identical-length
nav in every language and a differently-translated footer, so the noise is
structural, not incidental. Any word-count rule needs main-content extraction
first — which is a second, non-trivial problem sitting underneath the rule the
PRD was already most worried about.

### Downstream surfaces a new finding type touches

Adding a finding type is not confined to `findings.ts`:

- `findings.ts:19-32` — `FINDING_TYPES` const and the `FindingType` union.
- `src/app/(app)/projects/[id]/run-panel.tsx:41-48` — `FINDING_LABEL`, a plain
  `Record<string, string>`, so a missing entry degrades to a raw type slug
  rather than failing to compile.
- `run-panel.tsx:487-600` — a `switch` on finding type rendering each detail
  shape. An unhandled type falls through to whatever the default is.
- `summarise.ts:66-85` — `pagesInvolved` switches on type to count affected
  pages. Its `default` returns `one(finding.url)`, so a **family-level** content
  finding (which carries `url: null`) would report as affecting **zero pages**.
  There is already a test pinning that fallback
  (`summarise.test.ts:116-124`), which documents the trap rather than closing it.
- The parity grid (`parity.ts`) reads pages, not findings, and is unaffected.

`schema.findings.detail` is `jsonb` (`schema.ts:349`), so no migration is needed
for the finding itself — only for the per-page content metrics.

### The fixture can already express drift

`test/fixtures/site.ts:31` already has an optional `body` on the page type, and
`:220` renders `${page.body ?? '<h1>${path}</h1>'}`. Giving a family real,
differing bodies is a small edit.

Two constraints from the fixture's own header (`site.ts:17-24`), which are
unusually explicit and should be respected:

> **Every page added here is paid for by every test that crawls this site.**

Adding six pages in S-02 pushed `run.test.ts`'s politeness test past its limit
once already; its budget is now 30s, with a note saying to raise the budget
rather than remove the pacing. Content drift needs a family with three or more
members to exercise the median logic, so this slice will add pages.

Also note `:221` renders `${links}` inside `<body>`, so fixture pages carry link
text in their word count — the boilerplate problem above, reproduced in
miniature. That is arguably useful: a fixture that already has chrome is a
fixture that can prove the extractor ignores it.

## Code References

- `src/server/crawl/crawler.ts:237-238` — the body is read here and dropped when `fetchOne` returns
- `src/server/crawl/crawler.ts:252-260` — the extraction site; a content extractor slots in beside the existing two
- `src/server/crawl/crawler.ts:209,302` — `pages` accumulates for the whole crawl; the memory argument against storing text
- `src/server/crawl/findings.ts:19-32` — `FINDING_TYPES`, the discriminator new rules extend
- `src/server/crawl/findings.ts:80-83` — `isError`, the guard every content rule needs
- `src/server/crawl/findings.ts:175-189` — rule 6's collapse, and the comment explaining why order matters
- `src/server/crawl/findings.ts:199,431,473` — the `describedByFamily` suppression channel
- `src/server/crawl/variants.ts:141-177` — `groupFamilies`, the unit content drift compares within
- `src/server/crawl/run.ts:162-170` — the `onPage` insert where content metrics would be written
- `src/server/crawl/run.ts:198-207` — where `detectMissingVariants` is called and `crawlComplete` computed
- `src/server/db/schema.ts:262-311` — the `pages` table; where metric columns land
- `src/server/db/schema.ts:349` — `findings.detail` is jsonb, so finding shape needs no migration
- `src/app/(app)/projects/[id]/summarise.ts:66-85` — `pagesInvolved`; a family-level type missing here counts zero pages
- `src/app/(app)/projects/[id]/run-panel.tsx:41-48` — `FINDING_LABEL`
- `test/fixtures/site.ts:17-24` — the cost-of-adding-pages note
- `test/fixtures/site.ts:31,220` — the `body` hook the drift fixtures would use

## Architecture Insights

**Extraction is pure and takes the body plus a base URL.** Both existing
extractors are module-private pure functions over `(html, pageUrl)`. Content
extraction has no need for the URL, which makes it *more* testable than either —
a pure `string → ContentSummary` is unit-testable with no server and no crawl.

**Detection is pure over `CrawledPage[]`.** `detectMissingVariants` takes data
and returns findings with no I/O, which is what makes `site-shapes.test.ts` (963
lines, table-driven) possible. Content rules inherit this for free provided the
metrics live on `CrawledPage`.

**Every rule that reasons from absence is gated on `crawlComplete`.** Word-count
drift reasons from a family median, and a truncated crawl can hold a partial
family. Whether a partial family should suppress the rule is a question the plan
must answer explicitly — the existing precedent says yes.

**Suppression is the product's core design discipline.** Six rules, and roughly
half the code in `findings.ts` is about *not* reporting things. A content rule
that ignores this will be the seventh rule and the fifth false-positive class.

## Historical Context (from prior changes)

- `context/changes/page-identity-under-redirects/plan.md` — the most recent
  false-positive class and the closest structural analogue: a fix at the point
  data is produced rather than at the rule that consumed it. Its "Critical
  Implementation Details" section is worth re-reading for how it justified
  keeping two mechanisms that looked redundant.
- `context/archive/2026-08-25-detection-rule-confidence/` — established
  `site-shapes.test.ts` and named **the oracle problem**: expectations must come
  from the requirement or a real site, never from running the rule and recording
  its output. Directly binding here, because "what counts as drift" has no
  external oracle at all for word count — which is a further argument for
  shipping the two rules that do have one first.
- `context/archive/2026-08-25-hreflang-and-variant-parity/` — S-02, this slice's
  prerequisite. Produced `groupFamilies` and the `FamilyMember` shape that
  content drift compares within, and introduced the two-member guard.
- `context/foundation/lessons.md` — the single entry, and it sorts the three
  proposed rules by trustworthiness as cleanly as the noise argument did.

## Related Research

No prior `research.md` exists in `context/changes/**/` or `context/archive/**/`
— earlier changes went `/10x-new` → `/10x-frame` → `/10x-plan` or straight to
planning. This is the first research artifact in the project.

## Open Questions

These are for `/10x-plan` to settle, not blockers on it:

1. **Where do content metrics live** — new columns on `pages`, or a separate
   `page_content` table? Columns are simpler and the metric set is small and
   fixed; a table is easier to extend and to expire separately if metrics ever
   grow. The retention decision favours columns, since it treats rows as the
   class that is kept indefinitely.
2. **What defines "substantially identical to a sibling"** — exact body match,
   normalised-whitespace match, or a similarity ratio? A ratio reintroduces a
   threshold, which is the thing the decomposition was meant to avoid; exact or
   near-exact match keeps the rule in "the site asserted this" territory.
3. **Does missing-sections compare pairwise or against a family median?** Rule 1
   and rule 5 both work family-wide rather than pairwise, and pairwise
   comparison in an N-member family produces N² claims about one problem — the
   exact shape rule 6 exists to collapse.
4. **Does word count ship in this slice at all?** It needs main-content
   extraction to be meaningful, which is arguably its own slice. Shipping rules 1
   and 2 and deferring 3 would deliver most of FR-027's value with none of its
   risk — and the decomposition was explicitly designed so that rule 3 can be
   dropped without touching the others.
5. **Should a non-HTML response be recorded as such?** Not required by the
   drift rules given the family-size guards, but it is a real gap in
   `CrawledPage` that these rules are the first to care about.
6. **Does a partial family on a truncated crawl suppress the content rules?**
   Precedent (`crawlComplete` on rules 1 and 3) says yes for anything reasoning
   from a family-wide comparison.
