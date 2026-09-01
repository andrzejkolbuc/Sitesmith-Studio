# Cross-variant content drift — Implementation Plan

## Overview

Read the page content the crawl already fetches and throws away, reduce it to a
small fixed-size summary, and add two detection rules over it: content that was
never translated, and variants whose structure disagrees. Word count — the third
signal FR-027 names and the one the PRD raised a noise objection about — is
deliberately not in this slice.

## Current State Analysis

From `research.md`, verified against code:

- `crawler.ts:238` reads the response body into `html`, uses it twice
  (`extractHreflang`, `extractLinks` at `:257-258`), and drops it when
  `fetchOne` returns. A third extractor over the same string costs **zero
  additional requests**, so NFR-1 is not engaged by this slice.
- `crawler.ts:209,302` accumulate every `CrawledPage` for the life of the crawl,
  against a `MAX_PAGES` of 2000 (`run.ts`). Anything added to `CrawledPage` is
  multiplied by two thousand.
- `run.ts:198-207` runs detection over the **in-memory** `result.pages`. Nothing
  reads page rows back from the database to detect findings, so content metrics
  need no persistence to do their job.
- `findings.ts` is a precedence chain, not a list. Rule 6 is computed before
  rules 2 and 3 because it decides what they may say (`:175-189`, `:267`); rule
  5 writes `describedByFamily`, which rule 4 reads (`:199`, `:431`, `:473`).
  Roughly half the file is about *not* reporting something twice.
- `findings.ts:80-83` defines `isError`, and every rule that reasons about a
  page's contents guards on it.
- Nothing in `CrawledPage` records whether the response was HTML at all. A
  non-HTML response yields `html = ""` (`crawler.ts:238`) and is indistinguishable
  from an HTML page with no links and no hreflang.

## Desired End State

A crawl produces, per page, a fixed-size summary of its main content. Two rules
read it:

- **`content_untranslated`** — a page carrying an unrendered template marker or
  `lorem ipsum`, or a page whose main content is character-for-character its
  sibling's after normalisation.
- **`content_structure_differs`** — a family whose members disagree about which
  block types their main content contains.

Verified by: the suite green; fixture families that produce each defect and one
that must produce neither; and a re-crawl of yazaki-emea.com whose new findings a
human agrees with.

### Key Discoveries

- The extractor can be pure `string → ContentSummary`, with no URL argument and
  no I/O — more testable than either existing extractor.
- Storing a **digest** rather than text gives exact-match sibling comparison
  while keeping the summary fixed-size. The chosen comparison (normalised exact
  match) and the memory constraint point at the same design.
- Main-content isolation must be *recorded*, not just attempted. A summary
  derived from the whole body including nav is weaker evidence, and rule 8 must
  decline rather than report on it — a search box in a header would otherwise
  make every page "have a form".
- `summarise.ts:66-85` `pagesInvolved` falls through to `one(finding.url)`, so a
  family-level finding with `url: null` would report as affecting **zero pages**
  unless it is added to the switch.

## What We're NOT Doing

- **Not implementing word-count drift.** Deferred to its own slice. It needs
  main-content isolation to be reliable across a whole client base, has no
  external oracle, and is the signal the PRD's noise objection was about. The
  decomposition was built so it detaches cleanly; this is that detaching.
- **Not persisting content metrics.** No columns, no migration, no `db:push`.
  Detection runs in memory and the finding's `detail` carries the evidence,
  which is the PRD's actual bar ("actionable without re-running the crawl").
- **Not retaining page text.** Only a digest of it. The text never leaves
  `fetchOne`.
- **Not adding per-rule configuration.** Per-finding muting was declined in the
  PRD; a per-project rule toggle would be that concept under another name.
- **Not detecting machine translation, tone, or quality.** Whether a translation
  is *good* is not observable from markup and is not what FR-027 asks.
- **Not touching the parity grid.** It reads pages, not findings.

## Implementation Approach

Extraction lands first and alone, producing data nothing yet reads. That keeps
the riskiest-to-get-wrong part — what we measure — verifiable in isolation, and
means a mistake there surfaces as a failing extractor test rather than as a
wrong finding.

Each rule then ships as a complete vertical slice: detection, label, and detail
rendering together, so that after phase 2 the product genuinely tells a user
something new, and after phase 3 it tells them a second thing. Splitting the UI
into a fourth phase would leave two phases whose output nobody can see.

The real-site proof is last and separate, mirroring phase 3 of
`page-identity-under-redirects` — the only step that can distinguish "the rules
work on a fixture built to make them fire" from "the rules say true things about
a site nobody designed for them".

## Critical Implementation Details

**The summary must stay fixed-size.** `CrawledPage` is multiplied by 2000. A
digest and a handful of booleans is tens of bytes; the normalised text that
produced the digest must never be assigned to a field. This is the single
constraint that, if violated, is invisible in tests and only appears as memory
pressure on a large real crawl.

**A broken page has no content, and two rules already say so.** Any page failing
`isError` must be excluded before either content rule looks at it, or a 404 in a
family reads as the most extreme drift on the site while rules 2 and 6 are
already describing it correctly. This is the fifth occurrence of the defect
class `context/foundation/lessons.md` was written about, and the one most likely
to be reintroduced here.

**Marker choice is a false-positive decision, not a completeness one.** `TODO`
must not be in the marker set: `todo` is an ordinary Spanish word meaning "all",
so a Spanish-language client site would report a finding on nearly every page.
The set ships deliberately short — unrendered template delimiters and
`lorem ipsum` — and each future addition needs a real observation behind it.

**Adding fixture pages breaks exact-count assertions.** Several tests assert
page counts against `test/fixtures/site.ts`, and the fixture's own header
records that S-02's six new pages pushed `run.test.ts`'s politeness test past
its limit once already. Expect to update counts, and raise that test's budget
rather than reducing its pacing.

---

## Phase 1: Content extraction

### Overview

A pure extractor producing a fixed-size summary, wired into the crawl, plus the
fixture shapes later phases need. No detection rules, so no user-visible change.

### Changes Required

#### 1. The extractor

**File**: `src/server/crawl/content.ts` (new)

**Intent**: Reduce a page's HTML to the smallest set of facts the two rules
need, isolating the main content region where the markup makes that possible and
recording honestly when it did not.

**Contract**: Exports `ContentSummary` and a pure
`extractContent(html: string, isHtml: boolean): ContentSummary`. No URL
argument, no I/O. The shape:

```ts
export type ContentSummary = {
  /** Whether the response was HTML at all; false means every other field is empty. */
  isHtml: boolean;
  /** Whether a <main>/<article> region was found, or we fell back to the whole body. */
  isolated: boolean;
  /** Digest of the normalised main-content text; null when there is too little to compare. */
  textDigest: string | null;
  /** Length of that normalised text, used only for the too-little-to-compare guard. */
  textLength: number;
  /** Unrendered-template and boilerplate markers found anywhere in the page. */
  markers: string[];
  /** Which block types the main content contains. Presence only, never counts. */
  blocks: {
    heading: boolean;
    form: boolean;
    table: boolean;
    media: boolean;
    list: boolean;
  };
};
```

Normalisation before digesting: strip `<script>`/`<style>` contents and all
tags, decode basic entities, collapse whitespace, lowercase. The digest is a
hex SHA-256 of that string, so equality of digests means equality of normalised
text and nothing weaker.

`textDigest` is null below a `MIN_COMPARABLE_CHARS` floor. This is a
too-little-evidence guard, not a tuning knob: two nearly-empty variant pages can
match by accident, and a finding resting on that is a claim about our threshold
rather than about the site.

Marker set ships as `lorem ipsum` plus unrendered template delimiters
(`{{…}}`, `${…}`, `[[…]]`) appearing in visible text. Explicitly excludes
`TODO` — see Critical Implementation Details.

#### 2. Wiring it into the crawl

**File**: `src/server/crawl/crawler.ts`

**Intent**: Produce the summary at the one point the body exists, and carry it on
the page without carrying the body.

**Contract**: `CrawledPage` gains `content: ContentSummary`. `fetchOne` computes
whether the response was HTML once and passes both it and `html` to
`extractContent`, alongside the existing two extractor calls at `:257-258`. The
error path at `:262-268` returns an empty summary. No other field changes; the
politeness machinery, dedup and failure counters are untouched.

#### 3. Fixture shapes

**File**: `test/fixtures/site.ts`

**Intent**: Give the suite content shapes it has never had — pages whose bodies
differ in the specific ways the two rules care about, and one family that must
produce nothing.

**Contract**: The page renderer gains the ability to wrap a body in `<main>`, so
both the isolated and fallback paths are exercisable. New paths:

- A family where one variant's body is identical to its sibling's — rule 7's
  sibling half.
- A page whose visible text carries an unrendered `{{…}}` marker — rule 7's
  marker half.
- A family where one member's main content has a `<form>` and the other's does
  not — rule 8.
- A family whose members are honest translations: different text, same block
  types, materially different lengths. **Must produce neither finding.** This is
  the negative assertion the whole slice rests on, and the direct answer to the
  PRD's noise objection.

Update the fixture header's page map, which the file's own comment describes as
the specification of what each finding means.

### Success Criteria

#### Automated Verification

- Extractor unit tests pass, covering: isolation found and not found, non-HTML
  input, marker detection, block presence, digest equality for identical text,
  digest difference for differing text, and the too-short guard
- Identical normalised text produces identical digests across differing markup
  whitespace
- `TODO` in page text produces no marker
- Existing crawler, politeness and run tests pass with updated page counts
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`
- Whole suite passes: `npm run test:all`

#### Manual Verification

- A crawl of the fixture site produces summaries whose `isolated` flag matches which pages were given a `<main>` wrapper

**Implementation Note**: After completing this phase and all automated
verification passes, pause here for manual confirmation before proceeding.

---

## Phase 2: Rule 7 — untranslated content

### Overview

The first and most trustworthy of FR-027's signals, end to end: detection, label
and rendering.

### Changes Required

#### 1. The rule

**File**: `src/server/crawl/findings.ts`

**Intent**: Report a page that published a template that never rendered, or
content that was never sent to a translator.

**Contract**: A new `FINDING_TYPES.CONTENT_UNTRANSLATED = "content_untranslated"`.
Two firing conditions, both per-page, both emitting `url` set to the offending
page:

1. **Markers** — the page's summary carries any marker. Fires independently of
   family membership, since an unrendered template is a defect on a monolingual
   page too. Requires only that the page pass `isError` and be HTML.
2. **Sibling identity** — the page belongs to a family of two or more, and its
   `textDigest` is non-null and equal to that of a family member with a
   *different* locale. Reported once per page, naming the sibling it matches.

Both conditions skip pages failing `isError`. The sibling condition additionally
requires `crawlComplete`, since a truncated crawl can hold a partial family.

`detail` carries the markers found, or the matching sibling URL and both
locales — enough to act on without re-running the crawl.

#### 2. Surfacing it

**Files**: `src/app/(app)/projects/[id]/run-panel.tsx`,
`src/app/(app)/projects/[id]/summarise.ts`

**Intent**: Make the finding readable and make its page count correct.

**Contract**: A `FINDING_LABEL` entry, a `case` in the detail-rendering switch
showing either the markers or the matched sibling, and a `pagesInvolved` case
returning the page plus, for the sibling condition, the sibling it matched.

### Success Criteria

#### Automated Verification

- A page with an unrendered template marker produces exactly one finding
- A page whose content is identical to its sibling's produces exactly one finding, naming that sibling
- A family of honest translations produces no `content_untranslated` finding
- A broken (4xx/5xx/errored) page in a family produces no `content_untranslated` finding
- A page below the comparable-length floor produces no sibling finding
- A truncated crawl produces no sibling findings
- Mutation: removing the `isError` guard makes the broken-page case fail
- Mutation: comparing raw text instead of normalised text makes the whitespace case fail
- Every existing site-shape case passes unchanged
- `pagesInvolved` returns non-empty for the new type
- Type checking, linting and the whole suite pass

#### Manual Verification

- The finding reads as actionable on screen — a reader can tell which page and what to fix without opening the crawl

---

## Phase 3: Rule 8 — structural divergence

### Overview

The second signal: variants whose main content disagrees about which block types
it contains.

### Changes Required

#### 1. The rule

**File**: `src/server/crawl/findings.ts`

**Intent**: Report a family where one variant carries a form, table or media
block that another does not — the "missing section" half of FR-027, judged on
presence rather than counts so that no threshold is involved.

**Contract**: A new
`FINDING_TYPES.CONTENT_STRUCTURE_DIFFERS = "content_structure_differs"`. One
family-level finding (`url: null`), never per page or per pair, matching rule
5's shape and for the same stated reason.

Considers only members that pass `isError`, are HTML, **and have
`isolated === true`**. A summary derived from the whole body includes nav and
footer, where a search form or a menu list would make every page appear to carry
a form or a list; reporting on that would be a claim about our extraction rather
than about the site. Families with fewer than two such members are skipped, as
is any family on a crawl that did not complete.

The finding names, per differing block type, which members have it and which do
not. It does **not** designate a culprit: with two members there is no basis to
say which is wrong, and the difference itself is the actionable fact.

#### 2. Surfacing it

**Files**: `src/app/(app)/projects/[id]/run-panel.tsx`,
`src/app/(app)/projects/[id]/summarise.ts`

**Intent**: Render the disagreement, and count every member as involved.

**Contract**: A `FINDING_LABEL` entry, a `case` rendering each differing block
type with the members on each side (reusing `Listed`/`summariseList` so one
finding cannot fill the screen), and a `pagesInvolved` case returning
`memberUrls` — the same treatment `hreflang_family_inconsistent` already gets.

### Success Criteria

#### Automated Verification

- A family where one member's main content has a form and another's does not produces exactly one finding
- The finding names both sides of the difference
- A family whose members agree on block types produces no finding
- A family whose members were not isolated produces no finding
- A family with a broken member produces no finding about that member
- A truncated crawl produces no findings of this type
- Mutation: removing the `isolated` requirement makes the fallback case fail
- Mutation: comparing block counts instead of presence makes the honest-translation case fail
- Every existing site-shape case passes unchanged
- `pagesInvolved` counts every member
- Type checking, linting and the whole suite pass

#### Manual Verification

- A family finding with many members stays readable rather than filling the results panel

---

## Phase 4: Proof against a real client site

### Overview

The only step that distinguishes rules that fire on a fixture built for them
from rules that say true things about a site nobody designed for them.

### Changes Required

No code. A re-crawl of yazaki-emea.com at the same pacing and scope as the
page-identity comparison, with the findings judged by hand and the result
recorded in this plan.

**Intent**: Establish whether the two new rules produce findings a human agrees
with, and — equally — whether they stay silent where a human would.

**Contract**: The before/after comparison records total findings by type, and
every new finding of either type is spot-checked live. Any finding that turns
out to be false is a blocker on the slice, not a note.

### Success Criteria

#### Automated Verification

- Whole suite passes: `npm run test:all`

#### Manual Verification

- The re-crawl completes without aborting, at the same page count order as the previous run
- Every new `content_untranslated` finding names a page a human agrees is untranslated
- Every new `content_structure_differs` finding names a real difference
- No page a human considers correctly translated is reported
- The findings list is still readable — the new rules have not swamped the existing six
- The S-03 outcome is recorded in the roadmap and `change.md` moved to `implemented`

---

## Testing Strategy

### Unit Tests

- `content.test.ts` — the extractor in isolation: isolation found/not found,
  non-HTML, markers including the `TODO`-is-Spanish negative, block presence,
  digest stability across whitespace, the too-short guard.
- `site-shapes.test.ts` — new table rows for both rules, following the existing
  table-driven pattern. Expectations come from the requirement and from what a
  human would say about the shape, never from running the rule and recording its
  output — the oracle discipline established in the detection-rule-confidence
  change.

### Integration Tests

- A fixture crawl produces both findings, and produces neither on the
  honest-translation family.

### Manual Testing Steps

1. Crawl the fixture site and confirm summaries reflect which pages carry `<main>`.
2. Read each new finding on the results screen and confirm it is actionable
   without opening the crawl.
3. Re-crawl yazaki-emea.com and judge every new finding against the live page.

## Performance Considerations

Extraction adds one pass over HTML already in memory, alongside two passes the
crawl already makes. No additional requests, connections or bytes from the
client's server — NFR-1 is not engaged.

The summary is fixed-size by construction. The only way this slice affects
memory is if normalised text is retained on `CrawledPage`; the digest exists
precisely so it need not be.

## Migration Notes

None. No schema change, no `db:push`, no backfill. Runs recorded before this
slice simply carry no findings of the new types, which is correct — the rules
did not exist when those runs were judged, and `findings` rows are deliberately
a record of what was concluded then.

## References

- Research: `context/changes/cross-variant-content-drift/research.md`
- Decisions: `context/changes/cross-variant-content-drift/change.md`
- PRD Open Question 3 (resolved): `context/foundation/prd.md`
- The lesson this slice is most exposed to: `context/foundation/lessons.md`
- Real-site proof precedent: `context/changes/page-identity-under-redirects/plan.md`
- Oracle discipline: `context/archive/2026-08-25-detection-rule-confidence/`
- Family shape this compares within: `src/server/crawl/variants.ts:141-177`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Content extraction

#### Automated

- [x] 1.1 Extractor unit tests pass across isolation, non-HTML, markers, blocks, digest and the too-short guard
- [x] 1.2 Identical normalised text produces identical digests across differing markup whitespace
- [x] 1.3 `TODO` in page text produces no marker
- [x] 1.4 Existing crawler, politeness and run tests pass with updated page counts
- [x] 1.5 Type checking passes: `npm run typecheck`
- [x] 1.6 Linting passes: `npm run check`
- [x] 1.7 Whole suite passes: `npm run test:all`

#### Manual

- [ ] 1.8 A fixture crawl produces summaries whose `isolated` flag matches which pages were given a `<main>` wrapper

### Phase 2: Rule 7 — untranslated content

#### Automated

- [ ] 2.1 A page with an unrendered template marker produces exactly one finding
- [ ] 2.2 A page whose content is identical to its sibling's produces exactly one finding, naming that sibling
- [ ] 2.3 A family of honest translations produces no `content_untranslated` finding
- [ ] 2.4 A broken page in a family produces no `content_untranslated` finding
- [ ] 2.5 A page below the comparable-length floor produces no sibling finding
- [ ] 2.6 A truncated crawl produces no sibling findings
- [ ] 2.7 Mutation: removing the `isError` guard fails the broken-page case
- [ ] 2.8 Mutation: comparing raw text instead of normalised text fails the whitespace case
- [ ] 2.9 Every existing site-shape case passes unchanged
- [ ] 2.10 `pagesInvolved` returns non-empty for the new type
- [ ] 2.11 Type checking, linting and the whole suite pass

#### Manual

- [ ] 2.12 The finding reads as actionable on screen — which page, and what to fix

### Phase 3: Rule 8 — structural divergence

#### Automated

- [ ] 3.1 A family where one member's main content has a form and another's does not produces exactly one finding
- [ ] 3.2 The finding names both sides of the difference
- [ ] 3.3 A family whose members agree on block types produces no finding
- [ ] 3.4 A family whose members were not isolated produces no finding
- [ ] 3.5 A family with a broken member produces no finding about that member
- [ ] 3.6 A truncated crawl produces no findings of this type
- [ ] 3.7 Mutation: removing the `isolated` requirement fails the fallback case
- [ ] 3.8 Mutation: comparing block counts instead of presence fails the honest-translation case
- [ ] 3.9 Every existing site-shape case passes unchanged
- [ ] 3.10 `pagesInvolved` counts every member
- [ ] 3.11 Type checking, linting and the whole suite pass

#### Manual

- [ ] 3.12 A family finding with many members stays readable rather than filling the results panel

### Phase 4: Proof against a real client site

#### Automated

- [ ] 4.1 Whole suite passes: `npm run test:all`

#### Manual

- [ ] 4.2 The re-crawl completes without aborting, at the same page count order as the previous run
- [ ] 4.3 Every new `content_untranslated` finding names a page a human agrees is untranslated
- [ ] 4.4 Every new `content_structure_differs` finding names a real difference
- [ ] 4.5 No page a human considers correctly translated is reported
- [ ] 4.6 The findings list is still readable — the new rules have not swamped the existing six
- [ ] 4.7 The S-03 outcome is recorded in the roadmap and `change.md` moved to `implemented`
