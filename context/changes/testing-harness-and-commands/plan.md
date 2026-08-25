# Test Harness and Commands — Implementation Plan

Rollout Phase 1 of `context/foundation/test-plan.md`. Covers **R4**.

## Current State Analysis

- 47 tests in 4 files, all under `src/server/`. `src/app/` has none.
- `vitest.config.ts` runs everything through one `globalSetup` that creates a
  `-test` Postgres database, so even a pure-logic test cannot run without Docker.
- Two test files (`crawler`, `findings`) need nothing external; two (`project`,
  `run`) need Postgres. Nothing distinguishes them at the command level.
- No browser tooling. The one criterion left open from S-01 — progress appearing
  without a manual reload — is unverifiable without a real browser, because the
  in-app pane never composites.

## Desired End State

`npm run test:unit` runs with no Docker and no browsers. `npm run test:e2e`
drives a real browser through sign in, create project, run check, read findings,
against an isolated database that can never be the developer's own.

## What We're NOT Doing

- **Auth and abuse behaviours** — wrong passwords, enumeration, cross-tenant
  identifiers, partial accounts. That is rollout Phase 2.
- **Detection-rule breadth** — Phase 3.
- **Adversarial crawl conditions** — Phase 4.
- **Visual or snapshot assertions.** The product does visual regression on client
  sites; snapshotting its own pages would be brittle and catch little.
- **CI wiring.** No pipeline exists yet.

## Implementation Approach

**Commands split by what must be running, not by speed.** A contributor with no
Docker should still get real signal. That means the unit bucket cannot share the
database `globalSetup`, so it needs its own config rather than a filter flag.

**End-to-end gets its own database, and the guard is structural.** The dev server
under test starts with `DATABASE_URL` pointed at an `-e2e` database on a
non-default port, so a suite that truncates tables can never reach the
developer's data. Same reasoning as the existing `-test` guard, which already
caught one real misconfiguration.

**Assertions describe what a user can see and do.** Roles and visible text, never
markup structure. A test coupled to class names breaks on restyle and catches
nothing, which is the anti-pattern the test plan names for this risk.

## Phase 1: Command split

### Changes Required:

#### 1. Unit config without database setup

**File**: `vitest.unit.config.ts` (new)

**Intent**: Let pure-logic tests run with nothing installed but Node.

**Contract**: Same aliases and dependency inlining as the main config, no
`globalSetup`, and an include list covering only tests that need no external
service.

#### 2. Integration config

**File**: `vitest.integration.config.ts` (new)

**Intent**: The database-dependent bucket, explicitly named.

**Contract**: The existing behaviour — `globalSetup`, `-test` database,
`fileParallelism: false` — restricted to the tests that need it.

#### 3. Scripts

**File**: `package.json`

**Contract**: `test:unit`, `test:integration`, `test:e2e`, `test` running all
buckets in sequence, and `test:watch`.

### Success Criteria:

#### Automated Verification:

- `npm run test:unit` passes with the database container stopped
- `npm run test:integration` passes and covers the database-dependent tests
- `npm run test` runs every bucket and reports the combined result
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`

#### Manual Verification:

- Test counts across the buckets add up to the previous single-suite total

---

## Phase 2: Playwright harness

### Changes Required:

#### 1. Playwright and its config

**Files**: `playwright.config.ts` (new), `package.json`

**Intent**: A real browser, against an isolated stack.

**Contract**: `webServer` starts the app on a non-default port with
`DATABASE_URL` pointed at an `-e2e` database. Traces on first retry. One browser
project — more browsers cost minutes and add no signal for an internal tool.

#### 2. Environment setup

**File**: `e2e/global-setup.ts` (new)

**Intent**: A known starting state, and a guard that makes the wrong database
impossible rather than unlikely.

**Contract**: Refuses to run unless the target database name ends in `-e2e`.
Creates it if absent, applies the schema, clears domain tables, seeds one owner
with a known password.

#### 3. A crawlable site for the browser to point at

**File**: `e2e/fixture-server.ts` (new)

**Intent**: The journey needs a site whose findings are known in advance.

**Contract**: Wraps the existing `test/fixtures/site.ts` so it can run alongside
the browser and hand its base URL to a test. Reusing the fixture keeps one
description of what each finding means.

### Success Criteria:

#### Automated Verification:

- `npm run test:e2e` starts the app, runs, and exits cleanly
- The e2e database is created and is not the development one
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`

#### Manual Verification:

- The development database is untouched after an e2e run

---

## Phase 3: The user journey

### Changes Required:

#### 1. Signed-in fixture

**File**: `e2e/fixtures.ts` (new)

**Intent**: Every journey starts signed in. Repeating that inline would make the
sign-in flow the thing most likely to break the suite for unrelated reasons.

**Contract**: A Playwright fixture that signs in through the real form rather
than by injecting a cookie, so the sign-in path is exercised on every run.
Unique per-test data wherever a test creates something, so parallel runs and
re-runs cannot collide.

#### 2. The journey

**File**: `e2e/journeys/first-crawl.spec.ts` (new)

**Intent**: Prove the thing the product exists to do.

**Contract**: Sign in, create a project against the fixture site, trigger a
check, wait for completion, and assert a specific known finding is visible and
legible. Waits on state, never on elapsed time. Also asserts the progress state
appears without a reload, closing the one S-01 criterion no other tool verified.

#### 3. The empty-result journey

**File**: `e2e/journeys/clean-run.spec.ts` (new)

**Intent**: A clean result is an outcome, not an absence.

**Contract**: A project whose site has nothing wrong reports "nothing found"
with an explanation, distinguishable from a failed run.

### Success Criteria:

#### Automated Verification:

- The journey passes: sign in, create, run, read a named finding
- The clean-run journey passes and asserts explanatory text, not an empty list
- Progress is observed changing without a page reload
- Both journeys pass when run twice in a row without manual cleanup
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`

#### Manual Verification:

- A deliberate break in the create form fails the journey rather than passing it
- Trace output is usable when a journey fails

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append the commit sha when a step lands.

### Phase 1: Command split

#### Automated

- [x] 1.1 `npm run test:unit` passes with the database container stopped — adea821
- [x] 1.2 `npm run test:integration` passes and covers the database-dependent tests — adea821
- [x] 1.3 `npm run test` runs every bucket and reports the combined result — adea821
- [x] 1.4 Type checking passes: `npm run typecheck` — adea821
- [x] 1.5 Linting passes: `npm run check` — adea821

#### Manual

- [x] 1.6 Test counts across buckets add up to the previous single-suite total — adea821

### Phase 2: Playwright harness

#### Automated

- [x] 2.1 `npm run test:e2e` starts the app, runs, and exits cleanly — 5 passed in 39s — 52563f8
- [x] 2.2 The e2e database is created and is not the development one — `sitesmith-studio-e2e` created alongside `-test` and dev — 52563f8
- [x] 2.3 Type checking passes: `npm run typecheck` — 52563f8
- [x] 2.4 Linting passes: `npm run check` — 0 errors — 52563f8

#### Manual

- [x] 2.5 The development database is untouched after an e2e run — tenant/user rows byte-identical to the pre-run snapshot — 52563f8

### Phase 3: The user journey

#### Automated

- [x] 3.1 The journey passes: sign in, create, run, read a named finding — 52563f8
- [x] 3.2 The clean-run journey passes and asserts explanatory text — 52563f8
- [x] 3.3 Progress is observed changing without a page reload — settles S-01 criterion 5.6 — 52563f8
- [x] 3.4 Both journeys pass when run twice without manual cleanup — three consecutive runs, no cleanup — 52563f8
- [x] 3.5 Type checking passes: `npm run typecheck` — 52563f8
- [x] 3.6 Linting passes: `npm run check` — 52563f8

#### Manual

- [x] 3.7 A deliberate break in the create form fails the journey — locales split on `;` — caught by the evidence-line assertion — 52563f8
- [x] 3.8 Trace output is usable when a journey fails — the captured page state is how the 403 below was found — 52563f8

## What the first browser run found

Both of these were live defects, not test-harness friction. Neither was
reachable from the unit or integration buckets, and neither was visible to the
in-app browser pane used during S-01 — which is the case for adding this layer.

**1. `next dev` 403s its own chunks when addressed as `127.0.0.1`.**
The dev server serves build output only to origins it trusts, and the loopback
IP is not one of them by default. Pages rendered, every chunk failed, React
never hydrated, and the app silently ignored clicks. Fixed by addressing the
server as `localhost` in `playwright.config.ts` rather than by adding
`allowedDevOrigins` to shipped configuration. Worth knowing because the failure
presents as a correct-looking page rather than as an error.

**2. The run button was offered before its precondition was known.**
`latestRun` is not prefetched, so server-rendered markup showed an enabled
"Run a check" while the client still had no idea whether a run was already in
progress — pressing it in that window earned a conflict error the user did
nothing to cause. The button now holds until the query settles, which also
removes the need for any wait in the tests: Playwright's actionability check
already waits for enabled.

## Known limit

Criterion 3.7 broke locale parsing and only one of the three journey tests
failed. The other two assert finding-category headings, which survive a garbled
locale list because *something* is still reported missing. The evidence-line
assertion — the one naming `fr` — is what actually pins behaviour. Category
headings are a weaker class of assertion and should not be mistaken for one.
