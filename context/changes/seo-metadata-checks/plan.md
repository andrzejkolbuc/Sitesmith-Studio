# SEO metadata checks — Implementation Plan

## Overview

Extract the metadata the crawl currently discards — title, meta description,
canonical, robots directives — plus the one response header that carries
`noindex`, and turn them into six detection rules across FR-021, FR-022 and
FR-023. Length-based "out of range" reporting is deliberately not in this slice.

## Current State Analysis

From `research.md`, verified against code:

- `CrawledPage` (`crawler.ts:42-58`) holds no title, description, canonical or
  robots directive, and **no response headers**. `crawler.ts:247` reads
  `content-type` to decide whether to parse and discards the rest. The roadmap's
  claim that S-05 "reads from crawled markup S-01 already has" is wrong.
- The extraction block at `crawler.ts:268-270` already runs three pure
  extractors over the in-memory body. A fourth costs no additional request.
- `normaliseUrl` (`crawler.ts:99-118`) strips the fragment, **the entire query
  string**, and a trailing slash.
- Detection runs over in-memory `result.pages` (`run.ts:198-207`); nothing reads
  page rows back. Duplicate detection needs every page at once and has them.
- Eight finding types exist (`findings.ts:19-37`). Adding one is a three-place
  ritual: the type union, `FINDING_LABEL` + the `Evidence` switch in
  `run-panel.tsx`, and `pagesInvolved` in `summarise.ts`.

Measured on yazaki-emea.com, 12 pages sampled:

- `X-Robots-Tag` present on **12/12**; `<meta name="robots">` present on **12/12**
- canonical present on **12/12**, all self-referential, zero pages with multiple
- **Confirmed defect**: in `pt`, `ro` and `de` alike the legal page serves the
  homepage's title *and* description byte for byte

## Desired End State

A crawl records each page's metadata, and six rules read it:

- **`metadata_missing`** — title or description absent or empty
- **`metadata_duplicated`** — two or more pages in one language sharing a title
  or a description
- **`canonical_missing`** — a page with no canonical, on a site that uses them
- **`canonical_conflicting`** — several canonical tags, or a canonical chain
- **`canonical_target_broken`** — canonical points at an errored or unreached URL
- **`noindex_present`** — a `noindex` directive from either channel

Verified by: the suite green; fixture cases producing each finding and one page
that must produce none; and a crawl of yazaki-emea.com whose findings a human
agrees with — including the duplicate-title defect already confirmed to exist.

### Key Discoveries

- **`noindex` travels on two channels and this client uses both.** A markup-only
  check would be blind to the one that silently deindexes a site.
- **FR-021 bundles signals of unequal trustworthiness**, exactly as FR-027 did.
  Missing and duplicated are the site's assertions; out-of-range is our
  inference, and a conventional 60-character title rule would fire on 5 of 12
  sampled pages.
- **The stub descriptions are probably already duplicates.** `"Yazaki EMEA"` and
  `"Discover Yazaki EMEA"` are template fallbacks, which means they repeat across
  pages — so the duplicate rule catches them without any length threshold.
- **Duplicates must be language-scoped** or they collide with rule 7
  (`content_untranslated`), which already reports cross-locale identical content.

## What We're NOT Doing

- **Not implementing length or "out of range" checks.** No character limits,
  no truncation warnings. The signal is our inference, it was measured firing on
  40% of sampled pages, and the real defects it would catch are already caught by
  the duplicate rule.
- **Not claiming to know what "production" means.** FR-023's environment
  qualifier is not observable until S-13; the rule reports what the site asserts
  and leaves the judgement to the operator who chose the start URL.
- **Not persisting metadata.** No columns, no migration. Detection is in-memory
  and the finding's `detail` carries the evidence.
- **Not capturing response headers generally.** One named header only.
- **Not reading `robots.txt` or sitemaps.** That is S-04.
- **Not checking Open Graph, Twitter cards, or structured data.** Not in FR-021–023.
- **Not judging title or description *quality*** — whether a description is
  compelling is not observable from markup.

## Implementation Approach

Extraction lands first and alone, as it did in S-03: the part most expensive to
get wrong is what we measure, and a mistake there should surface as a failing
extractor test rather than as a wrong finding.

Each requirement then ships as a complete vertical slice — rules, labels and
detail rendering together — so every phase after the first tells the user
something new. Grouping by requirement rather than by rule keeps each phase's
real-site behaviour interpretable.

The real-site proof is last and separate. Unlike S-03 it has a known target: the
duplicate-title defect on the legal pages must appear, and its absence would mean
the rule is broken rather than the site clean.

## Critical Implementation Details

**Both sides of a canonical comparison must be normalised.** `normaliseUrl`
strips query strings and trailing slashes, so a canonical differing only in those
respects is not a defect — and the crawler has *already* collapsed such URLs when
recording the page. Comparing raw strings would report our own normalisation as
the client's defect, which is the page-identity false positive under a new name.

**`canonical_missing` needs the narrowing rule 4 got.** A site that simply does
not use canonicals is not defective; firing per page would produce hundreds of
findings that say one thing. The rule fires only when the site publishes
canonicals on some pages and not others — an inconsistency the site itself
reveals rather than a convention we prefer.

**Header capture stays narrow and metadata stays bounded.** `CrawledPage` is held
for every page against a 2,000-page ceiling. Capture `x-robots-tag` as a string,
not the `Headers` object, and truncate title and description at capture — a
broken or hostile page can serve a megabyte title.

**Duplicate detection is the one rule that needs every page.** It cannot run
per-page inside the existing loops; it needs a grouping pass like `groupFamilies`.
Language comes from `groupVariants`, which already assigns a locale per page.

---

## Phase 1: Metadata extraction

### Overview

A pure extractor for the four markup facts, a narrow header capture, and the
fixture shapes later phases need. No rules, so nothing user-visible changes.

### Changes Required

#### 1. The extractor

**File**: `src/server/crawl/metadata.ts` (new)

**Intent**: Reduce a page's markup to the SEO facts the three requirements ask
about, resolving the canonical href against the page's own URL so a relative
canonical lands in the right place.

**Contract**: Exports `PageMetadata` and a pure
`extractMetadata(html: string, pageUrl: string): PageMetadata`. Shaped like
`extractHreflang` rather than `extractContent`, because canonical resolution
needs the base URL. Fields: the page's title and meta description as trimmed,
length-capped strings or null; every canonical href found, normalised and
deduplicated; and the robots directives found in markup, each carrying which
crawler it was scoped to.

Directives are kept as parsed tokens rather than raw strings, so that
`content="noindex, nofollow"`, `content="none"` and a `googlebot`-scoped variant
all reduce to the same comparable shape.

#### 2. The header

**File**: `src/server/crawl/crawler.ts`

**Intent**: Keep the one response header that can deindex a site, without
retaining the header collection.

**Contract**: `CrawledPage` gains `metadata: PageMetadata` and
`xRobotsTag: string | null`, read from the response alongside `content-type`. The
error path returns empty values for both. Nothing else in the fetch loop changes.

#### 3. Fixture shapes

**File**: `test/fixtures/site.ts`

**Intent**: Give the suite the metadata shapes it has never had, including the
negative case every later phase depends on.

**Contract**: The page type gains optional metadata fields and a way to serve a
response header. New pages covering: a page with no title and no description; two
pages in one language sharing a title; two pages in *different* languages sharing
a title (must stay silent); a page with two conflicting canonical tags; a
canonical pointing at a 404; a page with `noindex` in markup; a page with
`noindex` only in the header; a page whose two channels disagree; and a page with
complete, correct, unique metadata that must produce nothing.

### Success Criteria

#### Automated Verification

- Extractor unit tests pass: title, description, canonical resolution from a relative href, multiple canonicals, robots token parsing, `content="none"`, googlebot-scoped directives, and absent/empty cases
- A relative canonical resolves against the page URL, not the requested URL
- Title and description are length-capped at capture
- Existing crawler, politeness and run tests pass
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`
- Whole suite passes: `npm run test:all`

#### Manual Verification

- A fixture crawl records metadata matching what each fixture page declares, including the header-only page

---

## Phase 2: FR-021 — missing and duplicated metadata

### Overview

The requirement with a confirmed real-world defect behind it, end to end.

### Changes Required

#### 1. The rules

**File**: `src/server/crawl/findings.ts`

**Intent**: Report a page that published no title or description, and pages in
one language that published the same one.

**Contract**: Two new types. `metadata_missing` is per page (`url` set), naming
which field is absent, and skips pages failing `isError`.
`metadata_duplicated` is one finding per duplicated *string* (`url: null`),
naming the field, the language, the shared value and every page carrying it —
never one finding per page, following rule 7's identical-content shape.

Language comes from `groupVariants`; pages whose language is unknown are not
compared, since "same language" cannot be established. Requires `crawlComplete`,
because a truncated crawl can hold one member of a duplicate pair.

#### 2. Surfacing them

**Files**: `src/app/(app)/projects/[id]/run-panel.tsx`, `summarise.ts`

**Contract**: `FINDING_LABEL` entries, `Evidence` cases rendering the missing
field or the shared string with its pages (via `Listed`), and `pagesInvolved`
cases — the duplicate type returning every page, or it reports as affecting none.

### Success Criteria

#### Automated Verification

- A page with no title produces exactly one finding naming the title
- A page with an empty-string description produces a finding
- Two same-language pages sharing a title produce exactly one finding naming both
- Two different-language pages sharing a title produce no finding
- A page whose language is unknown is never reported as a duplicate
- A broken page produces no metadata findings
- A truncated crawl produces no duplicate findings
- Mutation: removing the language scope makes the cross-language case fail
- Mutation: reporting per page rather than per string makes the pair case fail
- Every existing site-shape case passes unchanged
- `pagesInvolved` counts every page of a duplicate finding
- Type checking, linting and the whole suite pass

#### Manual Verification

- The duplicate finding reads as actionable — which pages, which field, and what they share

---

## Phase 3: FR-022 — canonical problems

### Overview

Three canonical defects, two of them structurally identical to rules that already
exist.

### Changes Required

#### 1. The rules

**File**: `src/server/crawl/findings.ts`

**Intent**: Report canonicals that are absent on a site that uses them,
self-conflicting, or pointing somewhere broken.

**Contract**: Three new types, all skipping `isError` pages.

`canonical_missing` fires per page **only when the crawl saw canonicals on other
pages** — a site not using them at all is not defective, and the narrowing
mirrors rule 4's. Requires `crawlComplete`, since the evidence that the site uses
canonicals is drawn from pages we reached.

`canonical_conflicting` covers two shapes under a `kind` discriminator: several
canonical tags on one page naming different URLs, and a canonical chain — this
page's canonical target declares a different canonical of its own.

`canonical_target_broken` reuses the rules 2 and 3 shapes exactly, including
their `inScope` and `crawlComplete` guards: the target errored, or the crawl
finished without reaching an in-scope target.

**Both sides of every comparison pass through `normaliseUrl` first.**

#### 2. Surfacing them

**Files**: `run-panel.tsx`, `summarise.ts`

**Contract**: Labels, `Evidence` cases showing the page and its canonical target
(and, for a chain, the third URL), and `pagesInvolved` entries counting the page
plus its target.

### Success Criteria

#### Automated Verification

- A page with two canonical tags naming different URLs produces exactly one finding
- A canonical pointing at a 404 produces exactly one finding
- A canonical chain (A→B where B→C) produces exactly one finding
- A canonical differing from the page URL only by a trailing slash produces no finding
- A canonical differing only by a query string produces no finding
- A page with no canonical on a site using none produces no finding
- A page with no canonical on a site using them elsewhere produces exactly one finding
- A canonical pointing outside the crawl scope produces no unreached finding
- Mutation: comparing un-normalised URLs makes the trailing-slash case fail
- Mutation: removing the site-uses-canonicals narrowing makes the no-canonicals case fail
- Every existing site-shape case passes unchanged
- Type checking, linting and the whole suite pass

#### Manual Verification

- A canonical finding names both the page and the target without the reader opening the crawl

---

## Phase 4: FR-023 — noindex

### Overview

The most expensive regression a client site can suffer, from both channels it
travels on.

### Changes Required

#### 1. The rule

**File**: `src/server/crawl/findings.ts`

**Intent**: Report a page the site has told search engines not to index, whether
the instruction came from markup or from a header.

**Contract**: One type, `noindex_present`, per page. The detail names every
source that carried the directive — markup, header, or both — the crawler each
was scoped to when not generic, and whether the two channels disagree.
Disagreement is recorded as evidence rather than as a separate finding, because
either channel asserting `noindex` produces the same outcome; what it explains is
why the defect was not noticed.

`content="none"` counts as `noindex`. Googlebot-scoped directives count and say
so. The rule skips `isError` pages and needs no `crawlComplete` guard — the
evidence is on the page in front of us.

The finding makes no claim about whether the site is production. It reports what
the site asserted; the operator chose the start URL and knows what it is.

#### 2. Surfacing it

**Files**: `run-panel.tsx`, `summarise.ts`

**Contract**: A label, an `Evidence` case naming the source channel and the
directive found, and a `pagesInvolved` case.

### Success Criteria

#### Automated Verification

- A page with `<meta name="robots" content="noindex">` produces exactly one finding naming markup as the source
- A page with only `X-Robots-Tag: noindex` produces exactly one finding naming the header
- A page with both produces exactly one finding naming both sources
- A page whose markup says index and header says noindex produces one finding recording the disagreement
- `content="none"` produces a finding
- A googlebot-scoped noindex produces a finding naming the crawler
- A page with `index,follow` on both channels produces no finding
- A broken page produces no finding
- Mutation: ignoring the header makes the header-only case fail
- Every existing site-shape case passes unchanged
- Type checking, linting and the whole suite pass

#### Manual Verification

- The finding makes clear which channel to edit to fix it

---

## Phase 5: Proof against a real client site

### Overview

Six new rules judged on a site nobody built for them — with, for the first time,
a defect known in advance to be there.

### Changes Required

No code. A crawl of yazaki-emea.com at the project's existing pacing, with every
new finding judged by hand and the result recorded in `change.md`.

**Intent**: Establish whether the six rules say true things about a real site,
and whether the one defect we know exists is actually found.

**Contract**: The run's findings are compared against the previous run by type.
Every new finding is spot-checked live. The duplicate-title defect on the legal
pages **must** appear — its absence is a rule failure, not a clean site. Any
finding that turns out to be false blocks the slice.

### Success Criteria

#### Automated Verification

- Whole suite passes: `npm run test:all`

#### Manual Verification

- The crawl completes without aborting, at a page count consistent with previous runs
- The known duplicate-title defect on the legal pages is reported
- Every `metadata_missing` finding names a page genuinely lacking that field
- Every `canonical_*` finding names a real canonical problem
- Every `noindex_present` finding names a page that genuinely carries the directive
- No page a human considers correctly configured is reported
- The findings list is still readable — six new rules have not swamped the existing eight
- The S-05 outcome is recorded and `change.md` moved to `implemented`

---

## Testing Strategy

### Unit Tests

- `metadata.test.ts` — the extractor in isolation: relative canonical resolution,
  multiple canonicals, robots token parsing including `none` and crawler-scoped
  forms, absent and empty fields, length capping.
- `site-shapes.test.ts` — table-driven rule cases following the established
  pattern. Expectations come from the requirement or from what a human would say,
  never from running the rule and recording its output.

### Integration Tests

- A fixture crawl produces each of the six findings, and produces none on the
  fully-correct page.

### Manual Testing Steps

1. Crawl the fixture and confirm recorded metadata matches what each page declares.
2. Read each new finding on the results screen and confirm it names what to fix.
3. Crawl yazaki-emea.com and judge every new finding against the live page.

## Performance Considerations

One additional pass over HTML already in memory, alongside the three the crawl
already makes. No additional requests — NFR-1 is not engaged. Duplicate detection
adds one grouping pass over the page set, comparable to `groupFamilies`.

## Migration Notes

None. No schema change, no `db:push`. Runs recorded before this slice carry no
findings of the new types, which is correct — the rules did not exist when those
runs were judged.

## References

- Research: `context/changes/seo-metadata-checks/research.md`
- Decisions: `context/changes/seo-metadata-checks/change.md`
- The extractor template: `src/server/crawl/content.ts`
- Reusable target-broken shapes: `src/server/crawl/findings.ts` rules 2 and 3
- The narrowing precedent for `canonical_missing`: `findings.ts` rule 4
- Why both sides must be normalised: `context/archive/2026-08-31-cross-variant-content-drift/` and the page-identity change
- `context/foundation/lessons.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Metadata extraction

#### Automated

- [x] 1.1 Extractor unit tests pass across title, description, canonical, robots tokens and absent cases — 0bdf817
- [x] 1.2 A relative canonical resolves against the page URL, not the requested URL — 0bdf817
- [x] 1.3 Title and description are length-capped at capture — 0bdf817
- [x] 1.4 Existing crawler, politeness and run tests pass — 0bdf817
- [x] 1.5 Type checking passes: `npm run typecheck` — 0bdf817
- [x] 1.6 Linting passes: `npm run check` — 0bdf817
- [x] 1.7 Whole suite passes: `npm run test:all` — 0bdf817

#### Manual

- [ ] 1.8 A fixture crawl records metadata matching what each fixture page declares, including the header-only page

### Phase 2: FR-021 — missing and duplicated metadata

#### Automated

- [x] 2.1 A page with no title produces exactly one finding naming the title — 0609b6b
- [x] 2.2 A page with an empty-string description produces a finding — 0609b6b
- [x] 2.3 Two same-language pages sharing a title produce exactly one finding naming both — 0609b6b
- [x] 2.4 Two different-language pages sharing a title produce no finding — 0609b6b
- [x] 2.5 A page whose language is unknown is never reported as a duplicate — 0609b6b
- [x] 2.6 A broken page produces no metadata findings — 0609b6b
- [x] 2.7 A truncated crawl produces no duplicate findings — 0609b6b
- [x] 2.8 Mutation: removing the language scope fails the cross-language case — 0609b6b
- [x] 2.9 Mutation: reporting per page rather than per string fails the pair case — 0609b6b
- [x] 2.10 Every existing site-shape case passes unchanged — 0609b6b
- [x] 2.11 `pagesInvolved` counts every page of a duplicate finding — 0609b6b
- [x] 2.12 Type checking, linting and the whole suite pass — 0609b6b

#### Manual

- [ ] 2.13 The duplicate finding reads as actionable — which pages, which field, and what they share

### Phase 3: FR-022 — canonical problems

#### Automated

- [x] 3.1 A page with two canonical tags naming different URLs produces exactly one finding — 96b43a8
- [x] 3.2 A canonical pointing at a 404 produces exactly one finding — 96b43a8
- [x] 3.3 A canonical chain (A→B where B→C) produces exactly one finding — 96b43a8
- [x] 3.4 A canonical differing from the page URL only by a trailing slash produces no finding — 96b43a8
- [x] 3.5 A canonical differing only by a query string produces no finding — 96b43a8
- [x] 3.6 A page with no canonical on a site using none produces no finding — 96b43a8
- [x] 3.7 A page with no canonical on a site using them elsewhere produces exactly one finding — 96b43a8
- [x] 3.8 A canonical pointing outside the crawl scope produces no unreached finding — 96b43a8
- [x] 3.9 Mutation: comparing un-normalised URLs fails the trailing-slash case — 96b43a8
- [x] 3.10 Mutation: removing the site-uses-canonicals narrowing fails the no-canonicals case — 96b43a8
- [x] 3.11 Every existing site-shape case passes unchanged — 96b43a8
- [x] 3.12 Type checking, linting and the whole suite pass — 96b43a8

#### Manual

- [ ] 3.13 A canonical finding names both the page and the target without the reader opening the crawl

### Phase 4: FR-023 — noindex

#### Automated

- [x] 4.1 A page with `<meta name="robots" content="noindex">` produces exactly one finding naming markup as the source
- [x] 4.2 A page with only `X-Robots-Tag: noindex` produces exactly one finding naming the header
- [x] 4.3 A page with both produces exactly one finding naming both sources
- [x] 4.4 A page whose markup says index and header says noindex produces one finding recording the disagreement
- [x] 4.5 `content="none"` produces a finding
- [x] 4.6 A googlebot-scoped noindex produces a finding naming the crawler
- [x] 4.7 A page with `index,follow` on both channels produces no finding
- [x] 4.8 A broken page produces no finding
- [x] 4.9 Mutation: ignoring the header fails the header-only case
- [x] 4.10 Every existing site-shape case passes unchanged
- [x] 4.11 Type checking, linting and the whole suite pass

#### Manual

- [ ] 4.12 The finding makes clear which channel to edit to fix it

### Phase 5: Proof against a real client site

#### Automated

- [ ] 5.1 Whole suite passes: `npm run test:all`

#### Manual

- [ ] 5.2 The crawl completes without aborting, at a page count consistent with previous runs
- [ ] 5.3 The known duplicate-title defect on the legal pages is reported
- [ ] 5.4 Every `metadata_missing` finding names a page genuinely lacking that field
- [ ] 5.5 Every `canonical_*` finding names a real canonical problem
- [ ] 5.6 Every `noindex_present` finding names a page that genuinely carries the directive
- [ ] 5.7 No page a human considers correctly configured is reported
- [ ] 5.8 The findings list is still readable — six new rules have not swamped the existing eight
- [ ] 5.9 The S-05 outcome is recorded and `change.md` moved to `implemented`
