# Browser-Observed Checks Implementation Plan

## Overview

Roadmap slice **S-06**. Two capabilities that happen to share a heading: what a
page's images cost, which the crawl can already answer from markup it fetches and
throws away; and what a page does when a browser actually runs it — console
errors and Core Web Vitals — which needs a real browser and is priced
accordingly.

They are sequenced apart deliberately. The image half needs no new dependency and
no new requests to the client's site beyond a bounded HEAD sweep. The render half
introduces page rendering to a product that has never had it, makes Playwright a
runtime dependency, and multiplies run duration by whatever the sample rule says.

## Current State Analysis

The crawl parses every page's HTML and keeps a fixed-size summary of it
([content.ts:1-80](src/server/crawl/content.ts)), extracting anchors only
([crawler.ts:322-335](src/server/crawl/crawler.ts)) — no `img`, no `srcset`, no
`picture`. Nothing renders anything; there is no browser in the runtime and
`@playwright/test` is a devDependency used solely by the e2e suite.

`external.ts` ([external.ts:1-70](src/server/crawl/external.ts)) is the product's
existing answer to "make many extra requests after the crawl without wrecking
anything": it shares the crawl's pacer so the total rate stays what the operator
configured, carries a per-host delay and a request ceiling derived from the pages
crawled, keeps its own failure budget so a third party cannot abort the client's
crawl, and reports `complete` — with the rule stated in its own comment, that a
rule must stay silent about an incomplete sweep.

`pages` ([schema.ts:311-360](src/server/db/schema.ts)) has no room for per-page
observations and enforces `uniqueIndex(runId, url)`.

**The measured cost.** yazaki's 533 pages crawl in ~320s, pacing-dominated at
~0.6s per page. A render that settles enough to report vitals is 5–15s and is
bound by the page, not by our pacer. The sample rule is therefore the entire cost
control, and the naive reading of FR-028 — one page per template per language
variant — computes to **143 renders** on that project, because a multilingual
site translates its URL segments (`products` / `produkte` / `produits` /
`capabilitati`: 113 distinct sections for roughly ten real ones).

## Desired End State

A run records, for every page, what its images cost and which of them are missing
dimensions or served in a legacy format. For a small, named sample of pages it
also records what a browser saw: console errors, and TTFB / LCP / CLS. The run
panel shows both, and says plainly which pages were measured and which were not —
an unmeasured page is not a fast one.

Verify by: running a real project and reading the performance section against the
site in a browser's own devtools; confirming an unsampled page shows as not
measured rather than as having no problems.

### Key Discoveries

- **`external.ts` is the sweep pattern to copy** ([external.ts:1-70](src/server/crawl/external.ts)):
  shared pacer, per-host delay, ceiling derived from pages crawled, own failure
  budget, and a `complete` flag that silences the rules when the sweep was cut
  short. The image sweep is the same shape.
- **Declared locales are the only lever that bounds the sample.** yazaki declares
  `["en","de"]` while the crawl discovered ten. The detection rules already reason
  from declared locales (`expectedLocales`), so sampling from them is the
  codebase's own convention and is bounded by configuration the operator controls.
- **Inbound link count is the site's own statement of what matters.** It is
  already derivable from `CrawledPage.links`, and the broken-link rule already
  reports `linkedFrom`. Ranking a sample by it rests on the site's own navigation
  rather than on our guess about templates.
- **Fixed-size per page is a hard constraint, stated twice** in `CrawledPage` and
  `ContentSummary`: anything held per page is multiplied by a two-thousand-page
  ceiling. Console errors and image lists must be capped at capture.
- **There is no project edit UI.** Projects are create-only
  ([project.ts](src/server/api/routers/project.ts) has no `update`), so a
  per-project rendering toggle would be a switch nobody can flip.

## What We're NOT Doing

- **Not adding Lighthouse, and not inventing a performance score.** FR-028's
  "standard page performance scores" is delivered as the measured vitals plus
  Google's own published thresholds, cited as Google's. A 0-100 composite would be
  an index this product asserts — the thing S-12 refused to invent and what
  `lessons.md` rule 1 forbids. **FR-028 is recorded as partly met.**
- **Not capturing console errors on every page.** FR-015 says each page; only a
  rendered page can produce them, and rendering each page is the cost the PRD
  already rejected under FR-028. Scoped to the rendered sample. **FR-015 is
  recorded as partly met.**
- **Not claiming template coverage.** The sample is named for what it is — the
  entry page and the most-linked pages in each declared language — and never
  described as one page per template.
- **Not emitting a finding for a slow page.** A threshold on LCP is a verdict; the
  measurement is an observation. Vitals are displayed, not detected.
- **Not adding a per-project rendering toggle.** No edit UI exists to flip it. The
  cap is the cost control instead. Recorded as the obvious follow-on.
- **Not capturing screenshots.** That is S-08, and it depends on this.
- **Not measuring INP.** It requires an interaction, and a synthetic one would be
  our behaviour rather than a user's.
- **Not deciding F-02's container shape.** This plan records what F-02 must
  accommodate; it does not build it.

## Implementation Approach

Six phases in two groups. Phases 1–2 are the image half and touch no new
dependency: markup first (free), then a bounded sweep for bytes. Phases 3–4 are
the render half, and the sample is built and tested as a pure function **before**
any browser exists, for the reason S-12 built its trend model before its grid —
the decision that carries the meaning is which pages get measured, and that
decision should be fixable without launching anything. Phase 5 is the view for
both halves. Phase 6 is the real-site proof and the honest recording of two
partly-met requirements.

The render pass runs in-process, like the crawl, with a hard per-render timeout.
`run.ts` already documents that trade — no new infrastructure, identical
behaviour in development and in a container — and a hung render is bounded the
same way a hung request is.

## Critical Implementation Details

**Everything held per page is multiplied by two thousand.** Console errors are
unbounded text by nature: cap the stored messages at a handful per page, truncate
each, and keep counts separately. The same applies to the per-page image summary —
counts always, offending URLs capped.

**A render that fails must not fail the run.** The crawl aborts on a burst of
failures because a failing site should not be hammered; a browser that cannot
launch or a page that times out is our problem, and the correct response is to
record that the page was not measured and carry on. The run's status must not
depend on the render pass.

**Playwright becomes a runtime dependency.** The container must ship Chromium and
its system libraries. F-02 `container-deploy-skeleton` is unbuilt, so this
constrains a foundation that has not been planned; Phase 6 records the constraint
where F-02's planner will find it.

## Phase 1: What the markup says about images

### Overview

Per-page image facts that cost no requests at all, and the two findings that
follow from them. Everything here is the site's own markup.

### Changes Required

#### 1. The extractor

**File**: `src/server/crawl/images.ts` (new)

**Intent**: Read a page's images out of the HTML the crawl already has, and
reduce them to a fixed-size summary — because this is held for every page of a
crawl that can reach two thousand.

**Contract**: `summariseImages(html, pageUrl)` returning an `ImageSummary`:
counts of images seen, of images declaring neither `width` nor `height`, and of
images served in a legacy format, plus a capped list of offending URLs for each
class. Follows `content.ts` in being regex-based rather than adding a DOM parser,
and in returning digests and counts rather than the source it read. A `picture`
whose `source` offers a modern type counts as modern even when its `img` fallback
does not — the site did provide one.

#### 2. Storage

**File**: `src/server/db/schema.ts`

**Intent**: Keep the summary on the page it describes.

**Contract**: One nullable `images` jsonb column on `pages`, typed as the
summary. Nullable means *not observed* — a page from before this shipped, or a
non-HTML response — which is the same convention `crawlComplete` and `ruleSet`
already use, and it must carry a comment saying so.

#### 3. The two findings

**File**: `src/server/crawl/findings.ts`

**Intent**: Report the two image problems that need no request to establish.

**Contract**: Two entries in `FINDING_TYPES` — `IMAGE_MISSING_DIMENSIONS` and
`IMAGE_LEGACY_FORMAT` — and their rules. Both are page-level and both cite the
URLs they read. A page with no images produces neither. The rules must be silent
where `images` is null: an unobserved page is not a clean one.

#### 4. Tests

**File**: `src/server/crawl/images.test.ts` (new), `src/server/crawl/findings.test.ts`

**Contract**: Cases for an `img` with both dimensions, with one, with neither; a
`picture` with a modern `source` and a legacy `img`; an `svg` and a data URI,
which are neither missing dimensions nor legacy; the cap holding on a page with
many images; and a non-HTML response summarising to nothing rather than throwing.
Findings cases assert both rules fire on the fixture site and stay silent on a
null summary.

### Success Criteria

#### Automated Verification

- Schema applies cleanly: `npm run db:push`
- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- A page with no `images` summary produces neither image finding

#### Manual Verification

- A real project's run reports image findings whose cited URLs are genuinely missing dimensions when checked in the browser

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding.

---

## Phase 2: What the images actually weigh

### Overview

The bytes, from the site's own `Content-Length`, via a bounded sweep on the
pattern `external.ts` established.

### Changes Required

#### 1. The sweep

**File**: `src/server/crawl/images.ts`

**Intent**: Ask each distinct image URL how big it is, without making the run's
request budget unpredictable.

**Contract**: `sweepImageWeights(options)` mirroring `ExternalOptions`: it takes
the crawl's pacer rather than making its own, a per-host delay, a request ceiling
derived from the pages crawled, and a failure budget of its own. Returns the
observed bytes per URL and a `complete` flag. HEAD, falling back to a ranged GET
only where HEAD is refused. Deduplicated across pages — one URL is one request
however many pages carry it.

#### 2. The finding

**File**: `src/server/crawl/findings.ts`

**Intent**: Report images heavy enough to be worth a look, with the number that
made us say so.

**Contract**: One entry in `FINDING_TYPES` — `IMAGE_OVERSIZED` — firing on a
measured byte size above a named constant, with the measured size and the
threshold both in `detail` so the reader can disagree with our threshold rather
than only with our verdict. Silent for any URL the sweep did not reach, and
silent entirely when `complete` is false.

#### 3. Tests

**File**: `src/server/crawl/images.test.ts`, `test/fixtures/site.ts`

**Contract**: A fixture page serving a deliberately heavy image and a light one.
Cases for: the ceiling stopping a sweep and the rule going quiet; a URL shared by
several pages costing one request; a HEAD refusal falling back; and the threshold
boundary reported with its number.

### Success Criteria

#### Automated Verification

- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- An incomplete sweep produces no `IMAGE_OVERSIZED` findings
- One image URL referenced by several pages costs exactly one request

#### Manual Verification

- A real project's run finishes in a time comparable to before, and the sweep's request count is proportionate to the site

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding.

---

## Phase 3: Which pages get measured

### Overview

The sample, as a pure function, decided and fixed before any browser exists. This
is the decision that carries the meaning: everything the render half claims is
bounded by which pages it looked at.

### Changes Required

#### 1. The selection

**File**: `src/server/crawl/sample.ts` (new)

**Intent**: Choose a small set of pages to render, on evidence the site itself
supplied, bounded by an absolute cap rather than by a formula that multiplies.

**Contract**: `chooseRenderSample(pages, declaredLocales, cap)` returning the
chosen URLs in a stable order plus the rule applied. Ranking: the entry page
always; then, per declared locale, pages by inbound link count descending, ties
broken by URL; taken round-robin across locales so no locale is starved by a cap.
Locale matching allows regional refinement the way the parity grid's `answers`
helper does. Pages that did not return HTML are never chosen. `MAX_RENDERS`
mirrors the parity grid's cap discipline — a small constant, stated once.

#### 2. Recording what was sampled

**File**: `src/server/db/schema.ts`

**Intent**: Record on the run what the render pass covered, so a reader — and a
later trend — can tell an unmeasured page from a fast one.

**Contract**: One nullable `renderSummary` jsonb column on `runs`: how many pages
were chosen, how many were measured, the cap in force, and whether the pass
completed. Nullable means *not recorded*, the same convention as the S-07 and
S-12 columns.

#### 3. Tests

**File**: `src/server/crawl/sample.test.ts` (new)

**Contract**: Cases for: the cap bounding a site with many locales; every declared
locale getting a page before any locale gets a second; a project declaring one
locale on a ten-locale site sampling only the declared one; the entry page always
present; non-HTML pages excluded; a site smaller than the cap sampling everything;
and an empty input returning an empty sample rather than throwing.

### Success Criteria

#### Automated Verification

- Unit tests pass: `npm run test:unit`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- The sample never exceeds `MAX_RENDERS`, whatever the locale count
- Every declared locale is represented before any locale is represented twice

#### Manual Verification

- None — this phase is user-invisible

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding.

---

## Phase 4: What the browser sees

### Overview

The render pass itself: a real browser, the sampled pages, console errors and
Core Web Vitals. The expensive half, bounded by Phase 3's cap and by a hard
per-render timeout.

### Changes Required

#### 1. The dependency

**File**: `package.json`

**Intent**: Make a browser available at run time, not only to the test suite.

**Contract**: `playwright` moves into `dependencies` at the version already
pinned for `@playwright/test`, so the e2e suite and the crawl cannot end up on
different browser builds.

#### 2. The render

**File**: `src/server/crawl/render.ts` (new)

**Intent**: Load one page in a browser and record what it reported about itself,
without letting a bad page take the run with it.

**Contract**: `renderSample(urls, options)` returning one observation per URL:
TTFB, LCP, CLS, a console-error count split first-party versus third-party by
script origin, and a capped, truncated sample of the messages — plus a
`renderError` where the page could not be measured. One browser launched for the
pass and one context per page. A hard per-render timeout; on timeout or crash the
observation records the failure and the pass continues. Returns `complete: false`
if the browser could not be launched at all, which must silence the rules rather
than fail the run. Vitals are read from the page's own PerformanceObserver and
navigation timing — the browser's numbers, not ours.

#### 3. Storage

**File**: `src/server/db/schema.ts`

**Intent**: Hold the observations for the sampled pages only.

**Contract**: A new `page_observation` table keyed to `runId` and `pageId`, unique
on the pair, carrying the fields above and the tenant id like every other table.
A page with no row was not measured — absence is the representation, which is why
this is a table rather than a dozen nullable columns on `pages`.

#### 4. The finding

**File**: `src/server/crawl/findings.ts`

**Intent**: Report a page whose own scripts failed while it loaded.

**Contract**: One entry in `FINDING_TYPES` — `CONSOLE_ERROR` — firing only on
**first-party** errors, with the count and the capped messages in `detail`, and
the third-party count alongside so the reader can see what we did not report. A
third-party widget breaking itself is on the client's page but is not the client's
defect, and reporting it as one would be the fourth entry in `lessons.md` written
a fifth time.

#### 5. Wiring

**File**: `src/server/crawl/run.ts`

**Intent**: Run the pass after the crawl, beside the external sweep, and record
what it covered.

**Contract**: The sample is chosen from the crawl's pages, rendered, observations
inserted, and `renderSummary` written into the closing run update. The run's
status never depends on the render pass. `detectMissingVariants` receives the
observations so the console rule can read them.

#### 6. Tests

**File**: `src/server/crawl/render.integration.test.ts` (new)

**Contract**: Named `*.integration.test.ts` so the integration config collects it.
Against the fixture site: a page with a deliberate console error producing an
observation and a finding; a page with none producing an observation and no
finding; a page that never settles hitting the timeout and recording a
`renderError` while the run still completes; and the run's `renderSummary`
matching the number of observations stored.

### Success Criteria

#### Automated Verification

- Schema applies cleanly: `npm run db:push`
- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- A render timeout records the failure and the run still reaches `done`
- A third-party-only console error produces no finding

#### Manual Verification

- A real project's run duration grows by a bounded, acceptable amount
- The vitals recorded for a page are close to what the browser's own devtools report for it

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding.

---

## Phase 5: Showing it

### Overview

Both halves reaching the reader: a performance section naming what was measured
and what was not, and the three image findings plus the console finding rendering
in the existing findings vocabulary.

### Changes Required

#### 1. The performance section

**File**: `src/app/(app)/projects/[id]/performance.tsx` (new), `src/app/(app)/projects/[id]/performance.ts` (new)

**Intent**: Show the sampled pages with their vitals, and say plainly that they
are a sample — a reader who thinks the whole site was measured has been misled by
us, not by the site.

**Contract**: Reads the run's observations and `renderSummary`. Pure presentation
logic lives in `performance.ts` and is tested there, as `parity.ts`, `trend.ts`
and `summarise.ts` are. Each vital is shown as its measurement with Google's
published band, attributed to Google in the section's own words. The header says
how many pages of how many were measured, and where the pass did not complete it
says so instead of showing a partial table as if it were whole.

#### 2. Finding presentation

**File**: `src/app/(app)/projects/[id]/finding-labels.ts`, `src/app/(app)/projects/[id]/run-panel.tsx`

**Intent**: Give the four new finding types reader-facing labels and evidence
renderers matching the ones already there.

**Contract**: Four entries in `FINDING_LABEL` — the module S-12 extracted for
exactly this — and evidence rendering for each, following the existing renderers
so no finding shows raw JSON.

#### 3. Tests

**File**: `src/app/(app)/projects/[id]/performance.test.ts` (new), `src/app/(app)/projects/[id]/trend.test.ts`

**Contract**: Cases for: a page with no observation rendering as not measured
rather than as fast; an incomplete pass saying so; the sample count matching
`renderSummary`. The existing label-coverage test in `trend.test.ts` already
asserts every `FINDING_TYPES` entry has a label, so it will fail until the four
new labels exist — which is the intended alarm.

### Success Criteria

#### Automated Verification

- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- Existing e2e journeys pass: `npm run test:e2e`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- Production build succeeds: `npm run build`
- Every `FINDING_TYPES` entry has a reader-facing label (existing test)

#### Manual Verification

- An unsampled page reads as not measured, never as having no problems
- The four new findings render readably with no raw JSON
- The performance section says how much of the site it describes
- The rest of the project page is unchanged

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding.

---

## Phase 6: Real-site proof and honest recording

### Overview

The whole slice against a real client project, and the three requirements
recorded for what they actually are.

### Changes Required

#### 1. The proof

**File**: `context/changes/browser-observed-checks/proof.md` (new)

**Intent**: One real project rendered and measured, with the numbers checked
against the browser's own devtools by hand, and the run-duration delta recorded
against the pre-slice baseline.

**Contract**: Run ids, the sample chosen and why those pages, the vitals as
rendered beside the same pages' devtools numbers, the console errors with their
first-party judgement examined one by one, and the before/after run duration.
An explicit statement of what share of the site was measured.

#### 2. The comparison guard, exercised for real

**File**: `context/changes/browser-observed-checks/proof.md`

**Intent**: Confirm on real data that the first comparison spanning this
deployment refuses with `rules_changed` rather than reporting four new finding
types as the client's site breaking.

**Contract**: The refusal, quoted as the reader sees it. This is the first live
exercise of S-12's Phase 2, which has only ever run against fixtures.

#### 3. Recording what was and was not met

**File**: `context/foundation/roadmap.md`

**Intent**: Say which requirements this closes and which it only partly closes, so
a half-met requirement is never silently marked done.

**Contract**: S-06's entry records FR-029 as met; FR-015 as partly met, scoped to
the rendered sample; FR-028 as partly met, delivering Core Web Vitals but no
composite performance score. It also records that **FR-039's scores half is now
deliverable**, which was S-12's stated blocker, and notes what F-02 must
accommodate: a container carrying Chromium and its system libraries.

### Success Criteria

#### Automated Verification

- Whole suite passes: `npm run test:all`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- No temporary scripts or harnesses remain in the working tree

#### Manual Verification

- The vitals reported for a sampled page match that page's devtools numbers within a reasonable margin
- Every console error reported as first-party is genuinely the client's own script
- The run-duration delta on a real project is recorded and acceptable
- The roadmap records FR-029 met, FR-015 and FR-028 partly met, and names F-02's new constraint

**Implementation Note**: This is the final phase. Confirm the manual criteria before archiving.

---

## Testing Strategy

### Unit Tests

- `summariseImages`: dimensions present/partial/absent, `picture` with a modern source, svg and data URIs, the cap, non-HTML
- `chooseRenderSample`: the cap, locale round-robin, declared-versus-discovered locales, the entry page, non-HTML exclusion, empty input
- `performance.ts`: not-measured versus measured, an incomplete pass
- Image and console rules staying silent on absent observations

### Integration Tests

- The image sweep's ceiling silencing the oversized rule
- One image URL shared across pages costing one request
- A fixture page with a console error producing an observation and a finding
- A render timeout recorded while the run still completes
- `renderSummary` matching the observations stored

### Manual Testing Steps

1. Run a check on a real project; confirm the performance section names how many pages of how many were measured.
2. Open one sampled page in a browser's devtools and compare LCP and CLS against what the run recorded.
3. Confirm a page that was not sampled reads as not measured rather than as having no problems.
4. Confirm every reported console error belongs to a script served by the client's own origin.
5. Compare the run's duration against the same project's previous runs and record the delta.
6. Open the run comparison spanning the deployment and confirm it refuses with the rule-set reason.

## Performance Considerations

This is the slice where run duration is the design constraint rather than a
footnote. The measured baseline is 533 pages in ~320s, pacing-dominated. The
image sweep adds at most one request per distinct image URL under a ceiling
derived from the pages crawled — the same bound `external.ts` already reasons
about, so a run can at worst double its request count and cannot exceed the
operator's configured rate.

The render pass is bounded twice: by `MAX_RENDERS`, and by a hard per-render
timeout. Worst case is the cap multiplied by the timeout, which is a number an
operator can be told in advance. Typical case on a small project is the whole site
rendered in seconds; typical case on yazaki is the cap.

The naive sample rule — one page per URL section per discovered locale — was
measured at 143 renders on yazaki and rejected for that reason.

## Migration Notes

Three schema changes applied by `npm run db:push`: `pages.images`,
`runs.renderSummary`, and the `page_observation` table. Nothing is backfilled —
existing runs observed none of this, and null and row-absence both mean *not
observed*, which is what they genuinely are.

Four new finding types change `Object.values(FINDING_TYPES)` and therefore
`runs.ruleSet`. The first comparison spanning this deployment will refuse with
`rules_changed`. That is S-12's guard working as designed, and Phase 6 confirms it
on real data rather than assuming it.

`playwright` moves from devDependency to dependency. Any deployment must from
then on provide Chromium and its system libraries — a constraint on F-02, which
is unbuilt.

## References

- Research: `context/changes/browser-observed-checks/research.md`
- The sweep pattern being copied: `src/server/crawl/external.ts:1-70`
- The fixed-size constraint: `src/server/crawl/content.ts:1-20`
- The rule-set guard this will trip: `context/archive/2026-09-04-quality-trend-history/`
- `lessons.md` rule 1 — why third-party console errors are not the client's defect

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: What the markup says about images

#### Automated

- [x] 1.1 Schema applies cleanly: `npm run db:push` — 79aaccf
- [x] 1.2 Unit tests pass: `npm run test:unit` — 79aaccf
- [x] 1.3 Integration tests pass: `npm run test:integration` — 79aaccf
- [x] 1.4 Type checking passes: `npm run typecheck` — 79aaccf
- [x] 1.5 Lint and format pass: `npm run check` — 79aaccf
- [x] 1.6 A page with no `images` summary produces neither image finding — 79aaccf

#### Manual

- [x] 1.7 A real project's run reports image findings whose cited URLs are genuinely missing dimensions when checked in the browser — 79aaccf

### Phase 2: What the images actually weigh

#### Automated

- [x] 2.1 Unit tests pass: `npm run test:unit`
- [x] 2.2 Integration tests pass: `npm run test:integration`
- [x] 2.3 Type checking passes: `npm run typecheck`
- [x] 2.4 Lint and format pass: `npm run check`
- [x] 2.5 An incomplete sweep produces no `IMAGE_OVERSIZED` findings
- [x] 2.6 One image URL referenced by several pages costs exactly one request

#### Manual

- [ ] 2.7 A real project's run finishes in a time comparable to before, and the sweep's request count is proportionate to the site

### Phase 3: Which pages get measured

#### Automated

- [ ] 3.1 Unit tests pass: `npm run test:unit`
- [ ] 3.2 Type checking passes: `npm run typecheck`
- [ ] 3.3 Lint and format pass: `npm run check`
- [ ] 3.4 The sample never exceeds `MAX_RENDERS`, whatever the locale count
- [ ] 3.5 Every declared locale is represented before any locale is represented twice

### Phase 4: What the browser sees

#### Automated

- [ ] 4.1 Schema applies cleanly: `npm run db:push`
- [ ] 4.2 Unit tests pass: `npm run test:unit`
- [ ] 4.3 Integration tests pass: `npm run test:integration`
- [ ] 4.4 Type checking passes: `npm run typecheck`
- [ ] 4.5 Lint and format pass: `npm run check`
- [ ] 4.6 A render timeout records the failure and the run still reaches `done`
- [ ] 4.7 A third-party-only console error produces no finding

#### Manual

- [ ] 4.8 A real project's run duration grows by a bounded, acceptable amount
- [ ] 4.9 The vitals recorded for a page are close to what the browser's own devtools report for it

### Phase 5: Showing it

#### Automated

- [ ] 5.1 Unit tests pass: `npm run test:unit`
- [ ] 5.2 Integration tests pass: `npm run test:integration`
- [ ] 5.3 Existing e2e journeys pass: `npm run test:e2e`
- [ ] 5.4 Type checking passes: `npm run typecheck`
- [ ] 5.5 Lint and format pass: `npm run check`
- [ ] 5.6 Production build succeeds: `npm run build`
- [ ] 5.7 Every `FINDING_TYPES` entry has a reader-facing label

#### Manual

- [ ] 5.8 An unsampled page reads as not measured, never as having no problems
- [ ] 5.9 The four new findings render readably with no raw JSON
- [ ] 5.10 The performance section says how much of the site it describes
- [ ] 5.11 The rest of the project page is unchanged

### Phase 6: Real-site proof and honest recording

#### Automated

- [ ] 6.1 Whole suite passes: `npm run test:all`
- [ ] 6.2 Type checking passes: `npm run typecheck`
- [ ] 6.3 Lint and format pass: `npm run check`
- [ ] 6.4 No temporary scripts or harnesses remain in the working tree

#### Manual

- [ ] 6.5 The vitals reported for a sampled page match that page's devtools numbers within a reasonable margin
- [ ] 6.6 Every console error reported as first-party is genuinely the client's own script
- [ ] 6.7 The run-duration delta on a real project is recorded and acceptable
- [ ] 6.8 The roadmap records FR-029 met, FR-015 and FR-028 partly met, and names F-02's new constraint
