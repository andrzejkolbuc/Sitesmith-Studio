---
date: 2026-09-02T13:11:59+0200
researcher: Andrzej Kolbuc
git_commit: 6e956429ba36eba46a6a861d99d73518fe2ba021
branch: master
repository: Sitesmith-Studio
topic: "What SEO metadata checks (S-05) need, and what a real client site actually serves"
tags: [research, codebase, crawler, findings, seo, s-05, fr-021, fr-022, fr-023]
status: complete
last_updated: 2026-09-02
last_updated_by: Andrzej Kolbuc
---

# Research: SEO metadata checks (S-05)

**Date**: 2026-09-02T13:11:59+0200
**Researcher**: Andrzej Kolbuc
**Git Commit**: `6e95642`
**Branch**: `master`
**Repository**: Sitesmith-Studio

## Research Question

S-05 covers FR-021 (titles and meta descriptions), FR-022 (canonical), and
FR-023 (`noindex` in production). Four things needed grounding before a plan:

1. What does the crawl actually retain, and what has to be extracted?
2. `noindex` can be served as a header — do real sites do that, and can we see it?
3. What does "duplicated" and "out-of-range" mean concretely, and do those
   signals have an oracle outside our own opinion?
4. What would these checks find on a real client site?

## Summary

**The roadmap's premise is wrong, and I repeated it.** S-05 does not "read from
crawled markup S-01 already has" — the crawl keeps no title, description,
canonical, or robots directive. This is extraction work. The consolation is that
`content.ts` is now a reviewed, twice-hardened template for exactly this shape.

**`X-Robots-Tag` is not a theoretical concern.** It is present on **12 of 12**
sampled yazaki pages. The crawler reads one header and discards the rest
(`crawler.ts:247`), so a markup-only implementation of FR-023 would be blind to
a channel this client uses on every single page. The site also sets `<meta
name="robots">` on every page, meaning **two channels that can disagree** — and
a disagreement is itself worth reporting, since the more restrictive wins.

**FR-021 bundles three signals of very different trustworthiness**, the same
shape FR-027 turned out to have. Missing and duplicated are things the site
asserted; out-of-range is entirely our inference. Measured on this client, the
commonly cited ~60-character title guidance would fire on **5 of 12** sampled
pages — 40% — which is the noise failure the PRD calls fatal, arrived at
empirically rather than argued.

**Unlike S-03, this slice has a confirmed true positive waiting.** In all three
locales checked, the legal page serves the **homepage's title and the homepage's
meta description, byte for byte**:

| Locale | Pages sharing one title and one description |
|---|---|
| `pt` | `/pt` and `/pt/informacoes-legais/mencoes-obrigatorias` |
| `ro` | `/ro` and `/ro/informatii-legale/politica-de-confidentialitate` |
| `de` | `/de` and `/de/rechtliches/impressum` |

That is a template fallback nobody filled in, it is real, and a human would agree
on sight. With ten locales published, the full crawl will very likely find more.

## Detailed Findings

### What the crawl retains, and what it does not

`CrawledPage` (`crawler.ts:42-58`) holds `url`, `httpStatus`, `hreflangTargets`,
`links`, `content`, `fetchError`. No title, no description, no canonical, no
robots directive, and **no response headers** — `crawler.ts:247` reads
`content-type` to decide whether to parse, and the rest of the headers are gone
when `fetchOne` returns.

The extraction site is the same three-call block the last two slices used:

```
crawler.ts:268   hreflangTargets: extractHreflang(html, served),
crawler.ts:269   links:           extractLinks(html, served),
crawler.ts:270   content:         extractContent(html, isHtml),
```

A fourth extractor slots in beside them. Unlike `extractContent` it needs the
page URL, because a canonical href can be relative — so it is shaped like
`extractHreflang(html, served)`, not like `extractContent(html, isHtml)`.

**Headers need a deliberate, narrow addition.** The S-03 lesson applies directly:
`CrawledPage` is held for every page against a 2,000-page ceiling, so capturing
the whole `Headers` object multiplies an unbounded structure by two thousand.
Capture the one header the requirement needs — `x-robots-tag` as a
`string | null` — not the collection.

### `noindex` travels on two channels, and this client uses both

Sampled live, 12 pages spread across the site:

- `<meta name="robots">` present on **12/12** — all `index,follow`
- `X-Robots-Tag` present on **12/12** — all
  `index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1`

Neither carries `noindex` today, so this crawl would report nothing — but the
channel is live, and a framework or CDN change flipping the header would be
invisible to a markup-only check while quietly deindexing the site. That is
precisely the regression the roadmap calls "among the most expensive a client
site can suffer".

Two consequences for the rule:

- It must read both channels. `Googlebot`-specific variants (`<meta
  name="googlebot">`, `X-Robots-Tag: googlebot: noindex`) exist and are a
  judgement call for the plan.
- When the two channels disagree, the restrictive one wins in practice. A page
  whose markup says `index` while its header says `noindex` is a defect *and* a
  confusing one — the operator reading the page source would see nothing wrong.

### FR-021 is three signals wearing one requirement, again

This is the same discovery S-03 made about FR-027, and it sorts the same way
against `context/foundation/lessons.md`:

| Signal | Whose claim is it? | Oracle |
|---|---|---|
| **Missing** title or description | The tag is absent, or empty | The site's markup. Unambiguous |
| **Duplicated** across pages | The site published one string on two URLs | The site's markup. Unambiguous, and **confirmed true on this client** |
| **Out-of-range** length | Ours entirely | None. Guidance is pixel-based and shifts with search-engine rendering |

Measured title lengths on the 12-page sample: min 26, median 52, max 88. A rule
firing above ~60 characters would report `/pt/sobre-nos/…/gestao-ambiental` (88),
`/de/…/nachhaltiges-unternehmenswachstum` (85), `/pt/informacoes-legais/…` (75),
`/about-us/sustainability` (69), and `/ro/informatii-legale/…` (69) — **five of
twelve**. None of them is a defect a human would name.

But the extreme end is different in kind. Two sampled descriptions are
`"Discover Yazaki EMEA"` (20 characters) and `"Yazaki EMEA"` (11). Those are not
short descriptions; they are template stubs that were never written, and calling
them defects requires no threshold philosophy. That is the same "extreme only"
shape the deferred word-count rule was given.

### Duplicates should be scoped to a language, and the evidence says so

Two reasons, one architectural and one measured:

1. **Cross-locale duplicates would double-report against S-03.** A page whose
   German copy is byte-identical to its English already produces
   `content_untranslated`. Its title and description would be identical too, so a
   site-wide duplicate rule would name the same defect a second time under a
   different heading — the failure half of `findings.ts` exists to prevent.
2. **The real duplicates on this client are within a locale.** `/pt` and
   `/pt/informacoes-legais/mencoes-obrigatorias` share a title; `/pt` and `/ro`
   do not (different languages, different strings). Scoping to language finds the
   genuine defect and cannot collide with rule 7.

This also matches why duplicate titles matter for search at all: two pages
compete for the same query only if they are in the same language.

### Canonical: quiet on this client, and one trap to avoid

Sampled: canonical present on **12/12**, every one self-referential and absolute,
**zero pages with multiple canonical tags**. FR-022's checks will likely be
silent here, the way S-03's rules were — worth expecting rather than treating as
a failure.

The trap is `normaliseUrl` (`crawler.ts:99-118`), which strips the fragment,
**strips the entire query string**, and removes a trailing slash. A canonical
differing from the page URL only in those respects is not a defect. Both sides
must be normalised before comparison, or a site using `?page=2` — already
collapsed by the crawler — produces canonical findings that describe our
normalisation rather than their markup. This is the page-identity false positive
waiting to happen under a new name.

The reusable shapes already exist: "canonical points at a URL that returned an
error" and "canonical points at a URL the crawl never reached" are structurally
`hreflang_target_failed` and `hreflang_target_unreached`, including the
`crawlComplete` and `inScope` guards those carry.

### "In production" is not observable

FR-023 says `noindex` **in a production environment**. Nothing in the product
knows whether a project's start URL is production — that distinction arrives with
S-13 (scheduled and staging runs), which is blocked on the deferred F-02. A
`noindex` on a staging site is correct and expected.

Until then the rule can only report what it sees and let the operator judge. Worth
stating explicitly rather than implying the check is environment-aware.

### Where a new finding type plugs in

Eight finding types exist today (`findings.ts:22-36`). Adding one is a
three-place ritual, now well established:

- `FINDING_TYPES` and the `FindingType` union — `findings.ts:19-37`
- `FINDING_LABEL` and the `Evidence` switch — `run-panel.tsx`
- `pagesInvolved` — `summarise.ts`; its `default` returns `one(finding.url)`, so
  a family-level or multi-page finding that omits a case reports **zero pages**

Detection continues to run over the in-memory `result.pages` (`run.ts:198-207`),
and duplicate detection needs every page at once — which it has. As in S-03, no
persistence is required for the rules to work; the finding's `detail` carries the
evidence.

## Code References

- `src/server/crawl/crawler.ts:42-58` — `CrawledPage`; no metadata, no headers
- `src/server/crawl/crawler.ts:247` — the only header read; the rest are discarded
- `src/server/crawl/crawler.ts:268-270` — the extraction block a fourth extractor joins
- `src/server/crawl/crawler.ts:99-118` — `normaliseUrl`; drops query and trailing slash
- `src/server/crawl/content.ts` — the template: a pure extractor with a fixed-size result
- `src/server/crawl/findings.ts:19-37` — the eight current finding types
- `src/server/crawl/findings.ts:82-85` — `isError`, the guard every content-reading rule uses
- `src/server/crawl/findings.ts` rules 2 and 3 — the reusable "declared target failed / never reached" shape for canonical
- `src/server/crawl/run.ts:198-207` — detection over in-memory pages
- `src/app/(app)/projects/[id]/summarise.ts` — `pagesInvolved`; a missing case reports zero pages

## Architecture Insights

**Extraction is a settled pattern now.** Three pure extractors over one in-memory
body, each with a narrow result type. A fourth is routine — which is the payoff
from S-03 having been reviewed twice.

**The requirement-bundling pattern has now appeared twice.** FR-027 bundled three
drift signals; FR-021 bundles three metadata signals. In both cases the signals
differ by an order of magnitude in false-positive rate, and in both cases the
noisiest one is the one our own inference produces. Decomposing before planning
is not a one-off trick; it looks like the right default when a requirement lists
several symptoms with a comma.

**Fixed-size stays the rule for anything on `CrawledPage`.** Titles and
descriptions are bounded in practice but unbounded in principle; a hostile or
broken page could carry a megabyte title. Truncating at capture is cheaper than
discovering the ceiling on a real crawl.

## Historical Context (from prior changes)

- `context/archive/2026-08-31-cross-variant-content-drift/research.md` — the
  direct predecessor. Established the extraction seam, the memory constraint, and
  that detection runs in memory. Its "requirement bundles signals of unequal
  trustworthiness" finding repeats here almost exactly.
- `context/archive/2026-08-31-cross-variant-content-drift/reviews/impl-review.md`
  — F1 and F2 were both latent defects in region selection that neither the suite
  nor a 533-page live crawl exposed. Relevant warning: yazaki's uniformity
  (canonical on every page, `<main>` on every page) means it validates the happy
  path and almost nothing else.
- `context/changes/page-identity-under-redirects/` — why canonical comparison must
  normalise both sides. Redirect aliases produced four confident false findings by
  comparing URLs that were the same page.
- `context/foundation/lessons.md` — the single entry, and it sorts FR-021's three
  signals the same way the noise argument does.

## Related Research

- `context/archive/2026-08-31-cross-variant-content-drift/research.md` — the only
  other research artifact in the project.

## Open Questions

For `/10x-plan` to settle:

1. **Which of FR-021's three signals ship, and in what order?** Missing and
   duplicated have oracles and one has a confirmed true positive. Out-of-range
   does not — unless restricted to the extreme, stub-length end.
2. **If out-of-range ships, what makes a length indefensible rather than merely
   suboptimal?** An 11-character description is a stub; a 62-character title is
   not a defect. The boundary needs an argument, not a number from a blog post.
3. **How are the two `noindex` channels combined and reported?** One finding with
   the source named, or separate types? And does a markup/header disagreement get
   its own finding?
4. **Do `googlebot`-specific directives count?** They are legitimate and less
   common; including them widens coverage and the false-positive surface together.
5. **Is duplicate detection scoped by language, and how is a page's language
   decided?** `groupVariants` already assigns a locale per page and would be the
   natural source.
6. **What does the fixture need?** Duplicate titles within one locale but not
   across, an empty description, a canonical pointing at a 404, a page with
   conflicting robots channels, and — critically — a page that is entirely fine
   and must produce nothing.
7. **How is "production" handled** given the product cannot detect it until S-13?
