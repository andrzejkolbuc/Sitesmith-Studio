# SEO metadata checks — Plan Brief

> Full plan: `context/changes/seo-metadata-checks/plan.md`
> Research: `context/changes/seo-metadata-checks/research.md`

## What & Why

FR-021, FR-022 and FR-023 cover the checks every SEO tool claims and most get
wrong by reporting too much: titles and descriptions, canonical tags, and
`noindex`. The roadmap calls this the best effort-to-value ratio on the board,
because a `noindex` shipped to production quietly removes a client's pages from
search and is invisible until traffic drops. Unlike the last slice, this one has
a defect already confirmed on a live client site.

## Starting Point

The crawl reads each page's HTML, extracts hreflang and links, and discards
everything else — no title, no description, no canonical, and no response
headers. The roadmap's claim that this slice "reads from crawled markup S-01
already has" is wrong, and the plan says so. What does exist is a settled
pattern: three pure extractors over one in-memory body, the last of which
(`content.ts`) has been through implementation review twice.

## Desired End State

A crawl records each page's metadata and one response header. Six rules read it:
a page with no title or description is reported; two pages in the same language
sharing a title are reported once, naming both; canonicals that are missing on a
site that uses them, self-conflicting, chained, or pointing somewhere broken are
reported; and a page carrying `noindex` from either channel is reported with the
channel named.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Slice scope | All three requirements, one phase each | Extractor, header capture and fixture are shared cost paid once; canonical reuses shapes rules 2 and 3 already have | Plan |
| FR-021 signals | Missing and duplicated; **no length checks** | A ~60-char title rule was measured firing on 5 of 12 sampled pages. The stub descriptions it would catch are template fallbacks, so they repeat — the duplicate rule catches them without a threshold | Plan |
| Duplicate scope | Same string, same language | Cross-locale duplicates would double-report against rule 7; the real defects on this client are within-locale | Research + Plan |
| `noindex` channels | Both, one finding, source named in the detail | `X-Robots-Tag` is on 12/12 sampled pages. Disagreement is evidence, not a separate finding — either channel means the page is deindexed | Research + Plan |
| Googlebot-scoped directives | Included, crawler named | Still the site explicitly asserting "do not index"; no false-positive surface | Plan |
| "Production" | Not claimed | The product cannot observe it until S-13. The rule reports what the site asserts and leaves the judgement to whoever chose the start URL | Plan |
| `canonical_missing` | Narrowed to sites that use canonicals elsewhere | Firing per page on a site with no canonicals is hundreds of findings saying one thing — the narrowing rule 4 already got | Plan |
| Storage | None | Detection runs in-memory; duplicate detection has every page it needs | Research |

## Scope

**In scope:** a pure metadata extractor; narrow `X-Robots-Tag` capture; six
finding types across FR-021–023; labels, detail rendering and page counts for
each; fixture cases per finding plus a correct page that must stay silent; proof
against a real client site.

**Out of scope:** title/description length or truncation checks; environment
detection; persisting metadata; capturing headers generally; `robots.txt` and
sitemaps (S-04); Open Graph, Twitter cards, structured data; judging whether a
description is any *good*.

## Architecture / Approach

`extractMetadata(html, pageUrl)` is a pure function producing a bounded
`PageMetadata` — title, description, canonical hrefs, parsed robots directives.
It is called at `crawler.ts:268-270` beside the three extractors already there,
and needs the page URL because canonical hrefs can be relative. `CrawledPage`
also gains `xRobotsTag: string | null` — the one header, not the collection. All
six rules then read those inside `detectMissingVariants`, joining the existing
suppression chain rather than sitting beside it.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Metadata extraction | Extractor, header capture, fixture shapes; nothing user-visible | Unbounded fields on a type held 2,000 times |
| 2. FR-021 missing + duplicated | The confirmed real-world defect | Language scoping — get it wrong and every untranslated page double-reports |
| 3. FR-022 canonical | Missing, conflicting, chained, broken target | Comparing un-normalised URLs and reporting our own normalisation as their defect |
| 4. FR-023 noindex | Both channels, googlebot variants, source named | Reading markup only, and missing the channel that actually deindexes |
| 5. Real-site proof | Judgement on yazaki-emea.com | Six new rules firing at once is harder to read than S-03's two |

**Prerequisites:** S-01 (built). No schema access, no migration, no new
dependencies.
**Estimated effort:** ~4–5 sessions. Phase 1 is the largest; phases 2–4 are each
one rule group over an established pattern; phase 5 is judgement.

## Open Risks & Assumptions

- Yazaki is uniform — canonical on every page, `<main>` on every page — so it
  validates the happy path and little else. S-03's two review defects survived a
  533-page crawl of it for exactly this reason.
- Six new types roughly double the rule surface in one release. If several fire
  at once on the real site, attributing noise to a specific rule gets harder.
- The duplicate rule assumes template fallbacks repeat. If a client has a unique
  but vacuous description on a single page, nothing here reports it — that is the
  deliberate cost of dropping length checks.
- PRD Open Question 2 is still unresolved: no mechanism exists to suppress a
  known-acceptable finding, so a team that regularly crawls staging will see the
  `noindex` finding every run with no way to mute it.

## Success Criteria (Summary)

- The duplicate-title defect already confirmed on the client's legal pages is
  reported — its absence would mean the rule is broken, not the site clean.
- A page with correct, unique metadata produces nothing from any of the six rules.
- A `noindex` served only in a response header is found, since that is the channel
  a markup-only tool would miss.
