# Client-readable report (S-11) Implementation Plan

## Overview

Make the product state what it actually checked — at run level, in two registers — and let that
statement leave the app as a printable report a non-technical client contact can read.

The frame brief established that producing an artifact is the cheap half. The unaddressed half is
that a run which stopped at the page ceiling currently reads "Complete", silences rules across 24
gates, and would therefore produce a *shorter, cleaner-looking* report. This plan fixes that first,
then builds the artifact on top of it.

## Current State Analysis

Lifted from `context/changes/client-readable-report/frame.md` and `research.md`; not re-derived.

- **A ceiling-hit run is indistinguishable from a complete one.** `run.ts:594` sets status `DONE`
  unless `abortedReason` is set, which a ceiling hit does not set. `STATUS_LABEL.done` is the
  literal string `"Complete"` (`run-panel.tsx:37`). Meanwhile `run.ts:290` computes
  `crawlComplete = abortedReason === null && !reachedPageLimit`, which suppresses findings across 24
  `crawlComplete` gates in `findings.ts` — including the north-star `missing_locale` (`findings.ts:350`).
- **`reachedPageLimit` has no reader-facing surface.** Verified: zero references in any `.tsx` file.
  The only signal is the `Stat` tile "Pages crawled: 2000" (`run-panel.tsx:361`), which reads as an
  achievement.
- **Coverage disclosure exists, but only for the sampled subsystems and only sectionally.**
  `performance.ts:78-83` and `visual.ts:11-16` both refuse to say "no problems found" without stating
  coverage, and say why in comments. The crawl never got the same treatment because `crawlComplete`
  and `reachedPageLimit` were added to serve `comparability()` (`comparison.ts:78-127`), which needs a
  *pair* of runs. A single-run artifact has no pair.
- **The vocabulary splits in two tiers.** Type labels are already central and near-lay
  (`finding-labels.ts:9-40`). The technical register lives in an 845-line, 29-case inline-JSX switch
  (`run-panel.tsx:944-1789`) whose default case prints raw JSON at the reader (`:1783`).
- **There is an established pattern for pure view-state modules.** `performanceState()`
  (`performance.ts:85`) and `visualState()` (`visual.ts:123`) return discriminated state objects from
  raw run data; panels render them. `describeVisualChange` (`visual.ts:266`) and `REASON_SENTENCE`
  (`comparison-view.ts:31`) are the precedent for extracting sentence logic — `visual.ts:255-258`
  records the bug that motivated it.
- **Neither stated prerequisite binds.** S-09 supplies grouping, not explanation; S-10's
  `assertProjectAccess` is a no-op on the Owner path. Both bind only if the report becomes a route
  that a *client* opens — which this plan does not build.

### Key Discoveries

- `run-history.tsx` receives `statusLabel={STATUS_LABEL}` as a prop (`run-panel.tsx:387`), so any
  move from a status-keyed map to a run-derived label changes that prop contract too.
- `partial-account.spec.ts:22-59` discovers `(app)` routes on the filesystem and generates a test per
  route with placeholder UUIDs — a new report route is auto-enrolled and must explain itself to a
  tenantless account rather than 5xx.
- `tenant-isolation.test.ts:415-430` enumerates tRPC procedures. This plan adds **no** procedure, so
  that guard is not triggered.
- `BAND_STYLE` (`performance-table.tsx:55-60`) signals good/needs-improvement/poor by colour alone,
  same glyph and format — the only signal in the app with no shape fallback. It is unreadable in
  grayscale.
- All eight view modules under `src/app/(app)/projects/[id]/` are framework-free and unit-tested;
  new pure modules belong there and follow that convention.

## Desired End State

A signed-in user opening a run sees a plain statement of what the check covered, and a run that
stopped early says so where it is most read. From that run they can open a report view written in a
second register, print it, and hand the PDF to a client contact — with the coverage statement
carried into it, so the artifact cannot overstate what was checked.

Verified by: the coverage module's unit tests; an exhaustiveness test proving every finding type has
a client label and sentence; the auto-enrolled tenantless-account route test; and a manual print to
PDF, read in grayscale.

## What We're NOT Doing

- **No severity, priority, ranking or confidence dimension.** Explicitly excluded.
- **No correlated-problem explanation layer.** The three abstract sentences stay as they are; naming
  a defect the site never asserted is the thing `run-panel.tsx:666-670` refuses to do.
- **No refactor of the 845-line `Evidence` switch.** The report gets its own sentences; the operator
  view is untouched.
- **No PDF pipeline, no tokenised link, no standalone HTML generator, no new env var.** Delivery is
  the browser's own print.
- **No new tRPC procedure and no schema change.** Every column this plan reads already exists.
- **No change to run status values or to `comparability()`.** The badge label is derived; the status
  enum is left alone.
- **No fix for the read-time reproducibility of correlation and comparison.** Acknowledged as a
  standing property; see Open Risks in the brief.

## Implementation Approach

Three phases, in dependency order. Phase 1 is a correctness fix to the operator view and stands on
its own. Phase 2 adds a parallel vocabulary with no consumer yet. Phase 3 assembles both into a
route that renders its own tree — which is what makes "expand the figures" and "lift the display
caps" fall out for free rather than requiring surgery on `visual-panel.tsx`.

The report is a route under `src/app/(app)/` reusing existing procedures, so it inherits the session
and tenant gate structurally (`layout.tsx:11-13`) and `assertProjectAccess` continues to enforce
project reachability with no new authorization code.

## Critical Implementation Details

**Ordering within Phase 1.** `crawlComplete` is nullable and `null` means *not recorded* — a run from
before the column existed, or one that died before the closing UPDATE (`run.ts:591-662`). The
coverage module must treat `null` as "we do not know", never as `false`, and never as `true`. The
same holds for `reachedPageLimit`, `ruleSet`, `renderSummary` and `visualSummary`. This is the single
place where a wrong default silently produces the exact overstatement this plan exists to prevent.

**The two vocabularies must be provably in sync.** The user chose report-only sentences over a shared
renderer, which accepts drift risk in exchange for leaving the operator view alone. A test that
enumerates `FINDING_TYPES` and asserts every key has both a client label and a client sentence is
what makes that trade safe — model it on `roles.test.ts:31`, which iterates `USER_ROLES`.

---

## Phase 1: Run coverage statement

### Overview

Derive a run-level coverage model from columns that already exist, render it on the results page, and
stop a truncated run from reading "Complete".

### Changes Required:

#### 1. Coverage model

**File**: `src/app/(app)/projects/[id]/coverage.ts` (new)

**Intent**: A framework-free module that turns a run row into a discriminated coverage state plus
operator-register sentences, so that both the results page and later the report render from one
computation rather than each deriving its own.

**Contract**: Exports a `RunCoverage` type and `runCoverage(run)` returning it, alongside
`coverageSentences(coverage)` returning the operator-register strings. Follows the shape of
`performanceState()` (`performance.ts:85`) and `visualState()` (`visual.ts:123`). Reads only
`crawlComplete`, `reachedPageLimit`, `scope`, `ruleSet`, `renderSummary`, `visualSummary`,
`pagesCrawled` and `status`. Every nullable input has a distinct "not recorded" state that is neither
the complete nor the incomplete branch.

#### 2. Run-derived status label

**File**: `src/app/(app)/projects/[id]/run-panel.tsx`

**Intent**: Make the badge tell the truth about a run that stopped at the page ceiling, without
touching run status semantics.

**Contract**: `STATUS_LABEL` stops being the direct source of badge text; a function derives the
label from status plus completeness. `STATUS_STYLE` keeps its existing meaning — a truncated run is
not an error and must not take the `failed` treatment. The `statusLabel` prop passed to
`RunHistory` (`run-panel.tsx:387`) changes from a `Record` to whatever the derivation exposes;
`run-history.tsx:69-99` is updated to match.

#### 3. Coverage block on the results page

**File**: `src/app/(app)/projects/[id]/run-panel.tsx`

**Intent**: Render the coverage statement near the run summary, so a reader learns what was covered
before they read what was found.

**Contract**: A new block rendered from `coverageSentences()`, placed with the `Stat` row
(`run-panel.tsx:360-373`) and above the findings. Uses the existing notice styling
(`border-l-2` + tinted background) rather than introducing a new visual idiom. Renders nothing when
coverage is complete and fully recorded — a clean run should not be made to look qualified.

#### 4. Tests

**File**: `src/app/(app)/projects/[id]/coverage.test.ts` (new)

**Intent**: Pin the three-state nullability behaviour, which is where this phase can silently fail.

**Contract**: Covers each condition separately and in combination: ceiling hit, aborted crawl,
narrowed scope, partial render sample, partial visual watched set, and `null` on each column. Asserts
that a fully complete run produces no sentences, and that `null` never renders as either "complete"
or "incomplete".

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`
- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- New coverage module has tests covering every nullable column's not-recorded state

#### Manual Verification:

- A run that hit the page ceiling no longer reads "Complete" in the badge
- A clean, fully-recorded run shows no coverage block at all
- The coverage block reads as a statement about the check, not as an error

**Implementation Note**: After completing this phase and all automated verification passes, pause for
manual confirmation before proceeding.

---

## Phase 2: Client vocabulary

### Overview

A parallel, testable second register — client labels and one plain-English sentence per finding type,
plus a client-register rendering of the same coverage model. No consumer yet; no change to the
operator view.

### Changes Required:

#### 1. Client vocabulary module

**File**: `src/app/(app)/projects/[id]/client-vocabulary.ts` (new)

**Intent**: Give every finding type a label and a single sentence written for someone who does not
read HTTP status codes, so the report never renders the operator's `Evidence` output.

**Contract**: Exports `CLIENT_LABEL: Record<string, string>` mirroring the key set of
`FINDING_LABEL` (`finding-labels.ts:9-40`), and `clientSentence(finding)` returning one string per
finding, derived from the finding's `detail` payload. No status codes, header names, `canonical`,
`hreflang`, `robots.txt`, or pixel geometry in any output string. Where a count or a denominator is
already carried in `detail`, it is used — the payloads are rich enough without a re-crawl. Follows
the extraction precedent of `describeVisualChange` (`visual.ts:266`).

#### 2. Client-register coverage sentences

**File**: `src/app/(app)/projects/[id]/coverage.ts`

**Intent**: The same coverage facts said in the client's register, because the existing disclosures
are written for a customer *of the tool* ("No browser was available during this run") and are
meaningless or alarming to a client contact.

**Contract**: Adds `clientCoverageSentences(coverage)` beside the operator variant, reading the same
`RunCoverage` value. No change to `runCoverage()` itself.

#### 3. Tests

**File**: `src/app/(app)/projects/[id]/client-vocabulary.test.ts` (new)

**Intent**: Make the two-vocabulary trade safe by proving there is no gap, and guard the register.

**Contract**: Iterates `FINDING_TYPES` (`findings.ts:30-99`) and asserts every type has a
`CLIENT_LABEL` entry and produces a non-empty `clientSentence`, so adding a detection rule fails this
test until it is worded — modelled on `roles.test.ts:31`. A second test asserts no output string
matches a banned-jargon list (status codes, `hreflang`, `canonical`, `robots.txt`, header names).

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`
- Unit tests pass: `npm run test:unit`
- Every `FINDING_TYPES` key has a client label and a non-empty client sentence
- No client-facing string contains banned jargon

#### Manual Verification:

- Reading the 29 sentences end to end, they sound like one voice rather than 29 rewrites
- A non-technical reader could act on, or at least understand, each one

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 3: Report view

### Overview

A route under `(app)` that assembles phases 1 and 2 into a printable document, plus the print
stylesheet.

### Changes Required:

#### 1. Report route

**File**: `src/app/(app)/projects/[id]/report/[runId]/page.tsx` (new)

**Intent**: A run-scoped report page inside the authenticated route group, so the session and tenant
gate is structural and no new authorization code is written.

**Contract**: Server component mirroring `projects/[id]/page.tsx:28-33` — resolves the account and
calls existing procedures; project reachability is enforced by `assertProjectAccess` inside them. Adds
no tRPC procedure. Must render an explanation rather than 5xx for a tenantless account, because
`partial-account.spec.ts:22-59` will auto-enrol it.

#### 2. Report view

**File**: `src/app/(app)/projects/[id]/report-view.tsx` (new)

**Intent**: Render the report's own tree using the client vocabulary, which is what makes expanded
figures and un-capped lists fall out naturally instead of requiring changes to `visual-panel.tsx`.

**Contract**: Renders from the same procedures the results page uses (`findings`, `runPages`,
`comparison`, `runObservations`, `runSnapshots`). Applies no display caps — deliberately not using
`summariseList` (`summarise.ts:38`). Renders snapshot figures open, sourced from the existing
`/api/snapshots/[snapshotId]` route. Includes the resolved / no-longer-reported section. Carries the
client coverage sentences at the top. Renders no operator chrome: no action buttons, no run-history
selector, no mask configuration, no crawl pacing or include/exclude paths.

#### 3. Entry point from the results page

**File**: `src/app/(app)/projects/[id]/run-panel.tsx`

**Intent**: Make the report reachable from the run it describes.

**Contract**: A link to the report route for the selected run, placed in the control row
(`run-panel.tsx:330-350`). Visible per the same role convention the existing controls use — reading a
report requires only project access, so it is not gated on `canRunChecks`.

#### 4. Print stylesheet

**File**: `src/styles/globals.css`

**Intent**: Make the report survive contact with paper, where hover does not exist, backgrounds are
dropped and content is cut into pages.

**Contract**: A `@media print` block appended to the existing global stylesheet (already imported at
`layout.tsx:1`). Covers: `break-inside: avoid` on findings, problem articles and figures;
`break-after: avoid` on section headings; neutralised `overflow-x-auto` + `min-w` wrappers so tables
reflow rather than clip; expanded truncated URL cells; and a non-colour carrier for the
`BAND_STYLE` performance verdict (`performance-table.tsx:55-60`), which is otherwise lost in
grayscale.

#### 5. E2E journey

**File**: `e2e/journeys/client-report.spec.ts` (new)

**Intent**: Prove the report renders for a user with project access and carries the coverage
statement.

**Contract**: Follows the existing journey conventions — role-appropriate locators
(`getByRole`/`getByText`), no `waitForTimeout`, unique ids per run, own setup and cleanup. Asserts
the report reaches a settled state and that a truncated run's report states its coverage.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`
- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- E2E suite passes, including the auto-enrolled tenantless-account route test: `npm run test:e2e`

#### Manual Verification:

- Printing the report to PDF produces a document with no clipped tables and no findings split across
  a page break mid-row
- Snapshot images appear in the PDF
- The performance verdict is readable when the PDF is viewed in grayscale
- No operator chrome, dead buttons or crawl configuration appears in the printed output
- A truncated run's report states what was not covered, in client register

---

## Testing Strategy

### Unit Tests:

- `coverage.ts`: each provisional condition alone and combined; `null` handled as not-recorded on
  every nullable column; a fully complete run yields no sentences
- `client-vocabulary.ts`: exhaustive over `FINDING_TYPES`; banned-jargon guard

### Integration Tests:

- Existing suites must stay green; this plan adds no procedure and no schema change, so
  `tenant-isolation.test.ts` and `within-tenant-access.test.ts` should be unaffected — if either
  fails, something was added that the plan did not intend

### Manual Testing Steps:

1. Open a run that hit the page ceiling; confirm the badge no longer reads "Complete"
2. Open a clean run; confirm no coverage block appears
3. Open the report for both runs; confirm the client register reads as one voice
4. Print each to PDF; check page breaks, table clipping, images and grayscale legibility
5. Confirm no crawl configuration or dead control appears in either PDF

## Performance Considerations

The report reuses existing procedures and adds no query. The one new cost is that it lifts the
display caps, so a large run renders more rows than the results page does — acceptable for a
document that is read once and printed, and bounded by the run's own size.

## Migration Notes

None. No schema change, no data migration. Runs predating the provenance columns render as
"not recorded", which is the correct and intended reading.

## References

- Frame brief: `context/changes/client-readable-report/frame.md`
- Related research: `context/changes/client-readable-report/research.md`
- Pure view-state precedent: `src/app/(app)/projects/[id]/performance.ts:85`,
  `src/app/(app)/projects/[id]/visual.ts:123`
- Sentence-extraction precedent: `src/app/(app)/projects/[id]/visual.ts:266`,
  `src/app/(app)/projects/[id]/comparison-view.ts:31`
- Exhaustiveness-test precedent: `src/server/auth/roles.test.ts:31`
- Route-group convention: `src/app/(app)/layout.tsx:11-13`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Run coverage statement

#### Automated

- [x] 1.1 Type checking passes: `npm run typecheck` — 9e468cc
- [x] 1.2 Linting passes: `npm run check` — 9e468cc
- [x] 1.3 Unit tests pass: `npm run test:unit` — 9e468cc
- [x] 1.4 Integration tests pass: `npm run test:integration` — 9e468cc
- [x] 1.5 New coverage module has tests covering every nullable column's not-recorded state — 9e468cc

#### Manual

- [x] 1.6 A run that hit the page ceiling no longer reads "Complete" in the badge — verified 2026-09-13, reads "Stopped at page limit"
- [x] 1.7 A clean, fully-recorded run shows no coverage block at all — 9e468cc
- [x] 1.8 The coverage block reads as a statement about the check, not as an error — 9e468cc

### Phase 2: Client vocabulary

#### Automated

- [x] 2.1 Type checking passes: `npm run typecheck` — baf745f
- [x] 2.2 Linting passes: `npm run check` — baf745f
- [x] 2.3 Unit tests pass: `npm run test:unit` — baf745f
- [x] 2.4 Every `FINDING_TYPES` key has a client label and a non-empty client sentence — baf745f
- [x] 2.5 No client-facing string contains banned jargon — baf745f

#### Manual

- [x] 2.6 Reading the 29 sentences end to end, they sound like one voice — verified 2026-09-13 after D-2 fixed
- [x] 2.7 A non-technical reader could understand each one — verified 2026-09-13

### Phase 3: Report view

#### Automated

- [x] 3.1 Type checking passes: `npm run typecheck` — 951d093
- [x] 3.2 Linting passes: `npm run check` — 951d093
- [x] 3.3 Unit tests pass: `npm run test:unit` — 951d093
- [x] 3.4 Integration tests pass: `npm run test:integration` — 951d093
- [x] 3.5 E2E suite passes, including the auto-enrolled tenantless-account route test: `npm run test:e2e` — 951d093

#### Manual

- [x] 3.6 PDF has no clipped tables and no findings split mid-row across a page break — verified 2026-09-13 after D-1 fixed
- [x] 3.7 Snapshot images appear in the PDF — verified 2026-09-13, baseline + current, unclipped
- [x] 3.8 The performance verdict is readable in grayscale — verified 2026-09-13 (glyph carrier; the report itself carries no performance table)
- [x] 3.9 No operator chrome, dead buttons or crawl configuration in the printed output — verified 2026-09-13
- [x] 3.10 A truncated run's report states what was not covered, in client register — verified 2026-09-13

## Defects found and fixed

Found during the manual verification pass on 2026-09-13, and fixed in the same
pass. Neither was caught by the automated suite, which is why both survived
phases 1-3 green; the suite asserts that the report renders and carries its
coverage statement, and says nothing about how it paginates or what language its
date is in.

### D-1: near-blank pages in the printed report (blocked 3.6) — fixed

**Symptom.** In a 47-page report for `yazaki`, pages 9, 30 and 42 carry a finding
heading and its `N instances` line and nothing else — the body starts on the next
sheet. Roughly one sheet in fifteen is wasted, and the heading is orphaned from
what it introduces, which is the exact failure `break-after: avoid` was added to
prevent.

**Cause.** `.report-block` carries `break-inside: avoid` and is applied to both the
per-type `<article>` and the per-finding `<li>`. When a finding's `Pages involved`
list runs to hundreds of URLs the block is taller than a sheet, so the browser
first pushes the whole block to a fresh page to honour the rule, then breaks it
anyway because it cannot fit. The push is what empties the preceding page.

**Direction.** `break-inside: avoid` is right for a short finding and wrong for a
long one. Scope it to blocks that can actually fit — e.g. keep it on the `<li>` but
drop it from the `<article>`, and cap or omit it once `Pages involved` exceeds a
page's worth of lines. `break-after: avoid` on the heading should stay.

### D-2: report date renders in the server host's locale (blocked 2.6) — fixed

**Symptom.** The report header reads `Checked 8 września 2026` — a Polish month
name in a document that is otherwise entirely English.

**Cause.** `formatDate` in `report/[runId]/page.tsx` calls
`toLocaleDateString(undefined, …)`. The page is a server component, so `undefined`
resolves to the *server host's* ICU locale, not the reader's and not the report's.
This dev host is `pl-PL`; a container would likely be `en-US`. The rendered date is
therefore both off-register and non-deterministic across environments.

**Direction.** Pin the locale the rest of the report is written in (`en-GB` reads
naturally with the existing `day month year` order). A reader-chosen locale would
need the report's prose to be translated too, which is out of this slice's scope.

### Resolution

**D-1.** `break-inside: avoid` is now asked for only where the browser can grant
it. The print block marks `.report-block` / `.report-line` / `figure` / `tr`
instead of a bare `li`, which had been forcing every finding atomic regardless of
size; the per-type `<article>` no longer claims atomicity at all; and a finding
keeps it only while its address list is at or under `MAX_UNBROKEN_PAGES` (20). A
longer finding is allowed to break, with `.report-lead` on its sentence so the
sentence still meets the reader on the same sheet as the first addresses.

Measured on the `yazaki` report: **47 pages with 3 near-blank → 40 pages with 0**.
Short findings are still kept whole, and the snapshot figures still are.

**D-2.** `formatDate` pins `en-GB` rather than passing `undefined`, which on a
server component resolved to the host's ICU locale. The report now reads
`Checked 4 September 2026` regardless of where it is rendered.

**Verification after the fix:** `npm run typecheck`, `npm run check`,
`npm run test:unit` (802), `npm run test:integration` (122) and
`npm run test:e2e` (23) all pass.

## Implementation review and its fixes

Reviewed 2026-09-13 at `0998faf`; report in `reviews/impl-review.md`. Ten findings,
all triaged and fixed. Three of them change decisions this plan recorded, so they
are written back here rather than left only in the review.

### The plan's own contract, amended

**Speed coverage is no longer stated.** Phase 3 contracted the view to render from
`runObservations` among others. It never did, and it should not: the measurements
are TTFB, LCP and CLS, and Phase 2 deliberately built no client sentence for them —
`client-vocabulary.test.ts` bans the terms outright. But `clientCoverageSentences`
went on saying "Speed and loading errors were measured on N of M pages", qualifying
a section that never arrives. A reader told speed was looked at, and then never told
what was found, cannot tell a clean result from a missing one.

So the sample-coverage sentences are gone from the client register. `runObservations`
is struck from Phase 3's contract; the operator's `coverageSentences` is unchanged,
because the results page does show the measurements and there the line has something
to qualify.

**The band carrier lives in the component, not the stylesheet.** Phase 3 asked for a
non-colour carrier in the print CSS. It was implemented as a `BAND_MARK` glyph with
`sr-only` text instead, which is better — it works on screen, serves colour-blind and
screen-reader readers, and does not depend on a stylesheet being loaded. The plan
entry is amended to match what shipped. `BAND_MARK`/`BAND_MEANING` now live in
`performance.ts` beside `bandFor`, which is what makes them testable; four tests hold
them.

**`report-view.tsx` was never created, and will not be.** Phase 3 planned the tree as
a separate file. The page is a server component with no client boundary, so the split
would have bought a file and nothing else. Closed as cosmetic drift.

### Defects fixed

- **Expired snapshots printed as broken images** (critical). `differsMeaningfully`
  reads the stored comparison only; retention nulls the bytes and stamps `expiredAt`
  while deliberately keeping the comparison, so an expired row still answered "this
  differs" and the image route answered its every request with a 404. Certain, not
  unlikely, for any run older than the retention window — which is exactly the run a
  handed-over document is re-opened from. Now gated on `uncomparedReason`, as
  `visual-panel.tsx` already was.
- **A superseded baseline was printed as if current.** `view=baseline` resolves
  against the project's baseline *now*, while the verdict beside it came from the one
  in force at run time. The caption now says so when they differ.
- **The route defended none of its own preconditions.** A bookmarked URL rendered a
  report of a still-running crawl; a transient query failure showed Next's unstyled
  error page to a client contact. Now `notFound()` for `queued`/`running`, and an
  `error.tsx` written in the report's own register.
- **No bound of any kind.** The no-caps rule stays — "and 3 more" cannot be expanded
  on paper — but past `MAX_LISTED_PAGES` the report now withdraws the list and says
  it has, rather than attempting it. The snapshot route also stopped reading a
  multi-megabyte blob on the `view=baseline` path that discards it.
- **A redundant findings read and an unreachable fallback.** Every branch of the
  `comparison` procedure returns the run's own findings, so the second query and its
  ternary could only fire when both were already empty.
- **Two page counts for one run.** The header counted distinct URLs from `runPages`
  — every page row of the run, images payload included — while the coverage sentences
  above it divided by `run.pagesCrawled`. Now one number.
- **Fifty identical lines under "No longer reported."** Grouped and counted, as the
  findings section above it already was.
- **`figure` could still strand a sheet.** `sm:grid-cols-2` is a screen breakpoint; a
  narrow print width stacked two 22cm images into a block no sheet could hold, which
  is the D-1 shape again. Print CSS now pins the figure grid to two columns.

### Tests added

- A truncated run's report asserts the partial-coverage sentence end to end — the
  Phase 3 contract item that was missing. The page-limit flag is written directly,
  because the ceiling is two thousand pages and lowering it for a test would put a
  test-only env var into shipped configuration.
- A mismatched project/run pair asserts 404, guarding the one check that stands
  between a valid run id and a document headed with the wrong client's name.
- Four tests for `BAND_MARK`: distinct marks where action is needed, none where it is
  not, a word for every marked band, and coverage of every band `bandFor` returns.
