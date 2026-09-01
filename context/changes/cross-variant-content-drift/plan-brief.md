# Cross-variant content drift — Plan Brief

> Full plan: `context/changes/cross-variant-content-drift/plan.md`
> Research: `context/changes/cross-variant-content-drift/research.md`

## What & Why

FR-027 asks the product to show where language variants have diverged in
substance. It was the PRD's most contested must-have: the objection — that
honest translations legitimately differ, so the check will fire constantly — was
raised, never answered, and the slice stayed blocked for it. The answer is a
decomposition rather than a threshold. FR-027 bundles three signals whose
false-positive rates differ by orders of magnitude, and bundling them lets the
worst one decide whether the other two are believed. This slice ships the two
that can be trusted.

## Starting Point

Six detection rules exist, all reading data the crawl already stores. This is the
first that cannot: the crawler fetches each page's HTML, extracts hreflang and
links from it, and drops it. Research established that the body is nonetheless
*already in memory* at the point the existing extractors run — so reading content
costs no additional request and does not engage NFR-1 at all. What it does engage
is memory: `CrawledPage[]` accumulates against a 2,000-page ceiling.

## Desired End State

A crawl reduces each page to a small fixed-size content summary, and two new
rules read it. A page that published an unrendered template, or whose content is
character-for-character its sibling's, is reported as untranslated. A family
whose variants disagree about whether they contain a form, a table or media is
reported as structurally divergent. A family of honest translations — different
text, different lengths, same structure — is reported as nothing at all.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Which signals ship | Placeholder text + missing sections; word count deferred | Word count needs reliable main-content isolation, has no external oracle, and is the signal the PRD objected to. The decomposition was built so it detaches cleanly | Plan |
| Where metrics live | Nowhere — in memory only | Detection runs over the in-memory `CrawledPage[]`; nothing reads page rows back. Removes a migration, a retention question and a phase | Plan |
| How text is compared | Digest of normalised text, exact match | Exact match needs no threshold, and a digest keeps the summary fixed-size. The comparison choice and the memory constraint point at the same design | Plan |
| Content isolation | Prefer `<main>`/`<article>`, record when it failed | A summary including nav is weaker evidence; recording it lets a rule decline rather than report on it | Plan |
| What "missing section" means | Block-type presence, never counts | "The English page has a form and the German one has none" is binary and needs no tolerance. Heading counts differ for honest editorial reasons | Plan |
| Suppression | Skip unhealthy pages; otherwise independent | A broken page has no content and would read as extreme drift, which rules 2 and 6 already describe correctly. But hreflang and translation defects are genuinely distinct problems | Plan |
| Marker set | `lorem ipsum` and unrendered delimiters only; **no `TODO`** | `todo` is an ordinary Spanish word, so including it would report a finding on nearly every page of a Spanish client site | Plan |
| Retention class | Not applicable | The research-time worry that page text formed a third retention class dissolves once nothing is persisted | Research |

## Scope

**In scope:** a pure content extractor; main-content isolation with a recorded
fallback; rule `content_untranslated`; rule `content_structure_differs`; labels,
detail rendering and page counts for both; fixture families for each defect and
one honest-translation family that must fire nothing; proof against a real client
site.

**Out of scope:** word-count drift; persisting content metrics; retaining page
text; per-rule configuration; translation quality, tone or machine-translation
detection; the parity grid.

## Architecture / Approach

`extractContent(html, isHtml)` is a pure function producing a fixed-size
`ContentSummary` — a digest, a length, a marker list and five block-presence
booleans. It is called at `crawler.ts:257-258`, beside the two extractors already
there, and its result rides on `CrawledPage`. The normalised text that produced
the digest never leaves `fetchOne`. Both rules then read the summary inside
`detectMissingVariants`, joining the existing suppression chain rather than
sitting beside it.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Content extraction | A pure extractor and fixture shapes; nothing user-visible | Retaining text on `CrawledPage` — invisible in tests, appears only as memory pressure on a real crawl |
| 2. Rule: untranslated content | Markers and identical-sibling detection, end to end | The marker set. Every entry is a false-positive decision on someone's language |
| 3. Rule: structural divergence | Block-type disagreement across a family | Reporting on non-isolated summaries, where nav makes every page appear to have a form |
| 4. Real-site proof | Judgement on yazaki-emea.com | A rule that fires on a fixture built for it but says false things about a real site |

**Prerequisites:** S-02 (done). No schema access, no migration, no new
dependencies.
**Estimated effort:** ~3–4 sessions; phase 1 is the largest, phase 4 is
judgement rather than code.

## Open Risks & Assumptions

- Main-content isolation assumes clients ship `<main>` or `<article>`. Where they
  do not, rule 8 stays silent — correct, but coverage will be uneven across a
  client base and only phase 4 will show how uneven.
- Exact-match sibling comparison will miss the mostly-untranslated page, which is
  a realistic shape. Accepted deliberately: the alternative reintroduces the
  threshold the decomposition existed to remove.
- Adding fixture pages will break exact-count assertions and push the politeness
  test's budget again. Known, and the fixture's own header says to raise the
  budget rather than reduce the pacing.
- PRD Open Question 2 still stands — there is no mechanism to suppress a
  known-acceptable finding, so signal quality rests entirely on conservative
  detection.

## Success Criteria (Summary)

- A user sees a page reported as untranslated only when the site itself published
  a template that never rendered, or content identical to another language's.
- A family of honest translations — different words, different lengths — produces
  no finding of either new type.
- On a real client site, every new finding is one a human agrees with, and the
  results list is no less readable than before.
