# Visual regression with baselines and masked regions — Implementation Plan

## Overview

Roadmap slice **S-08**. A user pins one run's rendered snapshots as a project's
baseline, and every later run reports which of those pages now look different,
where on the page, and side by side against the baseline — with per-project
masks keeping carousels and date stamps out of the comparison entirely.

This is the first artifact the product stores that is not a row of text, and the
first check whose evidence is partly *our own rendering*. Both facts shape every
decision below.

## Current State Analysis

S-06 built the machinery and none of the storage. `render.ts` already launches
Chromium, loops a sample serially with a fresh context per page, waits
`SETTLE_MS` past load, and records failure rather than throwing
(`src/server/crawl/render.ts:153`). Adding `page.screenshot()` is close to a
one-line change; everything hard is downstream of it.

What does not exist, confirmed by inspection rather than assumption:

- **Anywhere to put bytes.** No object store, no filesystem writer, no image
  library, no `STORAGE_*` variable — `src/env.js` has three variables and one is
  `NODE_ENV`.
- **Anything that enforces retention.** "The baseline never expires; beyond it
  only the three most recent runs keep their images" (PRD Open Question 5) is a
  sentence in a document. Nothing in the repo deletes anything, anywhere.
- **Any mutation on the project router besides `create` and `startRun`.** A
  baseline and a mask list both need one.
- **Any binary-serving surface.** tRPC returns JSON through superjson. The two
  route handlers that exist are Auth.js and tRPC's own.

What does exist and must be worked with:

- `chooseRenderSample` ranks by inbound-link count with URL as tiebreak,
  documented as stable "for two runs of an unchanged site"
  (`src/server/crawl/sample.ts:133`). Inbound-link counts move whenever
  navigation changes — one of the deploys most likely to break a page visually.
  A set that reshuffles under exactly the condition being hunted is not a set a
  comparison can use.
- `MAX_RENDERS = 12` is "the entire cost control", and S-06's proof measured
  4–6s per render on a real client site.
- `comparability()` already refuses on four grounds and is the most carefully
  argued function in the repo (`src/server/crawl/comparison.ts:78`).
- `runs.ruleSet` is derived from `FINDING_TYPES` at close
  (`src/server/crawl/run.ts:433`), so a new finding type makes the first
  comparison across this deploy correctly refuse with `rules_changed`. That is
  already handled and needs verifying, not building.

## Desired End State

A project has a baseline: one run's snapshots, pinned, with the date it was
pinned and the mask selectors in force. Every later run renders that same set of
pages, captures a masked full-page PNG of each at a pinned viewport, and stores
it. Where a page's rendering differs from its baseline beyond the renderer's own
anti-aliasing noise, the run produces a `visual_changed` finding citing the
changed-pixel count, its share of the compared area, and up to eight bounding
boxes saying where. The project page gains a section where each of those pages
can be reviewed baseline-against-current, with a diff overlay generated on
demand. Images expire on the PRD's rule, enforced by code, and a snapshot that
expired stays distinguishable from one that was never captured.

Verified by: an unchanged site producing a comparison with no differing pages,
on a real client project, measured — see Phase 6.

### Key Discoveries

- `render.ts` creates a fresh `browser.newContext()` per page with no viewport
  set, so Playwright's default silently applies
  (`src/server/crawl/render.ts:211`). A snapshot is a claim about a rendering at
  a size; the size must be pinned and recorded.
- `pageObservations` is a table rather than columns on `pages` precisely because
  absence *is* "not measured" (`src/server/db/schema.ts:407`). Snapshots take the
  same shape for the same reason.
- Every nullable column in the schema carries the same comment — **null means
  *not recorded*, not false** — with an explicit "do not fix this to
  `notNull().default(false)`" on `crawlComplete` (`src/server/db/schema.ts:246`).
- `renderSummary` sits on the run row rather than being inferred from how many
  observation rows exist, "because a sample is a claim about coverage"
  (`src/server/db/schema.ts:297`). A visual summary is the same kind of claim.
- S-06's real-site reading caught the trend and the comparison printing *the same
  paragraph twice*, because both drew on `REASON_SENTENCE`
  (`context/archive/2026-09-05-browser-observed-checks/proof.md`). A finding and
  a review panel describing the same page are the identical trap.
- S-06 hit a TypeScript import ambiguity from naming a component and its logic
  module the same thing, resolved by renaming to `performance-table.tsx`. The
  visual panel must not repeat it.

## What We're NOT Doing

- **Not snapshotting every page.** FR-031 says "each page in a run". At the 4–6s
  per render S-06 measured, that is 1.5–2 hours per run on the 1,200-URL site
  this product targets, and tens of gigabytes across four retained sets and ten
  projects. The PRD recorded this objection during shaping and did not adopt it
  (`context/foundation/prd.md:274`), deferring to Open Question 5 — whose
  resolution bounds history *depth* and is silent on *breadth*. This is the same
  requirement shape FR-028 had before it was rewritten from per-page to sampled.
  FR-031 will be recorded as **partly met**, the way S-06 recorded FR-015 and
  FR-028.
- **No similarity score.** A 0–100 "how alike" number is a composite index the
  product would be asserting. Refused for performance, refused for the quality
  trend, refused again here. Pixel counts are measurements; a grade is an
  opinion of them.
- **No mobile or second-viewport capture.** Responsive breakage is real and out
  of scope; it doubles both binding constraints.
- **No stored diff overlay.** Generated on demand from the two images we already
  hold. A third image per compared page is ~50% more of the line item the PRD
  called the one most likely to force a hosting bill.
- **No per-finding muting.** Declined in the PRD. Masks are the only suppression
  mechanism, and they are per project by requirement.
- **No baseline history.** One pinned baseline per project. Re-pinning replaces
  it and is recorded as having happened; the previous pin is not kept.
- **Not changing `comparability()`.** A baseline moving must not suppress the
  hreflang comparison. Visual comparability is a narrower, separate question —
  see Phase 4.

## Implementation Approach

Six phases, each independently committable and verifiable, ordered so that
nothing is captured before there is a correct place to put it and nothing is
compared before there is something to compare.

The spine of the design is one decision: **pinning a baseline pins the render
set.** Once a project has a baseline, the pages a run renders are the pages the
baseline captured — read from rows, never re-derived. That makes the visual
comparison possible at all, and as a side effect stops the vitals sample drifting
too, which the FR-039 follow-on will want.

The honesty discipline is inherited wholesale. Our failures are recorded, never
reported as the client's. Absence is a representation, and this slice adds a
third state to it: a snapshot that *expired* is neither one we have nor one we
never took. Coverage is stated rather than implied. And where a comparison cannot
be trusted, it refuses and names the reason.

## Critical Implementation Details

**Full-page screenshots do not trigger lazy loading.** Playwright's
`fullPage: true` resizes to capture rather than scrolling, so images and sections
behind an `IntersectionObserver` never load and every such region reads as
changed the moment one of them happens to load. The capture must scroll the page
to the bottom in steps and back to the top before shooting. This has to happen
*after* the vitals `evaluate` — scrolling would otherwise contaminate the CLS
reading, which is the measurement `SETTLE_MS` exists to protect.

**Bytes must not accumulate across the render loop.** `renderSample` currently
returns small structured data. Twelve full-page PNGs held until the loop ends is
tens of megabytes, and the crawl's documented habit is to write as it goes so
memory stays flat. `renderSample` takes an optional async sink instead, called
per page; `run.ts` supplies one that inserts. `render.ts` stays free of any
database import.

**pixelmatch requires identical dimensions.** A full-page capture's height varies
with content, so a page that grew produces a taller PNG. Differing *widths* are a
pinned-viewport violation and refuse; differing *heights* are compared over the
overlapping region with the delta reported as evidence, which is the user-facing
decision already taken.

## Phase 1: Where a snapshot lives

### Overview

The schema for snapshots, baselines and masks, plus the retention rule and the
thing that enforces it. Nothing captures anything yet — this phase exists so that
when Phase 2 produces bytes, there is a correct and bounded place for them.

### Changes Required

#### 1. The snapshot record

**File**: `src/server/db/schema.ts`

**Intent**: Hold one rendering of one page from one run, and enough about how it
was made that a later comparison can tell whether two of them may be compared at
all.

**Contract**: New `pageSnapshots` table, following `pageObservations` in shape and
in reasoning — a table rather than columns on `pages` because only a watched set
is captured, so absence of a row *is* "not watched". Columns: `id`, `tenantId`,
`runId`, `pageId`, `image` (`bytea`, nullable), `byteSize` (integer, nullable),
`imageWidth` / `imageHeight` (integers, nullable — the PNG's own dimensions,
which vary with page height), `viewportWidth` / `viewportHeight` (integers — what
the browser was set to), `maskSelectors` (`text[]` — the masks in force at
capture, snapshotted for the same reason `runs.scope` snapshots project config),
`captureError` (text), `expiredAt` (timestamp), `createdAt`. Unique index on
`(runId, pageId)`; tenant and run indexes matching the existing tables.

The three-state nullability is load-bearing and must carry a comment saying so:
`image` present means we have it; `image` null with `captureError` set means the
capture failed; `image` null with `expiredAt` set means we had it and retention
took it. A row with all three null is a bug, not a state.

`byteSize` is stored rather than derived so a list view can report storage
without selecting the bytes.

#### 2. The baseline and the masks

**File**: `src/server/db/schema.ts`

**Intent**: Record which run is the project's baseline, when it was pinned, and
what the project masks.

**Contract**: Three nullable columns on `projects` — `baselineRunId` (references
`runs.id`), `baselinePinnedAt` (timestamp), and `maskSelectors` (`text[]`,
defaulting to empty). Null `baselineRunId` means no baseline, which is a real and
common state and not an error.

#### 3. The run's claim about coverage

**File**: `src/server/db/schema.ts`

**Intent**: Say what the visual pass covered, beside the run, the way
`renderSummary` does.

**Contract**: One nullable `visualSummary` jsonb column on `runs`:
`{baselineRunId: string | null, watched, captured, compared, differing, complete}`.
Nullable meaning *not recorded* — a run from before this shipped. It must carry
the same "do not default this" comment the neighbouring columns carry: a zero
would assert that a historical run watched nothing, which is a different claim
from having no answer.

#### 4. The retention rule

**File**: `src/server/crawl/retention.ts` (new)

**Intent**: Decide which runs' images expire, as a pure function, so the rule can
be tested without a database and read without tracing a query.

**Contract**: `runsToExpire(runIds, baselineRunId, keep)` — given a project's run
ids newest-first, the pinned baseline, and how many recent runs keep their
images, return the ids whose images should be dropped. The baseline is never
returned even when it falls outside the window, and it does not consume a slot in
`keep`. Export `SNAPSHOTS_KEPT = 3` with the PRD's reasoning in its docblock.

#### 5. The enforcer

**File**: `src/server/crawl/retention.ts`

**Intent**: Apply the rule, dropping bytes while keeping the fact that a snapshot
once existed.

**Contract**: `expireSnapshots(db, projectId)` — nulls `image` and `byteSize` and
sets `expiredAt` on the rows belonging to the returned runs, leaving every other
column intact. It **updates, never deletes**: a deleted row makes an expired
snapshot indistinguishable from one that was never taken, and only one of those
is a statement about our own storage. Idempotent — a second call on the same
project changes nothing.

#### 6. Tests

**File**: `src/server/crawl/retention.test.ts` (new),
`src/server/crawl/run.test.ts`

**Contract**: Unit cases for `runsToExpire`: fewer runs than `keep` expires
nothing; the baseline outside the window survives; the baseline inside the window
does not consume a slot; no baseline at all still keeps the three most recent; an
empty list returns empty. Integration cases for `expireSnapshots`: rows are
updated rather than deleted, `expiredAt` is set, a second call is a no-op, and
one tenant's call never touches another tenant's rows. Add `retention.test.ts` to
`vitest.unit.config.ts`'s explicit `include` list.

### Success Criteria

#### Automated Verification

- Schema applies cleanly: `npm run db:push`
- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- `expireSnapshots` updates rows and deletes none, proven by row count before and after

#### Manual Verification

- A project with no baseline reads as having none, rather than as an error

---

## Phase 2: What a snapshot is a picture of

### Overview

Capture, inside the render pass that already exists. A pinned viewport, a full
page, masks applied by the browser before the PNG exists, and a failure
discipline that leaves the run untouched.

### Changes Required

#### 1. The viewport

**File**: `src/server/crawl/render.ts`

**Intent**: Pin the size every snapshot is taken at, and make it a value the rest
of the system can read rather than a default nobody chose.

**Contract**: Export `SNAPSHOT_VIEWPORT = { width: 1280, height: 800 }`. The
docblock must say plainly that this number is *ours* rather than the site's,
which is why it is recorded on every snapshot row and why a pair of snapshots
taken at different viewports refuses comparison instead of reporting every page
as changed. `measure()` passes it to `browser.newContext()`.

#### 2. Capture

**File**: `src/server/crawl/render.ts`

**Intent**: Take the picture, masked, after the vitals are read.

**Contract**: `RenderOptions` gains `snapshot?: { masks: string[]; onCapture:
(url: string, png: Buffer, size: {width: number; height: number}) => Promise<void> }`.
When present, `measure()` — *after* the vitals `evaluate` returns — scrolls the
page to the bottom in viewport-sized steps and back to the top, then calls
`page.screenshot({ fullPage: true, animations: "disabled", caret: "hide", mask:
masks.map((s) => page.locator(s)) })` and hands the buffer to `onCapture`.

Ordering is load-bearing: scrolling before the vitals read would contaminate CLS,
which is the measurement `SETTLE_MS` exists to protect.

`PageObservation` gains `snapshotError: string | null`. A screenshot that throws
— an invalid selector, a timeout, an out-of-memory on a very long page — is
recorded there and the observation is otherwise returned intact. Nothing in this
path may throw out of `measure()`: a browser problem is ours, and S-06's whole
render half is built on not reporting ours as theirs.

#### 3. Writing the bytes

**File**: `src/server/crawl/run.ts`

**Intent**: Insert each snapshot as it is taken, so memory stays flat across the
loop.

**Contract**: `execute()` supplies the `onCapture` sink, inserting one
`pageSnapshots` row per captured page with the viewport, PNG dimensions, byte
size and the mask list in force. A page whose capture failed still gets a row,
carrying `captureError` — because "this page could not be photographed" and "this
page was not watched" are different facts and a reader shown neither would assume
the second. After the run's findings are written, call `expireSnapshots`.

#### 4. Tests

**File**: `src/server/crawl/render.integration.test.ts`,
`src/server/crawl/run.test.ts`

**Contract**: Against the existing local fixture site: a capture produces a PNG
whose width matches the pinned viewport; a masked selector leaves that region a
flat block rather than the underlying content; an unmatched selector masks
nothing and does not throw; an invalid selector records `snapshotError` and the
run still reaches `done`; a run with no `snapshot` option writes no snapshot rows
and behaves exactly as it did before. A run-level case asserting bytes land in
`pageSnapshots` and that `expireSnapshots` ran.

### Success Criteria

#### Automated Verification

- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- A failing screenshot records `snapshotError` and the run still reaches `done`
- A run without the snapshot option writes no `pageSnapshots` rows

#### Manual Verification

- A captured PNG opened by hand looks like the page, full length, with masked regions blanked
- Lazy-loaded images below the fold are present in the capture
- The run-duration delta from adding capture is measured and acceptable

---

## Phase 3: Pinning a baseline

### Overview

Promoting a run's snapshots to be the project's baseline, and the consequence
that makes the whole slice work: from then on, the pages a run renders are the
pages the baseline captured.

### Changes Required

#### 1. Pinning

**File**: `src/server/api/routers/project.ts`

**Intent**: Let the user say "this is what the site is supposed to look like".

**Contract**: `pinBaseline` on `tenantProcedure`, taking `{projectId, runId}`. It
verifies the run belongs to that project and that it has at least one snapshot
with an image — pinning a run whose images have expired, or that captured
nothing, must fail with a reason rather than silently producing a baseline
nothing can be compared against. Sets `baselineRunId` and `baselinePinnedAt`.

#### 2. Masks

**File**: `src/server/api/routers/project.ts`

**Intent**: Let the user say which regions never count as changed.

**Contract**: `setMasks` on `tenantProcedure`, taking `{projectId, selectors}`.
Selectors are stored as given and validated only for length and count — an
invalid selector is caught at capture and recorded there, because a selector that
is valid CSS but matches nothing is indistinguishable at this layer from one that
will match, and refusing it here would be us guessing about their markup.

#### 3. The watched set

**File**: `src/server/crawl/sample.ts`, `src/server/crawl/run.ts`

**Intent**: Make the render set stable by reading it rather than re-deriving it.

**Contract**: `run.ts` resolves the render list in one place: when the project has
a `baselineRunId`, the list is the URLs of that run's snapshot rows, joined to
`pages`, ordered by URL and capped at `MAX_RENDERS`; otherwise it is
`chooseRenderSample` as today. `sample.ts` gains nothing but a docblock paragraph
recording that a pinned baseline supersedes it and why — the ranking it applies is
stable only across runs where nothing changed, and navigation changing is one of
the deploys most likely to break a page visually.

A watched URL the later crawl did not reach gets no snapshot row and therefore no
comparison; that page is reported as not captured rather than as unchanged.

#### 4. Tests

**File**: `src/server/api/routers/project.test.ts`,
`src/server/crawl/run.test.ts`

**Contract**: `pinBaseline` rejects a run from another project, rejects a run
from another tenant with the same not-found answer a missing project gets,
rejects a run with no usable snapshot, and succeeds on a good one. `setMasks`
round-trips and is tenant-scoped. A run-level case: after pinning, a second run
renders exactly the baseline's URLs even when inbound-link ranking would have
chosen differently — the property this phase exists for.

### Success Criteria

#### Automated Verification

- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- A run after pinning renders the baseline's URLs, not a re-derived sample
- `pinBaseline` on another tenant's run answers not-found, not forbidden

#### Manual Verification

- Pinning a baseline on a real project and re-running visits the same pages

---

## Phase 4: What differs, and where

### Overview

The comparison itself: pixel differences beyond the renderer's own noise, the
regions they fall in, the finding that reports them, and the narrower refusal
that governs whether a visual finding may be called new or resolved.

### Changes Required

#### 1. The differ

**File**: `src/server/crawl/visual.ts` (new)

**Intent**: Compare two PNGs and say how much of one differs from the other, and
where — reporting measurements only.

**Contract**: `compareSnapshots(baseline, current)` where each side carries the
PNG buffer, its dimensions, its viewport and its mask list. Returns either
`{comparable: false, reason}` — `viewport_differs`, `masks_differ`,
`width_differs`, `missing` — or `{comparable: true, changedPixels, comparedPixels,
regions, heightDelta}`.

Uses `pixelmatch` with `includeAA: false`, so the renderer's own anti-aliasing is
excluded by the library's published heuristic rather than by a threshold we
invented. Heights that differ are compared over the overlapping top region with
`heightDelta` reported as evidence; widths that differ refuse, since at a pinned
viewport they cannot legitimately.

`regions` are derived by marking a coarse cell grid wherever a changed pixel
falls, merging adjacent marked cells, and capping the result — export
`MAX_REGIONS = 8`, and where more exist report the largest and say the count was
capped. Deterministic: two runs over the same pair produce identical regions.

**Dependency**: `pixelmatch` and `pngjs`, both pure JavaScript. Worth recording:
this adds **no** native build requirement, so F-02's container gains nothing
beyond the Chromium S-06 already forced on it.

#### 2. The finding

**File**: `src/server/crawl/findings.ts`

**Intent**: Report a page that no longer looks like its baseline.

**Contract**: `FINDING_TYPES.VISUAL_CHANGED = "visual_changed"`, page-level, with
detail carrying `changedPixels`, `comparedPixels`, `share`, `regions`,
`heightDelta`, `baselineRunId` and the baseline's date. The rule is silent when
there is no baseline, when either side has no image, and when the pair refused —
each of those is a fact about us, and `lessons.md` rule 1 puts them out of scope
for a finding about their site. Silence in those cases is what the visual section
in Phase 5 exists to explain.

#### 3. Wiring it into the run

**File**: `src/server/crawl/run.ts`

**Intent**: Do the comparison where every other rule is evaluated — at run close,
producing rows — rather than at read time.

**Contract**: After the snapshots are written, load the baseline run's snapshot
rows keyed by page URL, compare each watched page's pair, feed the results into
detection, and write `visualSummary` on the run alongside `renderSummary`. A
project with no baseline records `visualSummary` with `baselineRunId: null` and
zero compared, which is a recorded fact rather than a missing one.

#### 4. Visual comparability

**File**: `src/server/crawl/comparison.ts`

**Intent**: Prevent a re-baseline from reading as the site changing, without
letting it suppress the rest of the comparison.

**Contract**: A new exported `visualComparability(previous, current)` beside
`comparability()`, returning `not_recorded` (either run has no `visualSummary`),
`baseline_changed` (the two runs were compared against different baselines), or
comparable. `comparability()` itself is **not touched**: it governs the whole-run
comparison and a baseline moving says nothing about the hreflang findings. Where
`visualComparability` refuses, visual findings render without new/resolved marks
and the section says why.

The reasoning belongs in the docblock, because it is the fourth `lessons.md`
entry in a new costume: a re-baseline is *our* state changing, and reporting it
as the site changing is the same error as reporting a newly shipped rule that
way.

#### 5. Tests

**File**: `src/server/crawl/visual.test.ts` (new),
`src/server/crawl/findings.test.ts`, `src/server/crawl/comparison.test.ts`

**Contract**: Differ cases on synthetic PNGs — identical images produce zero
changed pixels; a single changed block produces one region containing it; a
changed region larger than the cap reports the largest and says it capped;
mismatched viewports, mismatched masks and mismatched widths each refuse with
their own reason; a taller current image compares the overlap and reports the
delta. Finding cases: silent with no baseline, silent when either image is
missing, silent on a refused pair, and firing with the counts it was given.
Comparability cases: same baseline is comparable, different baselines refuse,
a missing summary on either side is `not_recorded`. Add `visual.test.ts` to
`vitest.unit.config.ts`'s `include` list.

### Success Criteria

#### Automated Verification

- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- Identical images produce zero changed pixels and no finding
- `comparability()`'s existing behaviour is unchanged, proven by its existing tests still passing untouched
- Two runs over the same snapshot pair produce identical regions

#### Manual Verification

- On a real project, an unchanged page between two runs reports no visual difference

---

## Phase 5: Showing it

### Overview

The review surface. Side by side, a diff overlay on demand, and a section that
says how much of the site it describes — plus the one new HTTP surface in the
product, which has to re-establish tenant ownership on its own.

### Changes Required

#### 1. Serving an image

**File**: `src/app/api/snapshots/[snapshotId]/route.ts` (new)

**Intent**: Get a stored PNG to the browser, which tRPC cannot do.

**Contract**: `GET` with a `view` query parameter — `current` (default),
`baseline`, or `diff`. It resolves the session, then loads the snapshot **joined
through its run to the tenant**, and answers 404 when the row belongs to another
tenant — the same indistinguishability the project page relies on, for the same
reason. `diff` loads both images, re-runs `compareSnapshots`, and returns the
highlighted PNG rather than reading a stored one. Responses are
`Cache-Control: private, no-store`.

This is a surface a result can appear on, and NFR-2 is a binary commitment: it
gets its own case in `tenant-isolation.test.ts`, not just a code review.

#### 2. What the section says about itself

**File**: `src/app/(app)/projects/[id]/visual.ts` (new)

**Intent**: The pure presentation logic, in the sibling-module pattern
`performance.ts`, `parity.ts` and `trend.ts` already follow.

**Contract**: `visualState(summary, rows)` returning a union — `not_recorded`,
`no_baseline`, `unavailable`, `nothing_watched`, and
`{kind: "compared", coverage}`. `no_baseline` is the state this section will
spend most of its life in and is neither a pass nor a failure; it says what to do
next. The coverage sentence follows `performanceState`'s rule exactly: never "no
problems found" on a section that looked at twelve pages of five hundred. Plus
ordering — most-changed first, pages that could not be captured before pages that
merely differ, because a page we failed to photograph is the one fact the reader
cannot get elsewhere.

#### 3. The panel

**File**: `src/app/(app)/projects/[id]/visual-panel.tsx` (new)

**Intent**: Review a difference.

**Contract**: One row per watched page showing its state and, where compared, the
changed-pixel count and share. Expanding shows baseline and current side by side
with a toggle for the diff overlay, each an `img` pointing at the route above.
The bounding boxes are drawn over the current image so "where" is visible without
loading the overlay.

Named `visual-panel.tsx`, not `visual.tsx`, so the component and its logic module
do not collide — S-06 hit exactly that import ambiguity and resolved it by
renaming.

**It must not restate the finding's sentence.** The finding says the page
changed; the panel shows the evidence and the numbers. Two sections agreeing
verbatim reads as a bug in the page, which is precisely what S-06's real-site
reading caught between the trend and the comparison refusal.

#### 4. Wiring and labels

**File**: `src/app/(app)/projects/[id]/run-panel.tsx`,
`src/app/(app)/projects/[id]/finding-labels.ts`,
`src/server/api/routers/project.ts`

**Intent**: Put the section on the page and give the new finding a reader-facing
label.

**Contract**: A `runSnapshots` procedure returning the watched pages' snapshot
metadata — never the `image` column — joined to their comparison results, with
the run's `visualSummary` travelling alongside for the reason `runObservations`
carries `renderSummary`. The section renders below the performance table. A
`FINDING_LABEL` entry for `visual_changed`. Controls for pinning a baseline and
editing masks live with the section, since that is where a reader learns they
need one.

#### 5. Tests

**File**: `src/app/(app)/projects/[id]/visual.test.ts` (new),
`src/server/api/tenant-isolation.test.ts`, `e2e/journeys/`

**Contract**: State cases for each union member, including the coverage sentence
under a partial capture and the never-"no problems" property. An isolation case
asserting a snapshot route request for another tenant's id answers 404. An e2e
journey covering pin-then-compare, asserting on the settled state and waiting for
the query that settles it — `lessons.md` rule 3.

### Success Criteria

#### Automated Verification

- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- Existing e2e journeys pass: `npm run test:e2e`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- Production build succeeds: `npm run build`
- Every `FINDING_TYPES` entry still has a reader-facing label
- A snapshot route request for another tenant's snapshot answers 404
- No query path selects the `image` column into a list view

#### Manual Verification

- A project with no baseline reads as needing one, not as having no problems
- Baseline and current render side by side and the overlay marks the real difference
- The section says how much of the site it describes
- The finding and the panel do not print the same sentence
- The rest of the project page is unchanged

---

## Phase 6: Real-site proof and honest recording

### Overview

The slice read by hand against a real client project, and the requirement
bookkeeping written down. The headline question is not whether a changed page is
caught — it is whether an **unchanged** site produces a clean comparison, because
if our own renderer is the noise source then every number this slice reports is
ours rather than theirs.

### Changes Required

#### 1. The proof

**File**: `context/changes/visual-regression-baselines/proof.md` (new)

**Intent**: Record what a real site actually did, including anything that turned
out wrong.

**Contract**: Against tecalliance (the project S-06 and S-12 both used): pin a
baseline, run again with nothing deployed in between, and record the differing
page count. Also record the run-duration delta from adding capture, the bytes
stored per page and per project, a page deliberately changed and correctly
caught, and a masked region proving it suppresses what it should. Any bug found
by reading it is recorded as S-06's proof recorded its three.

If an unchanged site does *not* compare clean, the number that survives
`includeAA: false` is the measurement that decides whether a floor is needed —
and any floor is then derived from that measurement and stated, never guessed in
advance.

#### 2. The bookkeeping

**File**: `context/foundation/roadmap.md`

**Intent**: Record which requirements this slice met and which it did not, in the
slice's own PRD-refs block.

**Contract**: FR-032, FR-033, FR-034 and FR-035 recorded as met. **FR-031
recorded as partly met**, with the reason: snapshots are captured for a bounded
watched set rather than for each page, because per-page capture is the cost the
PRD already rejected under FR-028 and the storage line item it flagged during
shaping. Also record that F-02's constraint did **not** grow — `pixelmatch` and
`pngjs` are pure JavaScript, so the container still needs only Chromium.

#### 3. Cleanup

**Contract**: No temporary scripts, fixtures or harnesses left in the working
tree.

### Success Criteria

#### Automated Verification

- Whole suite passes: `npm run test:all`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- No temporary scripts or harnesses remain in the working tree

#### Manual Verification

- Two runs of an unchanged real site report no differing pages
- A deliberately changed page is caught, and the regions point at what changed
- A masked region suppresses a difference that would otherwise report
- The run-duration and storage deltas on a real project are recorded and acceptable
- The roadmap records FR-031 partly met, FR-032 to FR-035 met, and that F-02 gained no new constraint

---

## Testing Strategy

### Unit Tests

- `runsToExpire` across the window, baseline-inside, baseline-outside and empty cases
- `compareSnapshots` on synthetic PNGs: identical, one changed block, region capping, each refusal reason, height delta
- `visualComparability` across same, different and unrecorded baselines
- `visualState` across all five union members, including the coverage sentence
- The `visual_changed` rule staying silent on every fact-about-us case

### Integration Tests

- `expireSnapshots` updating rather than deleting, idempotent, tenant-scoped
- Snapshot rows landing from a run against the local fixture site, with masks applied
- A run after pinning rendering the baseline's URLs rather than a re-derived sample
- `pinBaseline` and `setMasks` tenant scoping, with cross-tenant answering not-found
- The snapshot route answering 404 across tenants

### Manual Testing Steps

1. Run a real project, confirm snapshots are captured and look like the pages.
2. Pin the run as baseline; confirm the watched set is recorded.
3. Re-run with nothing changed; confirm no differing pages.
4. Change something on a page; confirm it is caught and the regions are right.
5. Mask the changed region; confirm it stops reporting.
6. Confirm the section reads correctly with no baseline pinned.

## Performance Considerations

Capture adds work to a pass that already costs 4–6s per page: a scroll sweep, a
full-page encode, and an insert. The bound is unchanged — `MAX_RENDERS = 12`, and
the watched set is capped by it — so the worst case is a bounded increment on an
already-bounded pass, and Phase 6 measures it rather than assuming it.

Diffing is the new cost and is pure JavaScript. Twelve full-page comparisons at a
1280px width is seconds, not minutes, and it happens once per run at close.

Storage is the constraint the PRD singled out. At twelve watched pages, four
retained sets (baseline plus three runs) and ten projects, a 500KB–2MB page puts
the footprint in the tens to low hundreds of megabytes — the number Phase 6
measures for real. The `image` column must never appear in a list query.

## Migration Notes

Schema changes go through `npm run db:push`; there is no `drizzle/` migrations
directory. Every new column is nullable and every new table is additive, so
existing runs keep working and read as *not recorded* rather than as having
watched nothing. The first run after this ships changes `runs.ruleSet`, so the
first comparison across the deploy will correctly refuse with `rules_changed` —
expected, and verified rather than assumed in Phase 6.

## References

- Research: `context/changes/visual-regression-baselines/research.md`
- Prior slice this builds directly on:
  `context/archive/2026-09-05-browser-observed-checks/` — its `proof.md` carries
  the 4–6s per render measurement this plan's scope decision rests on
- The comparison model extended here: `src/server/crawl/comparison.ts:78`
- The absence-as-representation precedent: `src/server/db/schema.ts:407`
- The coverage-sentence precedent: `src/app/(app)/projects/[id]/performance.ts:85`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Where a snapshot lives

#### Automated

- [x] 1.1 Schema applies cleanly: `npm run db:push` — 0bce206
- [x] 1.2 Unit tests pass: `npm run test:unit` — 0bce206
- [x] 1.3 Integration tests pass: `npm run test:integration` — 0bce206
- [x] 1.4 Type checking passes: `npm run typecheck` — 0bce206
- [x] 1.5 Lint and format pass: `npm run check` — 0bce206
- [x] 1.6 `expireSnapshots` updates rows and deletes none, proven by row count before and after — 0bce206

#### Manual

- [ ] 1.7 A project with no baseline reads as having none, rather than as an error

### Phase 2: What a snapshot is a picture of

#### Automated

- [x] 2.1 Unit tests pass: `npm run test:unit` — 59927ff
- [x] 2.2 Integration tests pass: `npm run test:integration` — 59927ff
- [x] 2.3 Type checking passes: `npm run typecheck` — 59927ff
- [x] 2.4 Lint and format pass: `npm run check` — 59927ff
- [x] 2.5 A failing screenshot records `snapshotError` and the run still reaches `done` — 59927ff
- [x] 2.6 A run without the snapshot option writes no `pageSnapshots` rows — 59927ff

#### Manual

- [ ] 2.7 A captured PNG opened by hand looks like the page, full length, with masked regions blanked
- [ ] 2.8 Lazy-loaded images below the fold are present in the capture
- [ ] 2.9 The run-duration delta from adding capture is measured and acceptable

### Phase 3: Pinning a baseline

#### Automated

- [x] 3.1 Unit tests pass: `npm run test:unit` — e8708ac
- [x] 3.2 Integration tests pass: `npm run test:integration` — e8708ac
- [x] 3.3 Type checking passes: `npm run typecheck` — e8708ac
- [x] 3.4 Lint and format pass: `npm run check` — e8708ac
- [x] 3.5 A run after pinning renders the baseline's URLs, not a re-derived sample — e8708ac
- [x] 3.6 `pinBaseline` on another tenant's run answers not-found, not forbidden — e8708ac

#### Manual

- [ ] 3.7 Pinning a baseline on a real project and re-running visits the same pages

### Phase 4: What differs, and where

#### Automated

- [x] 4.1 Unit tests pass: `npm run test:unit`
- [x] 4.2 Integration tests pass: `npm run test:integration`
- [x] 4.3 Type checking passes: `npm run typecheck`
- [x] 4.4 Lint and format pass: `npm run check`
- [x] 4.5 Identical images produce zero changed pixels and no finding
- [x] 4.6 `comparability()`'s existing behaviour is unchanged, proven by its existing tests still passing untouched
- [x] 4.7 Two runs over the same snapshot pair produce identical regions

#### Manual

- [ ] 4.8 On a real project, an unchanged page between two runs reports no visual difference

### Phase 5: Showing it

#### Automated

- [ ] 5.1 Unit tests pass: `npm run test:unit`
- [ ] 5.2 Integration tests pass: `npm run test:integration`
- [ ] 5.3 Existing e2e journeys pass: `npm run test:e2e`
- [ ] 5.4 Type checking passes: `npm run typecheck`
- [ ] 5.5 Lint and format pass: `npm run check`
- [ ] 5.6 Production build succeeds: `npm run build`
- [ ] 5.7 Every `FINDING_TYPES` entry still has a reader-facing label
- [ ] 5.8 A snapshot route request for another tenant's snapshot answers 404
- [ ] 5.9 No query path selects the `image` column into a list view

#### Manual

- [ ] 5.10 A project with no baseline reads as needing one, not as having no problems
- [ ] 5.11 Baseline and current render side by side and the overlay marks the real difference
- [ ] 5.12 The section says how much of the site it describes
- [ ] 5.13 The finding and the panel do not print the same sentence
- [ ] 5.14 The rest of the project page is unchanged

### Phase 6: Real-site proof and honest recording

#### Automated

- [ ] 6.1 Whole suite passes: `npm run test:all`
- [ ] 6.2 Type checking passes: `npm run typecheck`
- [ ] 6.3 Lint and format pass: `npm run check`
- [ ] 6.4 No temporary scripts or harnesses remain in the working tree

#### Manual

- [ ] 6.5 Two runs of an unchanged real site report no differing pages
- [ ] 6.6 A deliberately changed page is caught, and the regions point at what changed
- [ ] 6.7 A masked region suppresses a difference that would otherwise report
- [ ] 6.8 The run-duration and storage deltas on a real project are recorded and acceptable
- [ ] 6.9 The roadmap records FR-031 partly met, FR-032 to FR-035 met, and that F-02 gained no new constraint
