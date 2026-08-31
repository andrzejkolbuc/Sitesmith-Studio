# Page identity under redirects — Implementation Plan

## Overview

Establish page identity once — the URL the server actually served — and apply it
consistently everywhere the crawl currently assumes "the URL we asked for":
what gets recorded, what counts as already seen, and what relative hrefs resolve
against. Then remove a second, independent defect in rule 5. Then prove both
against the site that surfaced them.

## Current State Analysis

From `frame.md`, verified against code and live data:

- `crawler.ts:236` returns the **requested** URL after fetching with
  `redirect: "follow"`. `/bg/careers` serves 200 from `/bg/karieri`; both are
  stored as separate pages.
- `crawler.ts:324–326` fills the `seen` set at **enqueue** time, before any
  request, so two routes to one page are two visits.
- `crawler.ts:238–239` resolves hreflang and links against the requested URL. On
  a redirected page every relative href therefore resolves against the wrong
  base. Invisible on yazaki, which publishes absolute hrefs; latent everywhere
  else.
- `schema.ts:293–295` gives `pages` three plain indexes and **no uniqueness**.
  The yazaki run's 569 rows / 569 distinct URLs are unique only because the
  frontier deduped them.
- `findings.ts` rule 5 tests `member.declares.has(sibling.url)` — a URL
  comparison, where the question is about a language.

The consequence, measured: 4 `hreflang_family_inconsistent` findings on
yazaki-emea.com, all false, all under `/careers`, where families swelled to 19
members because each page is served at both an English and a localised slug.

## Desired End State

A page is the URL the server served. Two routes to it produce one row, one
family member, and one entry in the page count. Rule 5 asks whether a page
declares a *language*, so it stays quiet when a family legitimately holds two
URLs for one locale.

Verified by: the suite green; a fixture that serves redirects proving each
property; and a re-crawl of yazaki-emea.com where the 4 false findings are gone,
the 8 genuine divergences remain, and the page count falls.

### Key Discoveries

- Recording the final URL **without** fixing dedup inserts two rows carrying the
  same URL — `run.ts:163` inserts per `onPage` with no conflict handling.
- `seen` is keyed pre-fetch, so the final URL is not knowable at the point the
  current dedup decision is made. The second dedup has to happen after the
  response.
- `extractHreflang` and `extractLinks` both take the base URL as an argument, so
  the relative-resolution fix is a change of argument, not of logic.
- FR-016 (`prd.md:206`) commits to reporting redirect chains in S-04. Recording
  the final URL is groundwork that slice needs; this change deliberately does
  not report anything about redirects.

## What We're NOT Doing

- **Not reporting redirects as findings.** FR-016 belongs to S-04. This change
  stops redirects distorting identity; it says nothing to the user about them.
- **Not remembering which aliases were requested.** An alias is a route, not a
  page. Recording them would mean a new column serving nothing until S-04.
- **Not pre-flighting URLs.** Learning the final URL with a HEAD before every
  GET would double the requests made against a client's site, against NFR-1.
- **Not deleting the existing yazaki run.** It stays as the before half of the
  comparison, and as an honest record of what the tool reported.
- **Not touching `normaliseUrl`.** A redirect is a server fact, not a spelling
  difference; canonicalisation cannot know it without asking.

## Implementation Approach

Identity is established at one point — the moment a response comes back — and
everything downstream uses it. The crawler keeps its existing pre-fetch dedup
(which still saves a request whenever two links spell the same URL) and gains a
second, post-fetch check against the final URL.

Order matters: the unique index lands in the same phase as the dedup fix, never
before it, or an alias-heavy crawl would start failing inserts.

Each phase is verified by a fixture that can actually produce the shape, then by
the real site in phase 3. The rule 5 change is kept separate so that if the
findings on yazaki change, it is unambiguous which fix caused it.

## Critical Implementation Details

**The two dedups do different jobs and both are needed.** The pre-fetch `seen`
check stops us requesting a URL we have already requested. The post-fetch check
stops us *recording* a page we have already recorded, and can only run once the
server has told us where the URL leads. Removing the first to "simplify" would
re-request every alias; removing the second is the bug being fixed.

**The page ceiling counts recorded pages, not requests.** With aliases discarded
after the fetch, a crawl can now make more requests than it records. That is
correct — the ceiling exists to bound what we store and report — but it means
`pagesCrawled` and the number of requests the client's server saw are no longer
the same number, and the politeness tests assert on the latter.

## Phase 1: Page identity in the crawl

### Overview

The crawl records the page the server served, deduplicates on it, and resolves
relative hrefs against it. Uniqueness becomes an enforced invariant.

### Changes Required

#### 1. Identity at the point of response

**File**: `src/server/crawl/crawler.ts`

**Intent**: Record the URL the server actually served rather than the one we
asked for, and resolve the page's hreflang and links against that same URL so a
redirected page's relative hrefs land in the right place.

**Contract**: `fetchOne` returns a `CrawledPage` whose `url` is
`normaliseUrl(response.url)`, falling back to the requested URL when the
response carries no usable URL. `extractHreflang` and `extractLinks` receive the
same final URL as their base. The `CrawledPage` shape is unchanged — no new
field — so nothing downstream needs to know a redirect happened.

#### 2. Dedup on the served page

**File**: `src/server/crawl/crawler.ts`

**Intent**: Stop two routes to one page becoming two pages, without spending an
extra request to find out.

**Contract**: After `fetchOne` returns and before the page is recorded, if its
final URL has already been recorded in this crawl, the result is discarded: not
pushed to `pages`, not passed to `onPage`, and its links not enqueued. The
existing pre-fetch `seen` check stays as it is. The final URL is added to the
recorded set so later aliases resolve against it.

A discarded alias must not count toward the failure-burst or failure-rate
counters, and must not advance the page ceiling — it produced no page.

#### 3. Uniqueness becomes enforced

**File**: `src/server/db/schema.ts`

**Intent**: Turn an invariant that was assumed into one the database refuses to
break, because assuming it is how this defect arrived.

**Contract**: A unique index on `pages (runId, url)`. Applied with
`npm run db:push`; the project has no migrations directory. Existing rows in the
development and test databases satisfy it already — the yazaki run has 569 rows
and 569 distinct URLs.

#### 4. A fixture that can redirect

**File**: `test/fixtures/site.ts`

**Intent**: Give the suite a shape it has never had. No existing fixture
redirects, which is why none of this was caught.

**Contract**: Additional paths that 301 to an existing canonical page — at least
one alias reachable by link and one reachable only through an hreflang
declaration, plus one page serving a *relative* href so the resolution fix has
something to prove. Every existing path and its declarations are left untouched;
the header already records that pages added here are paid for by every crawling
test.

#### 5. Cases covering identity

**File**: `src/server/crawl/crawler.test.ts`

**Intent**: State each property separately, so a failure names which one broke.

**Contract**: Cases for — a redirected URL is recorded under its final URL; an
alias reached after its canonical page produces no second page; an alias reached
*before* its canonical page produces one page, not two; a relative href on a
redirected page resolves against the final URL; the page ceiling counts recorded
pages; and a discarded alias does not count as a failure.

### Success Criteria

#### Automated Verification

- Cases fail before the change and pass after: `npm run test:unit`
- A redirected URL is recorded under the URL the server served
- Two routes to one page produce one page, in either arrival order
- A relative href on a redirected page resolves against the final URL
- A discarded alias advances neither the page ceiling nor the failure counters
- Mutation: reverting to the requested URL fails the identity cases
- Mutation: removing the post-fetch dedup fails the two-routes case
- Schema applies: `npm run db:push`
- Existing crawler, politeness and run tests pass unchanged
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`
- Whole suite passes: `npm run test:all`

#### Manual Verification

- A crawl of the fixture reports fewer pages than requests, and the difference
  equals the number of aliases

**Implementation Note**: After completing this phase and all automated
verification passes, pause for confirmation before proceeding.

---

## Phase 2: Rule 5 asks about languages, not URLs

### Overview

A family holding two URLs for one locale should not be reported as
non-reciprocal. Independent of phase 1, and separated from it so that a change
in findings can be attributed.

### Changes Required

#### 1. The comparison

**File**: `src/server/crawl/findings.ts`

**Intent**: Ask whether a member declares the *language* a sibling publishes,
rather than whether it declares that sibling's exact URL — which is the question
the finding text has always claimed to be asking.

**Contract**: Rule 5's per-pair check treats a sibling as declared when the
member declares any URL under the sibling's locale, using the same
regional-refinement rule `satisfies` already applies (`en-gb` answers `en`). A
sibling whose locale is unknown falls back to the current URL comparison, since
there is no language to compare. Defect kinds, ordering and the `siblingLocale`
evidence are unchanged.

#### 2. Cases covering the change

**File**: `src/server/crawl/site-shapes.test.ts`

**Intent**: Pin the new silence and, more importantly, prove the rule still
speaks when a language really is missing.

**Contract**: Cases for — a family with two URLs for one locale, both declared
by their siblings under that locale, produces nothing; a family where a member
declares no URL at all for a sibling's locale still reports it; and a regional
refinement answers the base language. Written against hand-built pages so the
case holds regardless of phase 1.

### Success Criteria

#### Automated Verification

- Cases fail before the change and pass after: `npm run test:unit`
- Two URLs for one locale, both declared, produce no finding
- A genuinely undeclared language is still reported
- Mutation: reverting to the URL comparison fails the two-URL case
- Every existing site-shape case passes unchanged
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`
- Whole suite passes: `npm run test:all`

#### Manual Verification

- Reading the rule's output on the fixture, no finding claims a page fails to
  link somewhere it does link

**Implementation Note**: Pause for confirmation before proceeding.

---

## Phase 3: Verify against the site that found it

### Overview

The before-and-after is the proof. Same site, same settings, findings compared.
This also produces the real-site evidence S-01's open criteria have been
waiting on.

### Changes Required

#### 1. A second run against yazaki-emea.com

**File**: none — an operation, not an edit

**Intent**: Establish that the fix works where the defect was found, and measure
how much of the page count was aliases.

**Contract**: A run through the application against the same project, with the
same locales and pacing. The existing run is left in place; the new one becomes
the latest and is what the interface shows. Comparison recorded in this plan.

#### 2. Record what it settles

**File**: `context/changes/first-multilingual-crawl/plan.md`

**Intent**: S-01 criteria 2.10 and 3.8 have been open for want of a finished
real-site crawl. This is one, and its findings can now be judged.

**Contract**: The real-site note in that plan gains the second run's numbers and
whichever criteria it closes. Criteria it does not close stay open with the
reason, as the existing note already does.

### Success Criteria

#### Automated Verification

- Whole suite passes: `npm run test:all`

#### Manual Verification

- The 4 `hreflang_family_inconsistent` findings under `/careers` are gone
- The 8 `variant_diverged` findings remain — they were genuine
- The recorded page count is lower than 569, and the difference is plausibly the
  alias count
- No finding in the new run names a page that, on inspection, is fine
- S-01's real-site note is updated with what this settles and what it does not

---

## Testing Strategy

### Unit Tests

- Identity properties stated one per case, each able to fail on its own.
- Both arrival orders for an alias — canonical first, alias first — because the
  post-fetch check behaves differently in each and only one is obvious.
- Rule 5's cases built from hand-written pages, so they hold whether or not the
  crawler change is present.
- Each change checked by mutation before it is trusted.

### Integration Tests

- A run through `runToCompletion` against the redirect-bearing fixture persists
  one row per served page, with the unique index in force.

### Manual Testing Steps

1. Crawl the fixture and confirm requests exceed recorded pages by the alias
   count.
2. Re-crawl yazaki-emea.com through the interface.
3. Compare the two runs' findings, and spot-check any finding that remains.

## Performance Considerations

An alias still costs one request — the fetch is what reveals it. Against
yazaki that is roughly 77 requests in the `/careers` cluster that now produce no
page. This is a deliberate trade: the alternative, a HEAD before every GET,
would double requests against every client site to save a fraction of them.

Discarding after the fetch also means the page ceiling now bounds recorded pages
rather than requests, so a heavily-aliased site makes more requests than the
ceiling suggests. Bounded by the same frontier, so it cannot run away.

## Migration Notes

The unique index is additive and satisfied by existing data in every database
(the yazaki run: 569 rows, 569 distinct URLs). Applied with `npm run db:push`;
there is no migrations directory. Runs recorded before this change keep the rows
they have — including the inflated yazaki run, which is retained deliberately as
the before half of the phase 3 comparison.

## References

- Frame brief: `context/changes/page-identity-under-redirects/frame.md`
- Lesson this is the fourth instance of: `context/foundation/lessons.md`
- `src/server/crawl/crawler.ts:220–253` — `fetchOne`
- `src/server/crawl/crawler.ts:324–326` — pre-fetch dedup
- `src/server/db/schema.ts:293–295` — page indexes
- `src/server/crawl/findings.ts` — rule 5
- `context/foundation/prd.md:206` — FR-016, redirect chains (S-04)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step
> lands. Do not rename step titles.

### Phase 1: Page identity in the crawl

#### Automated

- [x] 1.1 Cases fail before the change and pass after — 94b9210
- [x] 1.2 A redirected URL is recorded under the URL the server served — 94b9210
- [x] 1.3 Two routes to one page produce one page, in either arrival order — 94b9210
- [x] 1.4 A relative href on a redirected page resolves against the final URL — 94b9210
- [x] 1.5 A discarded alias advances neither the page ceiling nor the failure counters — 94b9210
- [x] 1.6 Mutation: reverting to the requested URL fails the identity cases — 94b9210
- [x] 1.7 Mutation: removing the post-fetch dedup fails the two-routes case — 94b9210
- [x] 1.8 Schema applies: `npm run db:push` — 94b9210
- [x] 1.9 Existing crawler, politeness and run tests pass unchanged — 94b9210
- [x] 1.10 Type checking passes: `npm run typecheck` — 94b9210
- [x] 1.11 Linting passes: `npm run check` — 94b9210
- [x] 1.12 Whole suite passes: `npm run test:all` — 138 unit, 35 integration, 15 browser — 9232331

#### Manual

- [ ] 1.13 A fixture crawl reports fewer pages than requests, by the alias count

### Phase 2: Rule 5 asks about languages, not URLs

#### Automated

- [x] 2.1 Cases fail before the change and pass after — e1a097e
- [x] 2.2 Two URLs for one locale, both declared, produce no finding — e1a097e
- [x] 2.3 A genuinely undeclared language is still reported — e1a097e
- [x] 2.4 Mutation: reverting to the URL comparison fails the two-URL case — e1a097e
- [x] 2.5 Every existing site-shape case passes unchanged — e1a097e
- [x] 2.6 Type checking passes: `npm run typecheck` — e1a097e
- [x] 2.7 Linting passes: `npm run check` — e1a097e
- [x] 2.8 Whole suite passes: `npm run test:all` — 9232331

#### Manual

- [ ] 2.9 No finding claims a page fails to link somewhere it does link

### Phase 3: Verify against the site that found it

#### Automated

- [x] 3.1 Whole suite passes: `npm run test:all` — 9232331

#### Manual

- [x] 3.2 The 4 false `/careers` findings are gone — hreflang_family_inconsistent 4 → 0
- [x] 3.3 The 8 genuine divergences remain — variant_diverged 8 → 8
- [x] 3.4 The page count is lower than 569 by a plausible alias count — 533 pages; 36 aliases collapsed
- [x] 3.5 No remaining finding names a page that is fine on inspection — three of the eight spot-checked live, all 404
- [x] 3.6 S-01's real-site note records what this settles and what it does not — see below
