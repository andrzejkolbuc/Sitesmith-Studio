# First Multilingual Crawl Implementation Plan

## Overview

Let an Owner define a crawlable project, run a check against it in the background, and see
which pages are missing a language variant. This is roadmap item S-01, the north star: the
smallest end-to-end flow that proves the core product idea, and the first finding the product
makes that no free tool makes.

## Current State Analysis

F-01 landed tenancy, sign-in and a read-only project list. Everything the crawl needs is
absent.

- **`projects` has four columns** — id, tenantId, name, timestamps
  (`src/server/db/schema.ts:132`). Start URL, crawl scope, declared locales and rate limits all
  have nowhere to live. There are no runs, pages or findings tables.
- **Nothing can run for minutes.** The app is Next request handlers plus tRPC. A crawl of
  400-1,200 URLs will outlive any request. F-02 (the container that will eventually host this)
  is `ready` on the roadmap but not built, so this change cannot assume it.
- **The scoping pattern is established and must be followed.** Every domain table carries
  `tenantId`; every router builds on `tenantProcedure` and composes `tenantScope`
  (`src/server/api/trpc.ts`). `src/server/api/routers/project.ts` is the reference example.
- **Test infrastructure exists.** vitest, an isolated `-test` database created by
  `test/global-setup.ts`, and a working cross-tenant isolation test. New tests inherit all of
  it; the only new thing this change needs is a fixture site to crawl.
- **`scripts/seed-owner.ts` establishes the script pattern** — plain Node running TypeScript
  natively, opening its own database connection because `~/env` is a path alias Node cannot
  resolve.

## Desired End State

An Owner creates a project with a start URL and a list of expected locales, triggers a run, and
watches it complete. The run reports which pages are missing one or more language variants,
with the evidence for each. The crawl never exceeds the configured request ceiling and stops
itself if the target site starts failing.

Verify by: creating a project against the fixture site, triggering a run, and seeing exactly the
missing-variant findings the fixture was built to produce; then pointing it once at a real
client site and recording how long a full run takes.

### Key Discoveries:

- `src/server/api/trpc.ts` — `tenantProcedure` and `tenantScope` are the mandatory entry points
  for any new router; `tenantScope` takes the table, so every new table needs a `tenantId`
  column named exactly that.
- `src/server/db/schema.ts:11` — `createTable` applies the `sitesmith-studio_` prefix. A table
  declared without it will not be found.
- `src/server/api/routers/project.test.ts` — the existing integration test shows the
  `createCaller` pattern with a fabricated context, which the run tests reuse.
- `vitest.config.ts` — `fileParallelism: false`, because integration tests share one database.
  A fixture HTTP server must therefore pick a free port rather than a fixed one only if tests
  ever run in parallel; today they do not.
- Drizzle is push-based (`db:push`, no migrations directory).

## What We're NOT Doing

- **robots.txt.** Considered and declined. The crawl will not consult it. Robots validation
  arrives as a *finding* in S-04; honouring it as a *constraint* is a separate decision that was
  made deliberately, not overlooked.
- **A distinct user-agent.** Also declined. Consequence accepted: the crawler's traffic is not
  attributable in a client's logs, and a host cannot allowlist it specifically.
- **Sitemap-based discovery.** Link-following only. Sitemap reconciliation is FR-017 in S-04.
- **Resuming an interrupted run.** Interrupted runs are marked failed; the user re-triggers.
- **Any check other than missing-variant.** No broken links, no metadata, no performance, no
  console errors. Those are S-02 through S-06.
- **Run-over-run comparison.** Runs are stored (FR-036) but nothing compares them yet; that is
  S-07.
- **A configuration UI for crawl paths and rate limits.** Sensible defaults, adjustable via the
  seed script. Forms can be added later without rework.
- **Scheduled or unattended runs.** On-demand trigger only; scheduling is S-13 and needs F-02.
- **Multi-instance or queue-backed execution.** One process, in-memory job. The PRD's non-goals
  rule out horizontal scale.

## Implementation Approach

The crawl runs as a background task inside the Node process, with the run row as its state. A
trigger inserts a run marked `queued`, starts the work without awaiting it, and returns
immediately; the crawler advances the row through `running` to `done` or `failed`. This needs
no new infrastructure, behaves the same in development as in the container F-02 will add, and
reuses the run row that FR-036 requires anyway.

Its known weakness is that a process restart mid-crawl orphans the run. That is handled rather
than solved: on boot, any run still marked `running` is closed as `interrupted`. Partial work is
discarded and the user re-triggers. Resuming was considered and rejected — the state required to
resume correctly is substantial, and the case should be rare on a single-operator tool.

**The project declares its expectations; each run records what it observed.** The project stores
which locales it expects to exist. Each run derives page groupings from that run's own hreflang
declarations. This split is what makes a missing variant detectable at all: without a declared
expectation there is nothing to be missing, and a locale that vanished entirely would look like
a site that never had it.

**Politeness is part of the crawl, not a wrapper around it.** A concurrency ceiling and an
inter-request delay are enforced inside the fetch loop, and a burst of failures aborts the run
rather than continuing. NFR-1 says causing a client incident is worse than the regression being
hunted, and this is the first code in the product that touches someone else's production site.

**Tests crawl a fixture site served from the test process.** Deliberate HTML with correct
hreflang, broken hreflang, and a genuinely missing variant. Stubbing the fetch layer was
rejected: it would leave concurrency, delay and abort-on-failure — the exact NFR-1 machinery —
untested.

## Critical Implementation Details

**The fourth missing-variant rule is deliberately narrowed.** "A page has no hreflang at all"
fires only for pages whose URL already implies a locale (`/de/…`, `/fr-ca/…`). Applied
unnarrowed on a site with a blog it would fire on every legitimately monolingual page, and the
first run anyone looks at would be mostly noise. The PRD names false-positive fatigue as fatal
and severity triage was declined, so detection logic is the only defence available.

**Run state must be written before the work starts.** The trigger inserts the run and returns
the id, then begins crawling. Starting the crawl first and inserting afterwards would leave a
window where a crawl is running with nothing recording it — invisible to the stale-run sweep and
impossible to report on.

**Grouping needs a stable key across locales.** Two pages belong to the same group if either
declares the other via hreflang. The group key must therefore be derived from the hreflang graph
rather than from any single URL, or the same group would key differently depending on which page
was crawled first.

## Phase 1: Crawl schema

### Overview

Everything the crawl reads and writes, defined before any crawling code exists.

### Changes Required:

#### 1. Project crawl configuration

**File**: `src/server/db/schema.ts`

**Intent**: Give a project the settings a crawl needs — where to start, what is in scope, which
locales are expected, and how hard the crawler may push.

**Contract**: Extend `projects` with: `startUrl` (not null — a project without one cannot be
crawled), `includePaths` and `excludePaths` (arrays or JSON, defaulting to empty), `locales`
(array of BCP-47 tags, the declared expectation FR-024 measures against), `maxConcurrency` and
`requestDelayMs` (both with defaults conservative enough to be safe unset). Existing rows have no
start URL, so either default it or accept that the one seeded project needs updating.

#### 2. Runs, pages and findings

**File**: `src/server/db/schema.ts`

**Intent**: Record each execution, what it saw at each URL, and what it concluded.

**Contract**: Three tables, each carrying `tenantId` (named exactly that, so `tenantScope`
applies) plus a `projectId`:

- `runs` — status (`queued` / `running` / `done` / `failed` / `interrupted`), `startedAt`,
  `finishedAt`, counts of pages crawled and findings produced, and an error field for the abort
  reason.
- `pages` — `runId`, `url`, `httpStatus` (FR-014), the locale detected for it, the variant group
  key, and the hreflang targets it declared. One row per URL crawled.
- `findings` — `runId`, a `type` discriminator, an optional `pageId`, and a detail payload
  carrying the evidence. Findings are first-class rows because every later slice reads them.

Index `runId` on both `pages` and `findings`, and `projectId` on `runs`. Add relations so scoped
queries traverse without manual joins.

### Success Criteria:

#### Automated Verification:

- Schema pushes cleanly: `npm run db:push`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`
- Existing isolation test still passes: `npm run test`

#### Manual Verification:

- `runs`, `pages` and `findings` exist with the `sitesmith-studio_` prefix
- Every new table has a `tenantId` column and a foreign key to `tenants`
- `tenantScope(runs, …)` compiles — proving the new tables satisfy the scoping helper

**Implementation Note**: After completing this phase and all automated verification passes,
pause here for manual confirmation from the human that the manual testing was successful before
proceeding to the next phase.

---

## Phase 2: Crawl engine and fixture site

### Overview

The part that touches other people's infrastructure. Built and proven against a fixture before
it ever points at a real site.

### Changes Required:

#### 1. Fixture site

**File**: `test/fixtures/site.ts` (new)

**Intent**: A small, deliberately-imperfect multilingual site served over HTTP from the test
process, so the crawler can be tested end to end without touching anything real.

**Contract**: An HTTP server started and stopped by the test, listening on an ephemeral port and
returning its base URL. Serves roughly a dozen interlinked pages covering: a healthy group with
all locales present and reciprocal hreflang; a group where one declared locale is absent; a page
whose hreflang points at a URL that 404s; a page whose hreflang points outside the crawl scope; a
locale-shaped URL with no hreflang at all; a monolingual page with no hreflang (which must NOT be
flagged); and a slow endpoint plus a burst of 500s for testing delay and abort. The fixture is
the specification of what each finding means — comment it accordingly.

#### 2. Fetch and discovery

**File**: `src/server/crawl/crawler.ts` (new)

**Intent**: Walk the site breadth-first from the start URL, staying inside the configured scope,
recording status and hreflang for every URL reached.

**Contract**: Given a start URL, include/exclude paths and a limit, returns one record per URL
containing final URL, HTTP status, declared hreflang targets, and any fetch error. Normalises
URLs before deduplicating (trailing slash, fragment, and — decide once and document — whether
query strings are significant), or the same page will be crawled repeatedly under different
spellings. Follows same-origin links only. Stops at the URL ceiling.

#### 3. Politeness controls

**File**: `src/server/crawl/crawler.ts`

**Intent**: Satisfy NFR-1 — the crawl must not be capable of degrading the site it checks.

**Contract**: No more than `maxConcurrency` requests in flight, and at least `requestDelayMs`
between request starts. A sustained burst of failures (consecutive 5xx or timeouts, threshold
decided during implementation and documented) aborts the crawl, marking the run `failed` with the
reason recorded. A per-request timeout so one hanging response cannot stall the run. These are
enforced inside the fetch loop, not by callers.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`
- Crawler reaches every in-scope fixture page and no out-of-scope page
- Excluded paths are not fetched
- Concurrency never exceeds the configured ceiling during a fixture crawl
- Inter-request delay is observed
- A fixture burst of 500s aborts the crawl rather than continuing
- A URL reachable by two spellings is crawled once

#### Manual Verification:

- Pointing the crawler at one real client site at low concurrency completes without errors
  appearing in that site's monitoring
- Recorded page count is plausible against the site's known size

**Implementation Note**: After completing this phase and all automated verification passes,
pause here for manual confirmation from the human that the manual testing was successful before
proceeding to the next phase.

---

## Phase 3: Variant grouping and missing-variant findings

### Overview

The domain rule — the reason this product exists rather than being a rebuild of an existing one.

### Changes Required:

#### 1. Variant grouping

**File**: `src/server/crawl/variants.ts` (new)

**Intent**: Decide which crawled pages are translations of one another, from the site's own
declarations.

**Contract**: Given the crawl records, produces a group key and a detected locale per page. Two
pages share a group if either declares the other via hreflang — the relation is treated as
symmetric, because real sites frequently declare it in only one direction. Falls back to URL
pattern (locale segment) where hreflang is absent. The group key must not depend on crawl order.
Pages that group with nothing are their own group.

#### 2. Missing-variant detection

**File**: `src/server/crawl/findings.ts` (new)

**Intent**: Produce the finding this whole slice exists for, in four distinct forms.

**Contract**: Emits a finding for each of:

1. A locale the project declares, with no page in this group.
2. An hreflang target whose crawled status was an error.
3. An hreflang target the crawl never reached, excluding URLs outside the configured scope.
4. A page with no hreflang at all — **only** where the URL implies a locale. See Critical
   Implementation Details for why this one is narrowed.

Each finding carries enough evidence to be actionable on its own: which group, which locale,
which URL, and what was expected versus observed. A monolingual page with no hreflang and no
locale in its URL must produce nothing.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`
- Grouping is identical regardless of the order pages are supplied
- A one-directional hreflang declaration still groups both pages
- Each of the four rules fires exactly once on the fixture site
- The monolingual fixture page produces no finding
- The out-of-scope hreflang target does not fire rule 3

#### Manual Verification:

- Running detection against one real client site produces findings that are recognisably true
- The volume of rule-4 findings is small enough to read

**Implementation Note**: After completing this phase and all automated verification passes,
pause here for manual confirmation from the human that the manual testing was successful before
proceeding to the next phase.

---

## Phase 4: Run orchestration

### Overview

Turning the crawler into something a user triggers and a run row records. This is also the
phase that finally answers how long a real run takes.

### Changes Required:

#### 1. Run lifecycle

**File**: `src/server/crawl/run.ts` (new)

**Intent**: Own the transitions a run makes, so no other code writes run status directly.

**Contract**: Starting a run inserts it as `queued` and returns the id **before** any crawling
begins (see Critical Implementation Details). It then moves to `running`, and finally to `done`,
`failed` (with the abort reason) or `interrupted`. Persists pages and findings as the crawl
produces them, so a partial run still shows what it managed. Every write carries the run's
tenant.

#### 2. Trigger and read procedures

**File**: `src/server/api/routers/project.ts`

**Intent**: Let the Owner start a run and read what it found, through the scoped API.

**Contract**: Extend `projectRouter` — all on `tenantProcedure`, composing `tenantScope`:
`startRun` (a mutation, returns the run id, refuses if a run for that project is already active),
`runStatus` (progress for polling), `latestRun`, and `findings` for a given run. A run belonging
to another tenant must be unreachable through every one of these.

#### 3. Stale-run sweep

**File**: `src/server/crawl/run.ts`, invoked at application start

**Intent**: Ensure a run interrupted by a restart cannot appear to be running forever.

**Contract**: On boot, any run in `running` or `queued` is closed as `interrupted`. Runs in
progress cannot survive a restart, so any such row is by definition stale. Where this hooks in
depends on the Next runtime and should be chosen during implementation — the requirement is that
it runs once per process start, not per request.

#### 4. Project crawl config in the seed script

**File**: `scripts/seed-owner.ts`

**Intent**: Provide a way to set start URL, scope and rate limits without building forms.

**Contract**: Extend the existing script, or add a sibling, that creates or updates a project's
crawl configuration. Same conventions as the current script: own database connection, idempotent
on re-run.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`
- A triggered run against the fixture site completes and reaches `done`
- Pages and findings are persisted and readable through the API
- A second trigger while a run is active is refused
- Runs left `running` are closed as `interrupted` by the sweep
- Another tenant cannot read a run, its pages or its findings through any procedure

#### Manual Verification:

- A run triggered against a real client site completes, and **its duration is recorded** — the
  measurement the requirements have been unable to supply
- Restarting the process mid-run leaves the run marked `interrupted`, not `running`

**Implementation Note**: After completing this phase and all automated verification passes,
pause here for manual confirmation from the human that the manual testing was successful before
proceeding to the next phase.

---

## Phase 5: Project and results UI

### Overview

The first time any of this is visible. Deliberately thin.

### Changes Required:

#### 1. Create a project

**File**: `src/app/(app)/projects/new/page.tsx` (new)

**Intent**: Satisfy FR-006 — an Owner can create a project — with the minimum a crawl needs.

**Contract**: A form taking name, start URL and expected locales, posting to a create mutation on
`tenantProcedure`. Include/exclude paths and rate limits are not on this form; they take defaults
and are adjustable via the seed script. Validate the start URL is a well-formed absolute URL
before accepting it.

#### 2. Project detail with trigger and results

**File**: `src/app/(app)/projects/[id]/page.tsx` (new)

**Intent**: Trigger a run and read what it found — the payoff for the whole change.

**Contract**: Shows the project, a control that starts a run, the current run's status while it
progresses, and the findings of the latest completed run grouped so a page's problems read
together. Findings must be legible without opening the database: which page, which locale, what
was expected. An empty result after a successful run is a real outcome and must be stated as
such, not shown as a blank list.

#### 3. Link projects to their detail pages

**File**: `src/app/(app)/projects/page.tsx`

**Intent**: Make the existing list a way in.

**Contract**: Each project links to its detail page; add a link to the create form. The empty
state, which currently says projects arrive later, should now point at the create form instead.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`
- Build succeeds: `npm run build`
- Full test suite passes: `npm run test`

#### Manual Verification:

- Creating a project through the form produces a crawlable project
- Triggering a run shows progress and then findings without a page reload being required to see
  completion
- The findings shown match what the fixture or real site actually contains
- A signed-in Owner from another tenant cannot reach this project's detail page by URL
- A completed run with nothing wrong reads as "nothing found", not as an error or a blank page

**Implementation Note**: After completing this phase and all automated verification passes,
pause here for manual confirmation from the human that the manual testing was successful. This
is the final phase.

---

## Testing Strategy

### Unit Tests:

- Variant grouping: order independence, one-directional hreflang, URL-pattern fallback, pages
  that group with nothing.
- Finding rules: each of the four fires on its intended fixture case and on nothing else. The
  monolingual page producing no finding is the single most important negative assertion in this
  change — it is the guard on the narrowing decision.
- URL normalisation: two spellings of one page resolve to one entry.

### Integration Tests:

- A full crawl of the fixture site through the run lifecycle: trigger, complete, persist, read
  back through the API.
- Politeness: concurrency never exceeds the ceiling; delay is observed; a burst of 500s aborts.
- Tenant isolation across every new procedure, following the pattern already in
  `src/server/api/routers/project.test.ts`.
- Stale-run sweep closes a run left `running`.

### Manual Testing Steps:

1. Seed a project pointing at the fixture site; trigger a run; confirm the findings match what
   the fixture was built to contain.
2. Create a project through the UI with a real client site; trigger a run; **record the
   duration**.
3. Read the findings and judge honestly whether they are ones you would act on.
4. Count the rule-4 (no hreflang) findings on that real site. If the volume is unreadable, the
   narrowing was insufficient and the rule needs revisiting before more check types land on top
   of it.
5. Restart the process mid-run; confirm the run reads `interrupted`.
6. Sign in as an Owner of a different tenant; confirm the project detail URL is unreachable.

## Performance Considerations

The run-duration question the requirements have been unable to answer is answered in Phase 4,
by measurement rather than estimate. Two levers exist if the answer is bad: raising concurrency,
which trades against NFR-1, and reducing what is fetched. Do not tune either before there is a
number.

Persisting pages as the crawl produces them rather than in one batch at the end keeps memory flat
across a 1,200-URL run and means an aborted run still shows its partial results.

## Migration Notes

Drizzle is push-based; `npm run db:push` applies the schema directly. The one existing seeded
project has no start URL — either give the column a default or update that row. No production
deployment exists, so rollback is re-pushing a corrected schema.

## References

- Roadmap item: `context/foundation/roadmap.md` § S-01
- Requirements: `context/foundation/prd.md` — US-01, FR-006, FR-007, FR-008, FR-011, FR-012,
  FR-013, FR-014, FR-024, FR-036, NFR-1
- Prior change (tenancy this builds on):
  `context/archive/2026-08-21-tenant-scoped-owner-signin/plan.md`
- Scoping helpers every new router must use: `src/server/api/trpc.ts`
- Reference router and integration-test pattern: `src/server/api/routers/project.ts`,
  `project.test.ts`
- Script conventions for the seed extension: `scripts/seed-owner.ts`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Crawl schema

#### Automated

- [ ] 1.1 Schema pushes cleanly: `npm run db:push`
- [ ] 1.2 Type checking passes: `npm run typecheck`
- [ ] 1.3 Linting passes: `npm run check`
- [ ] 1.4 Existing isolation test still passes: `npm run test`

#### Manual

- [ ] 1.5 `runs`, `pages` and `findings` exist with the `sitesmith-studio_` prefix
- [ ] 1.6 Every new table has a `tenantId` column and a foreign key to `tenants`
- [ ] 1.7 `tenantScope(runs, …)` compiles

### Phase 2: Crawl engine and fixture site

#### Automated

- [ ] 2.1 Type checking passes: `npm run typecheck`
- [ ] 2.2 Linting passes: `npm run check`
- [ ] 2.3 Crawler reaches every in-scope fixture page and no out-of-scope page
- [ ] 2.4 Excluded paths are not fetched
- [ ] 2.5 Concurrency never exceeds the configured ceiling during a fixture crawl
- [ ] 2.6 Inter-request delay is observed
- [ ] 2.7 A fixture burst of 500s aborts the crawl rather than continuing
- [ ] 2.8 A URL reachable by two spellings is crawled once

#### Manual

- [ ] 2.9 A real client site crawls at low concurrency without errors in its monitoring
- [ ] 2.10 Recorded page count is plausible against the site's known size

### Phase 3: Variant grouping and missing-variant findings

#### Automated

- [ ] 3.1 Type checking passes: `npm run typecheck`
- [ ] 3.2 Linting passes: `npm run check`
- [ ] 3.3 Grouping is identical regardless of the order pages are supplied
- [ ] 3.4 A one-directional hreflang declaration still groups both pages
- [ ] 3.5 Each of the four rules fires exactly once on the fixture site
- [ ] 3.6 The monolingual fixture page produces no finding
- [ ] 3.7 The out-of-scope hreflang target does not fire rule 3

#### Manual

- [ ] 3.8 Findings against a real client site are recognisably true
- [ ] 3.9 The volume of rule-4 findings is small enough to read

### Phase 4: Run orchestration

#### Automated

- [ ] 4.1 Type checking passes: `npm run typecheck`
- [ ] 4.2 Linting passes: `npm run check`
- [ ] 4.3 A triggered run against the fixture site completes and reaches `done`
- [ ] 4.4 Pages and findings are persisted and readable through the API
- [ ] 4.5 A second trigger while a run is active is refused
- [ ] 4.6 Runs left `running` are closed as `interrupted` by the sweep
- [ ] 4.7 Another tenant cannot read a run, its pages or its findings through any procedure

#### Manual

- [ ] 4.8 A run against a real client site completes and its duration is recorded
- [ ] 4.9 Restarting the process mid-run leaves the run marked `interrupted`

### Phase 5: Project and results UI

#### Automated

- [ ] 5.1 Type checking passes: `npm run typecheck`
- [ ] 5.2 Linting passes: `npm run check`
- [ ] 5.3 Build succeeds: `npm run build`
- [ ] 5.4 Full test suite passes: `npm run test`

#### Manual

- [ ] 5.5 Creating a project through the form produces a crawlable project
- [ ] 5.6 Triggering a run shows progress and then findings without a manual reload
- [ ] 5.7 The findings shown match what the site actually contains
- [ ] 5.8 An Owner from another tenant cannot reach the project detail page by URL
- [ ] 5.9 A clean run reads as "nothing found", not as an error or a blank page
