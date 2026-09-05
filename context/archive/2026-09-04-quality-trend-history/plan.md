# Quality Trend History Implementation Plan

## Overview

Roadmap slice **S-12**. A user can see how many findings of each kind a project
has had over time, drawn only across runs that were produced under the same
conditions — the same scope, a complete crawl, and the same set of detection
rules.

Scoped to the **issue-counts half of FR-039**. The "scores" half is Core Web
Vitals, which belongs to S-06 and does not exist yet; see "What We're NOT Doing".

## Current State Analysis

Everything a counts trend reads is already stored. `runs` carries `createdAt`,
`pagesCrawled`, `findingsCount`, and — since S-07 — `crawlComplete`,
`reachedPageLimit` and a `scope` snapshot
([schema.ts:200-262](src/server/db/schema.ts)). `project.runs` returns those rows
whole ([project.ts:151-168](src/server/api/routers/project.ts)), and `findings`
is indexed on `(runId, type)` ([schema.ts:345](src/server/db/schema.ts)), so
per-type counts are an index-only aggregate.

Two things are missing, and one is a defect in what already shipped.

**Nothing records which rules produced a run.** A finding type with no rows is
indistinguishable from a type whose rule did not exist yet, and the second is a
claim about us rather than the site. `FINDING_TYPES` is a single frozen object
([findings.ts:26-77](src/server/crawl/findings.ts)), so the set is knowable at
run time and unrecoverable afterwards — exactly the shape of fact S-07 had to
start recording for scope and completeness.

**S-07's comparison shares the problem.** `comparability()` checks completeness
and scope but not the rule set
([comparison.ts:74-113](src/server/crawl/comparison.ts)), so the first
comparison after any new rule ships reports every finding that rule produces as
`new` — "your site broke" where the truth is "we started checking". It is masked
today only because every pre-S-07 run answers `not_recorded` first. S-06, S-08
and S-14 each add rules, so it fires the next time one lands.

**The real data shows why a total is not trendable.** yazaki's ten runs read
12 → 0 → 8 → 8 → 9 → 42 → 66 → 67 → 67 → 67. The 569 → 533 page drop is the
redirect-alias fix, 9 → 42 is S-05 shipping, 42 → 66 is S-04 shipping, and the 0
is an interrupted run. Drawn as one line that is a site collapsing; drawn per
type it is rules arriving.

## Desired End State

A project page carries a trend section below the run history: finding types down,
qualifying runs across, counts in the cells. A type not checked by a given run
reads as *not checked* rather than as zero. Runs that do not qualify — truncated,
differently scoped, or produced by a different rule set — are not plotted at all.

Verify by: running a project twice without changing it and seeing a two-column
grid with flat rows; changing the scope and seeing the next run excluded rather
than plotted as a cliff.

### Key Discoveries

- **`buildParity` is the model to copy** ([parity.ts:68-145](<src/app/(app)/projects/[id]/parity.ts>)):
  a pure builder over stored rows, a small cell vocabulary, a row cap that sorts
  so only uninteresting rows are ever hidden, and tests that need no browser.
  The trend is the same grid with different axes — types down, runs across.
- **No charting exists** — no dependency, no `<svg>`, no canvas anywhere in
  `src/`. The product's whole vocabulary is type, tables, and the parity grid's
  three glyphs. A grid needs no new idiom; a chart would introduce two.
- **One guard, not two.** The trend's eligibility question — "is this run on the
  same axis as that one?" — is the comparison's question with one more clause.
  Extending `comparability()` keeps a single definition of comparable; a second
  check would drift from the first.
- **`FINDING_TYPES` is frozen and ordered** ([findings.ts:26-77](src/server/crawl/findings.ts)),
  so recording it is a derivation of the code that ran, not a value anybody has
  to remember to update.
- **`lessons.md` rule 1 decides the score question.** A weighted severity index
  would rest on our inference; the counts rest on the site's own pages. The PRD
  never asked for the former.

## What We're NOT Doing

- **Not delivering the "scores" half of FR-039.** The PRD's "scores" are Core Web
  Vitals and page performance scores ([prd.md:62](context/foundation/prd.md),
  [prd.md:247](context/foundation/prd.md)), delivered by S-06, which is
  `proposed`. **FR-039 must be recorded as partly met when this closes**, and
  S-06 noted as the unrecorded prerequisite for the rest.
- **Not inventing a quality score.** No weighted index, no letter grade, no
  0-100. The counts are observations; a score would be an assertion.
- **Not trending the parity ratio.** It is the one honest score-shaped number and
  it is trendable from S-07 onward, but it describes only the multilingual half
  of the product and a site with no hreflang has none. Recorded as the obvious
  follow-on rather than folded in here.
- **Not trending correlated problems.** They are recomputed at read time and
  deliberately not frozen, so a series over them would be today's rule applied to
  old data. The frozen findings are the recorded history.
- **Not backfilling `ruleSet` onto existing runs.** We do not know which rules
  produced them. They will not qualify, and the next two runs establish a
  baseline — the same decision S-07 made for the same reason.
- **Not plotting ineligible runs with a caveat.** The shape of a line is the
  claim; marking individual points does not unmake it.
- **Not adding a route.** The section lives on the existing project page.
- **Not adding a charting dependency.**

## Implementation Approach

Four dependencies in order: a run must record its rule set before eligibility can
consider it; the guard must know about rule sets before the trend can filter on
it; the model needs both before it can shape a grid; the view needs the model.

The trend is computed per request from frozen rows and never stored, for the
reason the comparison is not stored: it is derived, and freezing it would leave
old projects described by a rule nobody would write today.

Phase 2 changes behaviour that already shipped. That is deliberate and is the
cheaper half of this slice: the same clause that makes a trend point legitimate
makes a comparison honest, and writing it twice would let the two definitions
drift.

## Critical Implementation Details

**`ruleSet` must be derived, never typed.** Write it from `Object.values(FINDING_TYPES)`
so that adding a rule updates it with no further action. A hand-maintained list
or a hand-bumped version has exactly one failure mode — somebody forgets — and
its consequence is the trend silently claiming two incomparable runs are
comparable.

**Order the comparability checks by what the reader can act on.** `not_recorded`
first (nothing else is knowable), then `incomplete_crawl`, then `scope_changed`,
then `rules_changed` last. Scope is the user's own configuration and actionable;
a rule-set change is ours and is information, not an instruction.

## Phase 1: Record the rule set

### Overview

Give each run the list of detection rules that produced it. User-invisible; its
only effect is that runs from here on can be judged as trend points and as
comparison partners.

### Changes Required

#### 1. The column

**File**: `src/server/db/schema.ts`

**Intent**: Record on the run which rules could have fired. Without it a type
with no rows is ambiguous between "the rule found nothing" and "the rule did not
exist", and only the first is a statement about the site.

**Contract**: One nullable column on `runs`, `ruleSet`, typed
`jsonb().$type<string[]>()`. Nullable for the reason the S-07 columns are: null
means *not recorded*, which is what every existing run genuinely is. It must
carry a comment saying so, and saying that the value is derived from
`FINDING_TYPES` rather than maintained.

#### 2. Writing it

**File**: `src/server/crawl/run.ts`

**Intent**: Add the rule set to the closing run update, beside `crawlComplete`,
`reachedPageLimit` and `scope`.

**Contract**: The existing single `db.update(runs)` at the end of `execute`
gains `ruleSet`, sourced from `Object.values(FINDING_TYPES)` and sorted so two
runs of the same code produce an identical array regardless of declaration order.
The failure path is untouched: a run that threw leaves the column null, which is
correct.

#### 3. Persistence test

**File**: `src/server/crawl/run.test.ts`

**Intent**: Prove the recorded set is the set the code actually has, rather than
a list that drifted.

**Contract**: A case asserting a completed run's `ruleSet` equals the sorted
`Object.values(FINDING_TYPES)`, so adding a rule without the column following
fails here. Existing cases pass unmodified.

### Success Criteria

#### Automated Verification

- Schema applies cleanly: `npm run db:push`
- Integration tests pass: `npm run test:integration`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- A completed run's `ruleSet` matches `FINDING_TYPES` exactly

#### Manual Verification

- The project page still renders against a dev database whose older runs have a null `ruleSet`

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding.

---

## Phase 2: Rule-set comparability

### Overview

Teach the existing guard that two runs produced by different rule sets are not
comparable. This fixes a live defect in S-07's comparison as well as supplying
the trend's eligibility rule.

### Changes Required

#### 1. The fourth reason

**File**: `src/server/crawl/comparison.ts`

**Intent**: A comparison across a rule-set change reports every finding the new
rules produce as `new`, which reads as the site breaking on the day we started
checking. Adding the clause to the existing guard keeps one definition of
"comparable" rather than two that can drift.

**Contract**: `ComparableRun` gains `ruleSet: string[] | null`.
`ComparabilityReason` gains `"rules_changed"`. The null check folds `ruleSet`
into the existing `not_recorded` condition; the new clause is evaluated **last**,
after `scope_changed`, and compares the two sets with the existing `sameSet`
helper. `comparability`'s signature is unchanged.

#### 2. The reader's words

**File**: `src/app/(app)/projects/[id]/comparison-view.ts`

**Intent**: Give the new reason a heading and a sentence, and say plainly that
the difference is ours rather than theirs — the reader has nothing to fix.

**Contract**: One entry each in `REASON_HEADING` and `REASON_SENTENCE`. Both
records are typed `Record<ComparabilityReason, string>`, so a missing entry is a
type error; the existing test asserting every reason has a sentence covers the
rest.

#### 3. Guard tests

**File**: `src/server/crawl/comparison.test.ts`

**Intent**: Fix the new clause and its ordering, and prove the reason the clause
exists.

**Contract**: Cases for: a rule-set difference alone yielding `rules_changed`; a
reordered rule set being *not* a change; a null `ruleSet` on either side yielding
`not_recorded`; and a run differing in both scope and rules reporting
`scope_changed`, since that is the one the reader can act on. Existing cases pass
with `ruleSet` added to the fixtures.

### Success Criteria

#### Automated Verification

- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- Every `ComparabilityReason` has a heading and a sentence (existing test)
- Two runs differing only in rule set report `rules_changed`

#### Manual Verification

- An existing project still shows its previous refusal reason, not the new one

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding.

---

## Phase 3: The trend model

### Overview

The data behind the grid: per-type counts across a project's qualifying runs, and
a pure builder that shapes them. Fully testable before any view exists.

### Changes Required

#### 1. The aggregate

**File**: `src/server/api/routers/project.ts`

**Intent**: Return per-type finding counts for the runs of a project that qualify
as trend points, so the view receives a shaped answer rather than every finding
row of every run.

**Contract**: `trend` — input `{ projectId }`, composing `tenantScope` like every
other procedure here. It loads the project's runs newest-first, takes the most
recent run as the reference, keeps the runs for which `comparability(run,
reference)` returns comparable, and returns `{ runs, counts }` where `counts` is
one row per `(runId, type)` with a count, from a `group by` over `findings`
restricted to those run ids. Runs are returned oldest-first, which is the reading
order of the grid. A project with fewer than two qualifying runs returns them
anyway and lets the view decide — the emptiness is a fact the view has to explain.

#### 2. The builder

**File**: `src/app/(app)/projects/[id]/trend.ts` (new)

**Intent**: Shape the aggregate into types-down/runs-across, following
`buildParity`: pure, small cell vocabulary, capped rows sorted so the cap only
hides what does not move.

**Contract**: `buildTrend(runs, counts, limit)` returning `{ runs, rows, hidden }`.
A row is `{ type, cells, moved }`; a cell is either a count or the marker for
*not checked*, decided by whether that run's `ruleSet` contains the type. Rows
sort by movement first — a type whose counts are not all equal — then
alphabetically, so a capped grid never hides a type that changed. A `MAX_ROWS`
constant mirrors parity's, and columns are capped to the most recent N runs.

#### 3. Model tests

**File**: `src/app/(app)/projects/[id]/trend.test.ts` (new)

**Intent**: Fix the shape and the two decisions that carry meaning — *not
checked* versus zero, and what the cap is allowed to hide.

**Contract**: Cases for: a type absent from a run's `ruleSet` rendering as not
checked rather than zero; a type present but with no findings rendering as zero;
moved rows sorting above flat ones; the cap hiding only flat rows; column capping
keeping the most recent runs; and an empty input producing an empty grid rather
than throwing.

#### 4. Eligibility integration test

**File**: `src/server/crawl/trend.integration.test.ts` (new)

**Intent**: Prove the filter over real rows — that a scope change or an
incomplete run drops out of the series rather than appearing as a cliff.

**Contract**: Named `*.integration.test.ts` so the integration config collects
it. Using `runToCompletion` against the fixture: two unchanged runs both qualify
and produce flat rows; a run after an `includePaths` edit is excluded; an
aborted run is excluded.

### Success Criteria

#### Automated Verification

- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- A type outside a run's `ruleSet` renders as not-checked, never as zero
- A scope change between runs removes the later run from the series

#### Manual Verification

- None — this phase is user-invisible

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding.

---

## Phase 4: The trend grid

### Overview

The user-visible half: the grid on the project page, and the explanation shown
while there is nothing yet to draw.

### Changes Required

#### 1. The grid

**File**: `src/app/(app)/projects/[id]/trend-grid.tsx` (new)

**Intent**: Render types down and runs across, in the grammar `ParityGrid`
already established, so the trend reads as part of the product rather than as a
chart bolted onto it.

**Contract**: Reads `project.trend`. Column headers are run dates; row headers
are the reader-facing finding labels. `FINDING_LABEL` moves out of `run-panel.tsx`
into a module both files import rather than being duplicated. Cells show a count;
a not-checked cell renders as visibly nothing, following the parity grid's rule
that "never expected" is not a defect. Capped rows summarise as "and N more" the
way parity does.

#### 2. Placement and empty state

**File**: `src/app/(app)/projects/[id]/run-panel.tsx`

**Intent**: Put the section below the run history, and when fewer than two runs
qualify, say what is missing and that the next runs will fix it — rather than
rendering an empty frame or hiding the feature so it looks absent.

**Contract**: The section renders after `RunHistory`. With fewer than two
qualifying runs it renders a short explanation naming the reason drawn from the
same `REASON_SENTENCE` vocabulary the refusal uses. The rest of the panel is
untouched.

#### 3. Rendering tests

**File**: `src/app/(app)/projects/[id]/trend.test.ts`

**Intent**: Cover whatever presentation logic the section adds, at the tier
`summarise.test.ts` and `parity.test.ts` sit at.

**Contract**: Any logic worth testing is extracted as a pure function and tested
directly. Assert the empty state names a reason rather than rendering a bare
message.

### Success Criteria

#### Automated Verification

- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- Existing e2e journeys pass: `npm run test:e2e`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- Production build succeeds: `npm run build`
- `FINDING_LABEL` has exactly one definition in the codebase

#### Manual Verification

- A project with no qualifying runs shows the explanation, not an empty frame
- A project with two qualifying runs shows a two-column grid with flat rows
- The grid is legible on a project with many finding types
- The rest of the project page is unchanged

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding.

---

## Phase 5: Real-site proof

### Overview

The grid populated from a real project, and FR-039 recorded honestly as partly
met.

### Changes Required

#### 1. The proof

**File**: `context/changes/quality-trend-history/proof.md` (new)

**Intent**: Two qualifying runs against a real client project, at its own pacing,
with the resulting grid read by hand. Tecalliance is the cheap target — two pages,
about four seconds a run.

**Contract**: Run ids, the grid as rendered, and a judgement on whether every
plotted cell is attributable to the site. An explicit note on how many of the
project's existing runs were excluded and why.

#### 2. FR-039 recorded as partly met

**File**: `context/foundation/roadmap.md`

**Intent**: Say in the roadmap that S-12 delivers the counts half only, and that
the scores half needs S-06. A half-met requirement silently marked done is worse
than one openly left open.

**Contract**: S-12's entry notes the partial delivery and names S-06 as the
prerequisite for the remainder. The status flip itself belongs to `/10x-archive`;
this is the note beside it.

### Success Criteria

#### Automated Verification

- Whole suite passes: `npm run test:all`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- No temporary scripts or harnesses remain in the working tree

#### Manual Verification

- Two runs of an unchanged real project produce a grid whose rows are all flat
- Every plotted cell is attributable to the site rather than to our rule set
- The roadmap records FR-039 as partly met, naming S-06

**Implementation Note**: This is the final phase. Confirm the manual criteria before archiving.

---

## Testing Strategy

### Unit Tests

- `buildTrend`: not-checked versus zero, movement sorting, row and column caps
- `comparability`: the `rules_changed` clause, its ordering against `scope_changed`, set equality over reordered rule sets
- Empty and single-run inputs producing a grid rather than an exception

### Integration Tests

- Two unchanged fixture runs both qualifying and producing flat rows
- A run after a scope change excluded from the series
- An aborted run excluded from the series
- A completed run recording a `ruleSet` equal to `FINDING_TYPES`

### Manual Testing Steps

1. Open a project whose runs all predate this change; confirm the explanation
   names what is missing rather than showing an empty frame.
2. Run a check twice without changing anything; confirm a two-column grid with
   flat rows appears.
3. Narrow the project scope and run again; confirm the new run is absent from the
   grid rather than plotted as a change.
4. Confirm a finding type introduced after the earliest plotted run reads as not
   checked in the earlier column, not as zero.

## Performance Considerations

The aggregate is a `group by` over `findings` restricted to a project's
qualifying run ids, served by the existing `finding_type_idx` on `(runId, type)`.
At the observed real-site scale — a few hundred findings per run, tens of runs —
it returns a few hundred rows. The trend is computed per request and cached by
the query client the same way every other read here is.

Columns are capped to the most recent qualifying runs, so the query and the grid
both stay bounded as a project accumulates years of history.

## Migration Notes

One nullable column added by `npm run db:push`; `test/global-setup.ts` applies
the same schema to the test database. Nothing is backfilled: existing runs have
an unknown rule set and therefore do not qualify, and the first two runs after
deployment establish a baseline. Reversal is dropping the column.

Phase 2 changes the behaviour of a shipped feature: comparisons across a
rule-set change begin refusing where they previously reported false `new`
findings. No stored data changes, and the refusal is the correct answer.

## References

- Research: `context/changes/quality-trend-history/research.md`
- The guard being extended: `src/server/crawl/comparison.ts:74-113`
- The grid being mirrored: `src/app/(app)/projects/[id]/parity.ts:68-145`
- S-07, whose columns this builds on: `context/archive/2026-09-04-run-history-and-comparison/`
- `lessons.md` rule 1 — why counts and not a score

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Record the rule set

#### Automated

- [x] 1.1 Schema applies cleanly: `npm run db:push` — 37e7600
- [x] 1.2 Integration tests pass: `npm run test:integration` — 37e7600
- [x] 1.3 Type checking passes: `npm run typecheck` — 37e7600
- [x] 1.4 Lint and format pass: `npm run check` — 37e7600
- [x] 1.5 A completed run's `ruleSet` matches `FINDING_TYPES` exactly — 37e7600

#### Manual

- [x] 1.6 The project page still renders against a dev database whose older runs have a null `ruleSet` — 37e7600

### Phase 2: Rule-set comparability

#### Automated

- [x] 2.1 Unit tests pass: `npm run test:unit` — 3a892e6
- [x] 2.2 Integration tests pass: `npm run test:integration` — 3a892e6
- [x] 2.3 Type checking passes: `npm run typecheck` — 3a892e6
- [x] 2.4 Lint and format pass: `npm run check` — 3a892e6
- [x] 2.5 Every `ComparabilityReason` has a heading and a sentence — 3a892e6
- [x] 2.6 Two runs differing only in rule set report `rules_changed` — 3a892e6

#### Manual

- [x] 2.7 An existing project still shows its previous refusal reason, not the new one — 3a892e6

### Phase 3: The trend model

#### Automated

- [x] 3.1 Unit tests pass: `npm run test:unit` — a276d21
- [x] 3.2 Integration tests pass: `npm run test:integration` — a276d21
- [x] 3.3 Type checking passes: `npm run typecheck` — a276d21
- [x] 3.4 Lint and format pass: `npm run check` — a276d21
- [x] 3.5 A type outside a run's `ruleSet` renders as not-checked, never as zero — a276d21
- [x] 3.6 A scope change between runs removes the later run from the series — a276d21

### Phase 4: The trend grid

#### Automated

- [x] 4.1 Unit tests pass: `npm run test:unit` — 8267621
- [x] 4.2 Integration tests pass: `npm run test:integration` — 8267621
- [x] 4.3 Existing e2e journeys pass: `npm run test:e2e` — 8267621
- [x] 4.4 Type checking passes: `npm run typecheck` — 8267621
- [x] 4.5 Lint and format pass: `npm run check` — 8267621
- [x] 4.6 Production build succeeds: `npm run build` — 8267621
- [x] 4.7 `FINDING_LABEL` has exactly one definition in the codebase — 8267621

#### Manual

- [x] 4.8 A project with no qualifying runs shows the explanation, not an empty frame — 8267621
- [x] 4.9 A project with two qualifying runs shows a two-column grid with flat rows — 8267621
- [x] 4.10 The grid is legible on a project with many finding types — 8267621
- [x] 4.11 The rest of the project page is unchanged — 8267621

### Phase 5: Real-site proof

#### Automated

- [x] 5.1 Whole suite passes: `npm run test:all` — 615c832
- [x] 5.2 Type checking passes: `npm run typecheck` — 615c832
- [x] 5.3 Lint and format pass: `npm run check` — 615c832
- [x] 5.4 No temporary scripts or harnesses remain in the working tree — 615c832

#### Manual

- [x] 5.5 Two runs of an unchanged real project produce a grid whose rows are all flat — 615c832
- [x] 5.6 Every plotted cell is attributable to the site rather than to our rule set — 615c832
- [x] 5.7 The roadmap records FR-039 as partly met, naming S-06 — 615c832
