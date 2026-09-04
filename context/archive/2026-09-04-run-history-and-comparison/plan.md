# Run History and Run-Over-Run Comparison Implementation Plan

## Overview

Roadmap slice **S-07**. A user can view a project's run history and see any run's findings
annotated against the run before it — new, still present, or resolved — with the comparison
refusing to run at all when the two runs were not produced under the same conditions.

This is the second half of the product's domain rule. S-09 collapses many symptoms into one
explained problem; S-07 separates what *changed* from accumulated known state. Together they
are what makes a go-live decision possible rather than just a list of problems.

## Current State Analysis

Runs, pages and findings are already stored as first-class rows, and the `findings` table's own
doc comment names this slice as the reason it exists
([schema.ts:295-299](src/server/db/schema.ts)). Findings are frozen at detection time, so a
comparison reads what was concluded *then* rather than what today's rules would say about
yesterday's data. `detectMissingVariants` documents its stable ordering as being for this slice
([findings.ts:198-204](src/server/crawl/findings.ts)).

Three things are missing:

1. **No cross-run identity.** `findings.id` is a per-row UUID and `findings.pageId` references a
   page row scoped to one run, so neither survives a run boundary. Whole-`detail` equality is
   not a substitute: `link_broken` carries `httpStatus` and `linkedFrom`,
   `certificate_problem` carries `validTo` and `daysRemaining`. A certificate renewal, or one
   extra page linking to the same dead URL, would read as resolved-plus-new.

2. **No record of whether a run can be compared at all.** `execute()` computes `crawlComplete`
   and `scopeNarrowed`, hands them to the rules and discards both
   ([run.ts:206-232](src/server/crawl/run.ts)). Hitting the 2,000-page ceiling
   ([run.ts:42](src/server/crawl/run.ts)) leaves the run as `status: done` with nothing
   recording the truncation. `projects` is mutable and no run snapshots the config it ran under.

3. **No history anywhere.** The API exposes `latestRun` only
   ([project.ts:104-118](src/server/api/routers/project.ts)) and `RunPanel` is hard-wired to it
   ([run-panel.tsx:170-181](<src/app/(app)/projects/[id]/run-panel.tsx>)).

The test fixture cannot change between runs — `SITE` is a module constant
([site.ts:165](test/fixtures/site.ts)) and `FixtureOptions` has one knob
([site.ts:802-813](test/fixtures/site.ts)) — so nothing in this slice is testable until that is
addressed.

## Desired End State

A project page lists every run. Selecting one shows its findings with each annotated **new**,
**still present**, or **resolved** relative to the run before it. Where the two runs were not
produced under the same conditions the comparison is not shown at all, and the view says which
precondition failed.

Verify by: crawling a fixture site twice with no change between runs and seeing zero new and
zero resolved; breaking one page and seeing exactly one new finding; narrowing the project scope
and seeing the comparison refuse with the scope as its stated reason.

### Key Discoveries

- **Conclusions are frozen, presentation is live.** Findings are persisted so a comparison sees
  what was concluded then ([schema.ts:295-299](src/server/db/schema.ts)); correlation is
  recomputed at read time so an improved rule improves old runs
  ([run-panel.tsx:195-203](<src/app/(app)/projects/[id]/run-panel.tsx>)). A run diff operates
  over frozen rows but is itself derived, so it is computed per request and never stored.
- **`evidenceRoles` is the projection pattern to follow**
  ([summarise.ts:76-270](<src/app/(app)/projects/[id]/summarise.ts>)): an exhaustive per-type
  switch over `detail`, reasoned per case, with a documented fail-safe default, tested without a
  database. It is also a pure module with no `"use client"`, so it can move server-side.
- **`variantGroupKey` is stable only given the same member set.** It is the lexicographically
  smallest URL in a family, unioned over *pages the crawl saw*
  ([variants.ts:179-220](src/server/crawl/variants.ts)). This rules out correlated-problem
  identity across runs, and constrains family-level finding identity — see the stated limit in
  Phase 2.
- **Every absence-reasoning rule already takes a required "can I trust this crawl?" argument**
  ([findings.ts:93-104](src/server/crawl/findings.ts)), required rather than optional so a
  forgetful caller gets the safe behaviour. A comparison reasons from absence by construction.
- **Schema changes are push-based.** No `drizzle/` directory exists and `drizzle.config.ts`
  declares no `out`; `test/global-setup.ts` runs `drizzle-kit push --force` before every
  integration run, so a new column reaches the test database automatically.
- **`lessons.md` rule 1 governs this slice.** A run diff is a claim about two of *our*
  observations. Where a difference cannot be attributed to the site, it must not be reported.

## What We're NOT Doing

- **Not comparing arbitrary run pairs.** FR-037 asks for "the previous run". A run is compared
  to its immediate predecessor only. A two-run picker doubles the comparability surface and
  needs a selection pattern this product does not have.
- **Not backfilling comparability metadata onto existing runs.** Their completeness and scope
  were never recorded; asserting either would state as fact something never observed. They are
  incomparable, and the first run after this ships establishes a baseline.
- **Not persisting the diff.** It is derived from frozen rows, so storing it would freeze a young
  rule and require a backfill on every identity improvement — the reasoning `run-panel.tsx`
  already gives for not persisting correlation.
- **Not diffing correlated problems.** `CorrelatedProblem.key` resolves through `variantGroupKey`
  and would shift for reasons about our crawl. Correlation applies on top of annotated findings
  unchanged.
- **Not persisting the link graph.** S-04 assigned a durable `page_links` table to "whichever
  slice first needs run-over-run link comparison"
  ([crawl-technical-checks/plan.md:87-89](context/archive/2026-09-02-crawl-technical-checks/plan.md)).
  A findings-level diff does not need it — `link_broken` already carries `linkedFrom` in its
  detail. Recorded here so the deferral is not picked up by default.
- **Not adding an e2e journey for the two-run flow.** The e2e fixture server runs in a separate
  process ([e2e/fixture-server.ts](e2e/fixture-server.ts)) with no channel to mutate the site
  mid-suite. The two-run property is proven at the integration tier, where the fixture is
  in-process. Existing journeys must continue to pass unmodified.
- **Not implementing FR-039 trend history.** That is S-12, and it reads the same rows.
- **Not adding a suppression or muting mechanism.** PRD Open Question 2 remains open.

## Implementation Approach

Four dependencies, in order: a run must record what it did before two runs can be judged
comparable; a finding must have an identity before two sets can be matched; the diff needs both
plus a fixture that can change; the view needs the diff.

The comparison is a server-side tRPC procedure computed per request. It loads two runs, applies
the comparability guard, and returns findings annotated with a status — one round trip instead
of two full finding sets over the wire, with the guard sitting next to the run metadata it
reads.

Identity is a per-type projection following `evidenceRoles`, with one governing principle:
**identity is the invariant the site asserts; population and observation metadata are excluded.**
The dead URL is identity, the pages linking to it are population. The duplicated string is
identity, the pages carrying it are population. The certificate's problem kind is identity, its
expiry date is observation.

## Critical Implementation Details

**Nullable means "not recorded", not "false".** The new comparability columns must be nullable,
and null must read as *unknown* rather than as a negative. `schema.ts` and `findings.ts` already
use this idiom for the certificate, robots and sitemap — "Null is silence" — and it is what makes
pre-existing runs incomparable without a backfill. A `notNull().default(false)` column would
silently assert that every historical run was incomplete, which is a different claim.

**`evidence.ts` must stay dependency-free.** It is imported by both the server comparison and,
through `summarise.ts`, by a client component. It takes its finding structurally today and must
keep doing so — importing anything from `findings.ts` or `crawler.ts` would pull the crawler into
the client bundle.

**Fixture overrides are consulted before `SITE`, not merged into it.** The fixture header records
a case where six added pages pushed a politeness test past its timeout, so the overrides layer
must cost nothing to tests that do not use it, and must be cleared by `reset()`.

## Phase 1: Run comparability metadata

### Overview

Stop discarding what `execute()` already computes, and snapshot the configuration the crawl ran
under. User-invisible; its only effect is that runs produced after it can serve as a comparison
baseline.

### Changes Required

#### 1. The run columns

**File**: `src/server/db/schema.ts`

**Intent**: Record on the run itself whether the crawl can be reasoned about from absence, and
under what configuration it ran. Without these, a later comparison cannot tell a site that
changed from a scope that changed — the failure `lessons.md` rule 1 exists to prevent.

**Contract**: Three nullable columns on `runs`:

| column | type | meaning |
| --- | --- | --- |
| `crawlComplete` | `boolean` nullable | The composite the rules already consume: no abort and no ceiling. Null = not recorded. |
| `reachedPageLimit` | `boolean` nullable | Whether `MAX_PAGES` was hit. Distinct from `crawlComplete` because an abort is already recoverable from `status` and `error`, while a ceiling is not. |
| `scope` | `jsonb` nullable, `$type<{ includePaths: string[]; excludePaths: string[]; locales: string[] }>()` | The project configuration as it was when the crawl ran. |

Nullable is load-bearing and must carry a comment saying so: null is "not recorded", which is
what makes every pre-existing run incomparable without a backfill. No new index — comparison
loads two runs by id.

#### 2. Writing them

**File**: `src/server/crawl/run.ts`

**Intent**: Hoist the `crawlComplete` expression currently inlined in the
`detectMissingVariants` call into a named const, and add all three fields to the final run
update that already sets `status`, `finishedAt`, `pagesCrawled` and `findingsCount`. The scope
snapshot comes from the `project` row `execute` was handed at start, not from a re-read, so it
records the configuration the crawl actually used.

**Contract**: The existing single `db.update(runs)` at the end of `execute` gains
`crawlComplete`, `reachedPageLimit: result.reachedPageLimit` and `scope`. The failure path in
`startRun`'s `.catch` is untouched — a run that threw leaves the columns null, which is correct.
`RUN_STATUS`, `sweepStaleRuns` and `runToCompletion` are unchanged.

#### 3. Persistence tests

**File**: `src/server/crawl/run.test.ts`

**Intent**: Prove the columns hold what the crawl did, including the case that matters — a
project with `includePaths` records those paths rather than the empty default.

**Contract**: Cases asserting that a completed fixture run records `crawlComplete: true`,
`reachedPageLimit: false`, and a `scope` deep-equal to the project's `includePaths`,
`excludePaths` and `locales`; and that a project created with `includePaths` records them.
Existing cases in this file pass unmodified.

### Success Criteria

#### Automated Verification

- Schema applies cleanly: `npm run db:push`
- Integration tests pass: `npm run test:integration`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- A completed run has non-null `crawlComplete` and `scope`; a scoped project's run records its paths

#### Manual Verification

- The existing project page still renders against a dev database whose older runs have null columns

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 2: Finding identity across runs

### Overview

Give a finding a key that survives a run boundary, derived from what the site asserted rather
than from what we observed. User-invisible, and proven entirely by its own tests.

### Changes Required

#### 1. Evidence roles, relocated

**File**: `src/server/crawl/evidence.ts` (new), `src/app/(app)/projects/[id]/summarise.ts`

**Intent**: Move `EvidenceRoles` and `evidenceRoles` verbatim into a module the server can import
without reaching into the app directory, and re-export them from `summarise.ts` so every existing
caller and test is untouched. Evidence roles are a property of finding `detail` shapes, which are
defined under `src/server/crawl` — this is where the mapping belonged.

**Contract**: `evidence.ts` exports `EvidenceRoles` and `evidenceRoles` with their current
signatures and behaviour, including the `default` case, and imports nothing. `summarise.ts` keeps
exporting both names by re-export; `summariseList`, `pagesInvolved`, `countPages` and `MAX_LISTED`
stay where they are. `correlate.ts`, `run-panel.tsx`, `summarise.test.ts` and `correlate.test.ts`
are not edited.

#### 2. The identity projection

**File**: `src/server/crawl/identity.ts` (new)

**Intent**: Map each finding type to the fields that make it *the same problem*, excluding every
field that records how or when we observed it. This is the risk concentrator of the slice: a
field wrongly included makes a standing problem look resolved, and a field wrongly excluded
merges two distinct problems into one.

**Contract**: `export function findingIdentity(finding: { type: string; detail: Record<string, unknown> }): string`
returning a stable string key. Identity fields per type:

| type | identity | excluded as population or observation |
| --- | --- | --- |
| `missing_locale` | `groupKey`, `missingLocale` | `presentLocales`, `memberUrls` |
| `hreflang_target_failed` | `declaredBy`, `locale`, `target` | `httpStatus`, `fetchError` |
| `hreflang_target_unreached` | `declaredBy`, `locale`, `target` | — |
| `no_hreflang` | `url` | `impliedLocale` |
| `hreflang_family_inconsistent` | `groupKey` | `memberUrls`, `defects` |
| `variant_diverged` | `brokenUrl` | `groupKey`, `httpStatus`, `fetchError`, `declaredBy`, `healthyUrls` |
| `content_untranslated` | `kind`, then `url` (`placeholder_markers`) or `groupKey` (`identical_to_siblings`) | `markers`, `locale`, `urls`, `locales` |
| `content_structure_differs` | `groupKey` | `memberUrls`, `differences` |
| `metadata_missing` | `url` | `fields` |
| `metadata_duplicated` | `field`, `language`, `value` | `urls` |
| `canonical_missing` | `url` | `pagesDeclaringCanonical` |
| `canonical_conflicting` | `kind`, `url` | `canonicals`, `canonical`, `targetCanonical` |
| `canonical_target_broken` | `url`, `canonical` | `kind`, `httpStatus`, `fetchError` |
| `noindex_present` | `url` | `sources`, `channels`, `indexingChannels` |
| `content_duplicated` | `digest` | `urls`, `textLength` |
| `link_broken` | `target` | `httpStatus`, `fetchError`, `confirmed`, `linkedFrom` |
| `link_external_broken` | `target` | `httpStatus`, `fetchError`, `confirmed`, `linkedFrom` |
| `certificate_problem` | `kind`, `origin` | `validTo`, `daysRemaining`, `issuer`, `subject`, `authorizationError` |
| `security_header_contradiction` | `kind`, `header` | `value`, `affectedUrls` |
| `sitemap_url_failed` | sorted `entries[].normalised` | `sitemapSource`, `discovery`, per-entry status |
| `page_missing_from_sitemap` | sorted `urls` | `sitemapSource`, `discovery`, `sitemapEntryCount` |
| `robots_blocks_indexable` | `rule`, `userAgentGroup` | `ruleLine`, `ruleLineNumber`, `urls`, `discovery` |
| `page_orphaned` | sorted `urls` | `sitemapSource`, `discovery` |
| `redirect_chain` | `from` | `kind`, `to`, `hops`, `linkedFrom` |

Two cases deserve their per-case comment. `canonical_target_broken` excludes `kind` because
`failed` and `unreached` are two ways of observing one broken canonical; `canonical_conflicting`
includes it because `multiple` and `chain` are genuinely different defects on the same page.

The `default` case falls back to the type plus the sorted `subject` array from `evidenceRoles`,
so a finding type added in a later slice gets workable identity rather than a gap. Documented as
a decision, not an omission.

#### 3. The stated limit

**File**: `src/server/crawl/identity.ts`

**Intent**: Record in the module doc comment that the four family-level types keyed on `groupKey`
inherit its stability envelope. `groupKey` is the lexicographically smallest crawled member of a
family, so a family that gains or loses that particular member will report its family-level
findings as resolved and re-raised even though the underlying problem persisted. The alternative
— keying on the member set — churns strictly more often. Stated rather than hidden.

**Contract**: Prose only, in the module header. No behaviour.

#### 4. Identity tests

**File**: `src/server/crawl/identity.test.ts` (new)

**Intent**: Assert an identity for every finding type, and — the part that makes the phase safe —
assert that identity is *unchanged* when only volatile fields move.

**Contract**: One case per member of `FINDING_TYPES`. Stability cases asserting identity does not
change when: `link_broken` gains a page in `linkedFrom`; `link_broken` flips 500 → 503;
`certificate_problem` gets a new `validTo` and `daysRemaining`; `metadata_duplicated` gains a URL
in `urls`; `metadata_missing` goes from one missing field to two. Separation cases asserting
identity *does* change when: `canonical_conflicting` flips `multiple` → `chain`; two
`metadata_duplicated` findings differ only by `value`; two `link_broken` findings differ only by
`target`. A case asserting an unmapped type falls back to type-plus-subject.

### Success Criteria

#### Automated Verification

- Unit tests pass: `npm run test:unit`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- Every member of `FINDING_TYPES` has an asserted identity case
- `summarise.test.ts` and `correlate.test.ts` pass without modification

#### Manual Verification

- The results view is visibly unchanged — same problems, same remainder, same counts

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 3: The comparison, server-side

### Overview

The comparability guard, the diff, the API, and the fixture change that makes any of it testable.
Fully verifiable by integration test before any UI exists.

### Changes Required

#### 1. A fixture that can change

**File**: `test/fixtures/site.ts`

**Intent**: Let a test alter what the site serves between two crawls, so a comparison has
something real to compare. Applied at request time ahead of the static `SITE`, so tests that do
not use it pay nothing — the fixture header records a politeness test already sitting close to
its timeout.

**Contract**: `Fixture` gains `patch(overrides: Record<string, Partial<Page> | null>): void`,
where a `null` value makes the path 404 and a partial merges over the base page. `reset()` clears
patches alongside `requests`. `SITE` and `INDEX` are unmodified; `startFixtureSite` keeps its
current signature and `FixtureOptions` its single field.

#### 2. Comparability

**File**: `src/server/crawl/comparison.ts` (new)

**Intent**: Decide whether two runs may be compared at all, and say why not when they may not.
The reason is part of the return value rather than a log line, because the view has to show it.

**Contract**: `export function comparability(previous: RunRow, current: RunRow): Comparability`,
returning either `{ comparable: true }` or `{ comparable: false; reason: ComparabilityReason }`.
Reasons: `not_recorded` (either run has null metadata — every pre-existing run),
`incomplete_crawl` (either run has `crawlComplete: false`), `scope_changed` (the two `scope`
snapshots are not set-equal on all three arrays). Order of checks is the order above, so the
most fundamental reason is the one reported. Set equality, not similarity — consistent with
`correlate.ts`'s "sets are equal or they are not".

Both runs must be complete: a truncated run can neither support "resolved" (the finding may live
in the unvisited region) nor "new" (it may have been there and not been seen).

#### 3. The diff

**File**: `src/server/crawl/comparison.ts`

**Intent**: Match two runs' findings on identity and label each one. Pure over rows, so it is
unit-testable without a database.

**Contract**: `export type FindingStatus = "new" | "still_present" | "resolved"` and
`export function compareFindings(previous: StoredFinding[], current: StoredFinding[]): AnnotatedFinding[]`.
`AnnotatedFinding` is the current finding row plus `status`. Resolved entries carry the
*previous* run's row, since there is no current row to carry. Findings sharing an identity within
one run — possible in principle — are matched pairwise by arrival order so that neither count is
inflated. Output ordering preserves the input order of the current run, with resolved entries
appended, so the existing type-grouped list and `correlate` decide their own ordering as they do
today.

#### 4. The API

**File**: `src/server/api/routers/project.ts`

**Intent**: Expose the run history FR-038 asks for, and the comparison FR-037 asks for. Both
compose `tenantScope` and re-establish ownership from the run's project, following the pattern
the router's own doc comment sets out.

**Contract**: `runs` — input `{ projectId }`, returns runs for that project newest first, each
with `id`, `status`, `createdAt`, `startedAt`, `finishedAt`, `pagesCrawled`, `findingsCount`,
`error`. `comparison` — input `{ runId }`, resolves the run, finds its immediate predecessor by
`createdAt`, and returns `{ previousRunId: string | null; comparability: Comparability; findings: AnnotatedFinding[] }`.
A run with no predecessor returns `previousRunId: null` and no annotations rather than an error —
a first run is an ordinary state, not a fault. When `comparability.comparable` is false the
findings come back unannotated, so the view can still render the run itself.

#### 5. Diff unit tests

**File**: `src/server/crawl/comparison.test.ts` (new)

**Intent**: Cover the guard and the matcher over constructed rows, where every input is explicit.

**Contract**: Guard cases for each reason and for the passing case, including null metadata on
either side and a scope differing only by array order (which must still be comparable). Matcher
cases: identical sets produce all `still_present` and nothing else; one added finding produces
exactly one `new`; one removed produces exactly one `resolved`; a finding whose volatile fields
changed produces `still_present`, not a pair.

#### 6. Two-run integration proof

**File**: `src/server/crawl/comparison.integration.test.ts` (new)

**Intent**: Prove the whole path over real HTTP and a real database — the properties that only
exist in the network and query paths, which is why this project crawls a fixture rather than
stubbing fetch.

**Contract**: Named `*.integration.test.ts` so `vitest.integration.config.ts` picks it up. Using
`runToCompletion` twice against one fixture: an unchanged site between runs yields zero `new` and
zero `resolved`; patching one page to 404 yields exactly one new `link_broken` for that target;
un-patching it yields exactly one `resolved`; editing the project's `includePaths` between runs
yields `comparable: false` with reason `scope_changed`.

### Success Criteria

#### Automated Verification

- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- Two consecutive runs over an unchanged fixture produce zero `new` and zero `resolved`
- A scope change between runs produces `comparable: false`, reason `scope_changed`
- Existing crawl and router tests pass unmodified

#### Manual Verification

- No regression in run duration on a fixture crawl — the comparison does no crawling

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 4: Run history and the diff in the view

### Overview

The user-visible half: a run list, a selected run, and the three states rendered on its findings —
plus the refusal, shown with its reason rather than as an empty space.

### Changes Required

#### 1. Selecting a run

**File**: `src/app/(app)/projects/[id]/run-panel.tsx`

**Intent**: Let the panel show a chosen run rather than always the latest. The latest run stays
the default selection and keeps its polling behaviour, so an in-progress crawl behaves exactly as
it does today; selecting an older run stops polling, because a finished run has nothing more to
say.

**Contract**: Panel holds a selected run id, defaulting to the latest. `findings` and `runPages`
queries key on the selected run. The `startRun` control and the active-status polling continue to
track the *latest* run regardless of selection, so starting a check while viewing history still
works.

#### 2. The history list

**File**: `src/app/(app)/projects/[id]/run-history.tsx` (new)

**Intent**: Render the project's runs as a selectable list — the FR-038 half of the slice. Each
row carries the date, the status badge the panel already defines, pages crawled and findings
count, so the list is scannable without opening a run.

**Contract**: Reads `project.runs`. Emits a selection callback. Reuses `STATUS_LABEL` and
`STATUS_STYLE` from the panel — exported from there rather than duplicated. Renders nothing when
a project has one run or none, since a list of one is not a history.

#### 3. Diff annotation

**File**: `src/app/(app)/projects/[id]/run-panel.tsx`

**Intent**: Show each finding's state against the previous run, and show resolved findings —
which have no current row — as their own group rather than mixed into the live list, since they
describe what is *no longer* wrong.

**Contract**: Reads `project.comparison` for the selected run. `new` and `still_present` findings
render in place with a marker; `resolved` findings render in a separate section. Annotated
findings are passed to `correlate` unchanged — the extra `status` field does not affect
`CorrelatableFinding`, so problems fold exactly as they do today and a problem can report how
many of its findings are new. A run with no predecessor renders exactly as today, with no markers.

#### 4. The refusal

**File**: `src/app/(app)/projects/[id]/run-panel.tsx`

**Intent**: When the comparison declines, say which precondition failed. An unexplained absence is
the thing that makes people stop trusting a tool — the same reasoning `sweepStaleRuns` was written
under.

**Contract**: Each `ComparabilityReason` maps to a sentence in the reader's words, following the
`FINDING_LABEL` / `CHANNEL_LABEL` convention of keeping presentation strings in a record beside
the component. `scope_changed` names the crawl scope; `incomplete_crawl` says the run did not
finish; `not_recorded` says the earlier run predates comparison. The run's own findings still
render underneath.

#### 5. Rendering tests

**File**: `src/app/(app)/projects/[id]/comparison-view.test.ts` (new)

**Intent**: Cover whatever pure helpers the annotation introduces — grouping resolved findings,
counting new findings within a correlated problem, mapping a reason to its sentence — at the same
tier `summarise.test.ts` and `parity.test.ts` sit at.

**Contract**: Any logic worth testing is extracted from the component as a pure function and
tested directly, matching how `summariseList`, `buildParity` and `correlate` are already split
out. Assert every `ComparabilityReason` maps to a non-empty sentence.

### Success Criteria

#### Automated Verification

- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- Existing e2e journeys pass unmodified: `npm run test:e2e`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- Production build succeeds: `npm run build`
- Every `ComparabilityReason` has a rendered sentence

#### Manual Verification

- A project with one run renders exactly as before, with no history list and no markers
- Selecting an older run shows that run's findings and stops the panel polling
- Starting a check while viewing an older run still works and returns the view to the new run
- After a second run over an unchanged site, every finding reads as still present and none as new
- A run whose predecessor has null metadata shows the refusal sentence, not an empty area

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 5: Real-site proof

### Overview

The fixture proves the mechanism; only a real client site proves the slice. The load-bearing
assertion is the negative one — that two runs over a site nobody changed report nothing as new
and nothing as resolved.

### Changes Required

#### 1. The proof

**File**: `context/changes/run-history-and-comparison/proof.md` (new)

**Intent**: Record two consecutive runs against a real client project at the project's own
pacing, with the diff judged by hand. This automates the manual ritual S-05 and S-04 both
performed — comparing a new run against the previous one by finding type — so the proof is that
the automation agrees with what a person would have concluded.

**Contract**: Run ids, page counts and durations for both runs. The full annotated output. An
explicit count of findings reported `new` and `resolved` on an unchanged site, with every one of
them, if any, explained. A judgement on whether each annotation is attributable to the site.

#### 2. The scope refusal, in the real world

**File**: `context/changes/run-history-and-comparison/proof.md`

**Intent**: Narrow the project's `includePaths` and run again, reproducing the exact situation
that motivated the guard — the 472 → 2 page collapse from 2026-09-04 — and confirm the product
refuses rather than reporting hundreds of resolved findings.

**Contract**: The refusal, its reason, and the page counts either side of the change.

#### 3. Lesson capture

**File**: `context/foundation/lessons.md`

**Intent**: If the real-site runs surface a rule about comparison that would apply to a future
slice, append it. If they do not, record that in the proof and leave the file alone — an entry
written because the template has a slot is worse than none.

**Contract**: Appended entry following the existing shape (Context / Problem / Rule / Applies to),
or an explicit "no lesson" note in `proof.md`.

### Success Criteria

#### Automated Verification

- Whole suite passes: `npm run test:all`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- No temporary scripts or harnesses remain in the working tree

#### Manual Verification

- Two runs over an unchanged real site report zero new and zero resolved findings
- Any finding that *is* reported as changed is traceable to a change on the site
- Narrowing the project scope produces the refusal, not a large resolved count
- Neither run degrades the client site — pacing unchanged from previous runs
- The annotated view is readable at real volume, not just at fixture volume

**Implementation Note**: This is the final phase. Confirm the manual criteria before archiving.

---

## Testing Strategy

### Unit Tests

- Identity per finding type, and identity stability under volatile-field change — the core risk
- Comparability guard per reason, including array-order-insensitive scope equality
- Diff matcher: unchanged set, one added, one removed, one changed-but-same-identity
- Presentation helpers extracted from the view

### Integration Tests

- Two `runToCompletion` crawls of one fixture, unchanged between them, yielding no annotations
- A patched page producing exactly one new finding, and its removal exactly one resolved
- A scope change between runs producing a refusal
- Run metadata persisted correctly for complete and scoped crawls

### Manual Testing Steps

1. Run a check on a project with existing history; confirm the older runs show the
   `not_recorded` refusal rather than a diff.
2. Run a second check with no site change; confirm every finding reads still present.
3. Select an older run from the history list; confirm its own findings render and polling stops.
4. Start a check while viewing an older run; confirm it succeeds and the view follows the new run.
5. Narrow the project scope, run again, and confirm the refusal names the scope.

## Performance Considerations

The comparison loads two runs' findings — at the observed real-site scale, a few hundred rows
each — and performs a single pass with a hash lookup per finding. That is the same order of work
`correlate` already does per render, and it replaces a second full findings fetch over the wire
rather than adding one. `findings` is already indexed on `(runId, type)`.

The run history query returns run rows only, never their findings. No new index is required; the
existing `run_project_id_idx` covers the lookup.

## Migration Notes

Three nullable columns added by `npm run db:push`; `test/global-setup.ts` applies the same schema
to the test database before every integration run. Nothing is backfilled, by decision: existing
runs have null metadata and are reported as incomparable, and the first run after deployment
establishes a baseline. There is no data to migrate and nothing to reverse beyond dropping the
columns.

## References

- Research: `context/changes/run-history-and-comparison/research.md`
- Lessons: `context/foundation/lessons.md` — rule 1 governs the comparability guard
- Projection pattern to follow: `src/app/(app)/projects/[id]/summarise.ts:76-270`
- Read-time-vs-frozen precedent: `src/app/(app)/projects/[id]/run-panel.tsx:195-207`
- Deferred link graph: `context/archive/2026-09-02-crawl-technical-checks/plan.md:87-89`
- The manual ritual this automates: `context/archive/2026-09-01-seo-metadata-checks/plan.md:389`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Run comparability metadata

#### Automated

- [x] 1.1 Schema applies cleanly: `npm run db:push` — 2f9d1b0
- [x] 1.2 Integration tests pass: `npm run test:integration` — 2f9d1b0
- [x] 1.3 Type checking passes: `npm run typecheck` — 2f9d1b0
- [x] 1.4 Lint and format pass: `npm run check` — 2f9d1b0
- [x] 1.5 A completed run has non-null `crawlComplete` and `scope`; a scoped project's run records its paths — 2f9d1b0

#### Manual

- [x] 1.6 The existing project page still renders against a dev database whose older runs have null columns

### Phase 2: Finding identity across runs

#### Automated

- [x] 2.1 Unit tests pass: `npm run test:unit` — 2b22815
- [x] 2.2 Type checking passes: `npm run typecheck` — 2b22815
- [x] 2.3 Lint and format pass: `npm run check` — 2b22815
- [x] 2.4 Every member of `FINDING_TYPES` has an asserted identity case — 2b22815
- [x] 2.5 `summarise.test.ts` and `correlate.test.ts` pass without modification — 2b22815

#### Manual

- [x] 2.6 The results view is visibly unchanged — same problems, same remainder, same counts

### Phase 3: The comparison, server-side

#### Automated

- [x] 3.1 Unit tests pass: `npm run test:unit` — 1806a98
- [x] 3.2 Integration tests pass: `npm run test:integration` — 1806a98
- [x] 3.3 Type checking passes: `npm run typecheck` — 1806a98
- [x] 3.4 Lint and format pass: `npm run check` — 1806a98
- [x] 3.5 Two consecutive runs over an unchanged fixture produce zero `new` and zero `resolved` — 1806a98
- [x] 3.6 A scope change between runs produces `comparable: false`, reason `scope_changed` — 1806a98
- [x] 3.7 Existing crawl and router tests pass unmodified — 1806a98

#### Manual

- [x] 3.8 No regression in run duration on a fixture crawl — the comparison does no crawling

### Phase 4: Run history and the diff in the view

#### Automated

- [x] 4.1 Unit tests pass: `npm run test:unit` — 4daf622
- [x] 4.2 Integration tests pass: `npm run test:integration` — 4daf622
- [x] 4.3 Existing e2e journeys pass unmodified: `npm run test:e2e` — 4daf622
- [x] 4.4 Type checking passes: `npm run typecheck` — 4daf622
- [x] 4.5 Lint and format pass: `npm run check` — 4daf622
- [x] 4.6 Production build succeeds: `npm run build` — 4daf622
- [x] 4.7 Every `ComparabilityReason` has a rendered sentence — 4daf622

#### Manual

- [x] 4.8 A project with one run renders exactly as before, with no history list and no markers
- [x] 4.9 Selecting an older run shows that run's findings and stops the panel polling
- [x] 4.10 Starting a check while viewing an older run still works and returns the view to the new run
- [x] 4.11 After a second run over an unchanged site, every finding reads as still present and none as new
- [x] 4.12 A run whose predecessor has null metadata shows the refusal sentence, not an empty area

### Phase 5: Real-site proof

#### Automated

- [x] 5.1 Whole suite passes: `npm run test:all` — bdcdeca
- [x] 5.2 Type checking passes: `npm run typecheck` — bdcdeca
- [x] 5.3 Lint and format pass: `npm run check` — bdcdeca
- [x] 5.4 No temporary scripts or harnesses remain in the working tree — bdcdeca

#### Manual

- [x] 5.5 Two runs over an unchanged real site report zero new and zero resolved findings
- [x] 5.6 Any finding that *is* reported as changed is traceable to a change on the site
- [x] 5.7 Narrowing the project scope produces the refusal, not a large resolved count
- [x] 5.8 Neither run degrades the client site — pacing unchanged from previous runs
- [x] 5.9 The annotated view is readable at real volume, not just at fixture volume
