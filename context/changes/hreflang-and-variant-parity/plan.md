# hreflang graph and cross-variant parity — Implementation Plan

## Overview

Two new finding types, both reported at the level of a variant family rather
than a URL. The first says a family's hreflang declarations are internally
inconsistent — some member does not declare back, or declares fewer alternates
than the family publishes, or fails to declare itself. The second says one
member of a family is failing while its siblings are fine.

Both are derived entirely from what the crawl already records. There is no
migration, no new crawl field, and no new infrastructure.

## Current State Analysis

**What already exists, from S-01:**

- `groupVariants` in `src/server/crawl/variants.ts` builds variant families by
  union-find over the hreflang graph, keyed by the lexicographically smallest
  member URL so grouping is independent of crawl order.
- The same function already computes `declaredBySiblings` — a map of what every
  page says about every *other* page. The graph data these rules need is
  therefore already assembled; it is currently used only to assign a locale to a
  page that could not name its own.
- `detectMissingVariants` in `src/server/crawl/findings.ts` runs four rules and
  returns `Finding[]`, where `Finding.url` is already `string | null` and
  documented as "null for family-level findings".
- `pages` rows carry `url`, `httpStatus`, `locale`, `variantGroupKey`,
  `hreflangTargets` and `fetchError`, written by `run.ts` during the crawl and
  back-filled with locale and group key once grouping runs.
- `findings.type` is `varchar(64)` and `findings.detail` is `jsonb`, so adding
  finding types requires no schema change.
- `run-panel.tsx` maps a finding type to a human label via `FINDING_LABEL` and
  renders each finding as a sentence via `Evidence()`. An unmapped type falls
  through to a raw JSON dump.

**What is missing:**

- Nothing reports non-reciprocity. FR-025 names it explicitly.
- Nothing reports a declaration that is short of what its family publishes.
- Nothing reports a missing self-reference, which the hreflang guidance requires
  of every page in a set.
- Nothing reports cross-variant divergence. FR-026 names it.

**The constraint that shapes every decision below:** the PRD's guardrail that
"if runs routinely report changes that do not matter, the developer stops
reading them and the product is dead". Rule 1 has already been narrowed once for
this reason (a `members.length >= 2` guard, added after it fired seven times
where two was correct), and rule 4 twice.

## Desired End State

A user runs a check against a site whose hreflang is inconsistent and sees, per
affected family, one finding naming the family and listing which member pages
are wrong and how. Where a variant is failing and its siblings are not, they see
that stated as a divergence — unless one of the existing rules already reported
that member, in which case they see only the existing, more specific finding.

Verifiable by: `npm run test:all` green, with the new rules covered by a
site-shapes table whose expectations were written before the rules, and a
browser journey that crawls a fixture and reads both new finding types off the
page.

### Key Discoveries

- `declaredBySiblings` (`src/server/crawl/variants.ts`) already builds the
  inbound-declaration map — reciprocity is a comparison between it and each
  page's own `hreflangTargets`, needing no new traversal.
- `Finding.url` being nullable (`src/server/crawl/findings.ts`) means
  family-level findings fit the existing model and the existing `findings.pageId`
  nullable column without change.
- The precedence approach that fixed the S-01 double-report — decide which rule
  owns a fact, and have the others defer — is directly reusable for keeping
  divergence from restating the broken-variant finding.
- `site-shapes.test.ts` established the discipline for rule expectations: take
  them from hreflang guidance, ISO 639-1 and the requirement, never from running
  the rule. That file is the template for this slice's tests.
- `isLanguageTag` (`src/server/crawl/variants.ts`) already excludes `x-default`
  from being treated as a language. Every new rule must use it, or `x-default`
  will read as a missing or non-reciprocal locale.

## What We're NOT Doing

- **Run-to-run comparison.** FR-026's word "regressed" implies time; this slice
  delivers within-run divergence only. Comparing a run against its predecessor
  is S-07 `run-history-and-comparison`, a separate slice, and building it here
  would build it twice.
- **Any parity check richer than reachability.** Title, canonical, noindex and
  word count are not crawled today. Comparing them belongs to S-05 and S-03, and
  adding crawl fields here would pull their scope forward.
- **Reporting a family that is uniformly incomplete.** Completeness is measured
  against what the family itself publishes, so a family where every member
  declares the same short list looks consistent and stays silent. Measuring
  against the project's configured locales instead is rule 1's job, and doing it
  twice is the double-report failure already fixed once.
- **A per-run cap on findings.** Family-level reporting is the noise control for
  this slice. A cap introduces truncation the interface must explain, and hides
  which families are affected.
- **Fixing `startRun`'s INTERNAL_SERVER_ERROR on a foreign project.** Known,
  tracked separately, unrelated to these rules.

## Implementation Approach

Two new members of `FINDING_TYPES`, both produced by `detectMissingVariants`
alongside the existing four:

- `hreflang_family_inconsistent` — one per family, carrying the declaration
  defects of every member that has one.
- `variant_diverged` — one per family, naming the members that failed where
  siblings succeeded.

Both are gated on `members.length >= 2`, mirroring rule 1: a family of one
cannot be inconsistent with itself, and a lone failing page is not a divergence.

The order of work is detection first, presentation last, so that every rule is
settled against a shapes table before any of it reaches a screen. Each phase's
tests are written before its rule, and each is checked by mutation — the rule is
broken deliberately and the failure observed — because a rule test that has
never failed is not evidence.

## Critical Implementation Details

**`x-default` and reciprocity — corrected during Phase 1.** This originally
claimed that counting a fallback pointer as an edge would report false
non-reciprocity. That is wrong, and the mutation proving it was written and run:
filtering by `isLanguageTag` makes the rule *stricter*, not more forgiving, so
removing the filter fails nothing. The reasoning had been carried over from the
Phase 3 locale-assignment defect, where `x-default` genuinely did corrupt a
page's locale.

The real defect sits one level up. `groupVariants` unions on every declared
target, fallback pointers included, so a language-selector page named only by
`x-default` arrives as a family member. On a site with entirely correct hreflang
that produced four defects: the selector blamed for naming no siblings, and
every real variant blamed for not naming the selector. Rule 5 therefore judges
only the members a family reaches by a language edge. Declaring itself does not
count as a link — a page naming only its own language has said nothing about
being related to anyone.

**Self-declaration is not an inbound edge.** `declaredBySiblings` already skips
`target === page.url`. The reciprocity comparison needs the same exclusion from
the other direction, or a page that declares itself will appear to declare back
to itself and mask a genuinely missing edge.

---

## Phase 1: The hreflang graph rule

### Overview

One finding per family whose members' declarations disagree with each other,
covering three defect kinds: an edge that is not reciprocated, a declaration
shorter than what the family publishes, and a page that does not declare itself.

### Changes Required

#### 1. Family declaration analysis

**File**: `src/server/crawl/variants.ts`

**Intent**: Expose what the existing graph already knows, so the rule can ask
per family "who declares whom" without rebuilding the traversal.

**Contract**: A function taking the crawled pages and returning, per family
group key, the members and their declaration edges restricted to language tags.
Existing exports are unchanged; `isLanguageTag` gates every edge.

#### 2. The rule

**File**: `src/server/crawl/findings.ts`

**Intent**: Emit one `hreflang_family_inconsistent` finding per family that has
at least one member defect, listing the defects rather than one per defect.

**Contract**: A new `FINDING_TYPES.HREFLANG_FAMILY_INCONSISTENT`. The finding's
`url` is null and its `detail` carries the group key, the member URLs, and a
per-member list of defects each naming its kind — not reciprocated, short of the
family's locales, or missing a self-reference — and the locales involved. Gated
on `members.length >= 2`. Output ordering is stable, as the existing rules are,
because a later slice diffs runs against each other.

#### 3. Shapes covering the rule

**File**: `src/server/crawl/site-shapes.test.ts`

**Intent**: State what each shape should produce before the rule exists,
sourced from the hreflang guidance and the requirement rather than from output.

**Contract**: Cases for a reciprocal family (silent), a one-directional edge, a
member declaring fewer alternates than the family publishes, a member missing
its self-reference, a family uniformly short (silent, per the scope decision), a
family of one (silent), and an `x-default` pointer (silent — not a language
edge).

### Success Criteria

#### Automated Verification

- The shapes table fails before the rule exists and passes after: `npm run test:unit`
- A reciprocal family produces nothing
- An `x-default` pointer never produces a reciprocity defect
- A family of one produces nothing
- One finding per family, regardless of how many members are defective
- Mutation: removing the language-link narrowing fails the fallback-pointer case
- Existing S-01 rule tests pass unchanged: `npm run test:unit`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`

#### Manual Verification

- The detail of a finding is enough to know which page to edit and what to add

**Implementation Note**: After completing this phase and all automated
verification passes, pause for confirmation before proceeding.

---

## Phase 2: The divergence rule

### Overview

One finding per broken variant that two or more of its siblings declare,
replacing the per-URL reports of the same fact — the shape the requirement
describes as "five language variants are healthy and one is not, and the
divergence itself is the finding, not five independent per-URL reports of which
one happens to be bad".

### Revised during implementation

The plan originally said divergence should report only where no existing rule
had spoken. Two facts found before writing the rule showed that to be wrong:

1. **It would have been near-dead code.** A family is built from hreflang edges,
   and a page that errors serves no HTML and so declares nobody. A failing family
   member is therefore in the family *because a sibling declared it*, which is
   exactly what makes rule 2 fire. "A failing member no rule spoke about" is an
   exotic shape — an error page that still renders the site's hreflang head.

2. **The noise it was meant to remove would have stayed.** Measured, not
   reasoned: a six-variant family with one broken member produces five
   `hreflang_target_failed` findings, one per declaring sibling, each saying the
   same thing. That is the requirement's forbidden shape verbatim.

The collapse is therefore threshold-based: two or more declarers become one
divergence finding; a single declarer keeps today's per-URL finding, because
with one declarer that finding already *is* one finding. This leaves every
shipped S-01 test and journey untouched — that fixture always has exactly one
declarer.

### Changes Required

#### 1. The rule

**File**: `src/server/crawl/findings.ts`

**Intent**: Say once that a variant is broken, naming the pages that point at it,
instead of once per page that points at it.

**Contract**: A new `FINDING_TYPES.VARIANT_DIVERGED`. The finding's `url` is
null; its `detail` carries the group key, the broken member with its locale and
status or fetch error, the sibling pages declaring it, and the healthy members.
Emitted when a broken family member has two or more declarers and at least one
healthy sibling. When emitted, the `hreflang_target_failed` findings for that
target are suppressed — the divergence carries the same evidence, so keeping both
would be one problem reported twice.

#### 2. Shapes covering the rule

**File**: `src/server/crawl/site-shapes.test.ts`

**Intent**: Pin the collapse, the threshold, and the silences — the threshold
being the part most likely to drift, since it is what protects shipped
behaviour.

**Contract**: Cases for a six-member family with one broken variant (one
divergence, no per-URL findings), a two-member family with one broken variant
(unchanged: the per-URL finding, no divergence), a family where every member
failed (silent), a wholly healthy family (silent), and a family of one (silent).

### Success Criteria

#### Automated Verification

- The shapes table fails before the rule exists and passes after: `npm run test:unit`
- A broken variant declared by five siblings produces one finding, not five
- A broken variant declared by one sibling keeps its existing per-URL finding
- A family where every member failed produces no divergence finding
- A wholly healthy family produces nothing
- Mutation: removing the suppression re-introduces the per-URL findings and fails
  the corresponding case
- Existing S-01 rule tests and journeys pass unchanged: `npm run test:unit`
- Integration suite passes: `npm run test:integration`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`

#### Manual Verification

- Reading both new findings together on a mixed site, no single problem is
  described twice under two names

**Implementation Note**: Pause for confirmation before proceeding.

---

## Phase 3: Presentation

### Overview

Both new types rendered as sentences naming the pages involved, and a browser
journey proving a real crawl surfaces them.

### Changes Required

#### 1. Labels and evidence

**File**: `src/app/(app)/projects/[id]/run-panel.tsx`

**Intent**: Render each new type as a statement of the problem followed by the
member pages it names, so a finding is actionable without opening the database —
the convention the existing `Evidence()` cases already follow.

**Contract**: New `FINDING_LABEL` entries and new `Evidence()` cases for both
types. Each renders a leading sentence and then the affected members with their
individual defect or status. A very wide family is truncated with the remaining
count stated, so one family cannot fill the screen.

#### 2. Fixture shapes

**File**: `test/fixtures/site.ts`

**Intent**: Give the crawlable fixture a family that is non-reciprocal and one
that diverges, so the browser journey has something true to find.

**Contract**: Additional pages under new paths, leaving every existing path and
its declarations untouched — the existing journeys and rule tests assert against
them. The file's own header states that it is the description of what each rule
means, so the new pages are documented there in the same terms.

#### 3. Journey

**File**: `e2e/journeys/first-crawl.spec.ts`

**Intent**: Prove the whole chain — crawl, detect, persist, render — for the new
types, which is the layer where every S-01 failure actually appeared.

**Contract**: Assertions by role and visible text for both new finding headings
and for one member URL named inside a family finding. `EXPECTED` in
`e2e/fixture-server.ts` gains entries naming the new behaviours, so the journey
names what it expects rather than counting rows.

### Success Criteria

#### Automated Verification

- Both new finding types render with a human label, never as a JSON dump
- The browser journey passes: `npm run test:e2e`
- Existing journeys pass unchanged: `npm run test:e2e`
- The whole suite passes: `npm run test:all`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`

#### Manual Verification

- On the fixture site, the results screen reads as a short list of distinct
  problems rather than a wall
- A wide family's truncation states how many members were not shown

---

## Testing Strategy

### Unit Tests

- Site shapes for both rules, expectations written before the rules and sourced
  from hreflang guidance and the requirement — never from running the rule.
- Silence cases carry equal weight to detection cases: uniformly-short families,
  families of one, `x-default` pointers, wholly healthy families and
  wholly failed families must all produce nothing.
- Each rule verified by mutation before it is trusted.

### Integration Tests

- A run against the fixture persists the new finding types with their detail
  intact, and the tenant-isolation completeness check still accounts for every
  procedure.

### Manual Testing Steps

1. Run a check against the fixture site from the interface.
2. Confirm each new finding names the pages to edit and what to add.
3. Confirm no single underlying problem appears under two finding names.

## Performance Considerations

Both rules operate on data already in memory at the end of a crawl and are
bounded by the number of families, which is at most the page count. The existing
ceiling of 2,000 pages per run bounds them. No new database round trips: the
rules run inside `detectMissingVariants`, which is already called once per run.

## Migration Notes

None. `findings.type` is a varchar and `findings.detail` is jsonb, so new types
are additive. Runs recorded before this slice keep the findings they had; they
simply will not have the new types, which is correct — those rules did not exist
when the run was made.

## References

- Roadmap slice: `context/foundation/roadmap.md` — S-02
- Requirements: `context/foundation/prd.md` — FR-025, FR-026, and the Business
  Logic section on reporting one explained problem per underlying cause
- The gap this closes: `context/changes/detection-rule-confidence/plan.md`,
  "Known limits"
- Rule-test discipline to follow: `src/server/crawl/site-shapes.test.ts`
- Precedence approach to reuse: `src/server/crawl/variants.ts`, the sibling
  locale precedence that fixed the S-01 double report

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step
> lands. Do not rename step titles.

### Phase 1: The hreflang graph rule

#### Automated

- [x] 1.1 The shapes table fails before the rule exists and passes after — 63887c5
- [x] 1.2 A reciprocal family produces nothing — 63887c5
- [x] 1.3 An `x-default` pointer never produces a reciprocity defect — 63887c5
- [x] 1.4 A family of one produces nothing — 63887c5
- [x] 1.5 One finding per family, regardless of how many members are defective — 63887c5
- [x] 1.6 Mutation: removing the language-link narrowing fails the fallback-pointer case — 63887c5
- [x] 1.7 Existing S-01 rule tests pass unchanged — 63887c5
- [x] 1.8 Type checking passes: `npm run typecheck` — 63887c5
- [x] 1.9 Linting passes: `npm run check` — 63887c5

#### Manual

- [x] 1.10 The detail is enough to know which page to edit and what to add — confirmed by the user

### Phase 2: The divergence rule

#### Automated

- [x] 2.1 The shapes table fails before the rule exists and passes after — 5ff3f73
- [x] 2.2 A broken variant declared by five siblings produces one finding, not five — 5ff3f73
- [x] 2.3 A broken variant declared by one sibling keeps its per-URL finding — 5ff3f73
- [x] 2.4 A family where every member failed produces no divergence finding — 5ff3f73
- [x] 2.4b A wholly healthy family produces nothing — 5ff3f73
- [x] 2.5 Mutation: removing the suppression re-introduces the per-URL findings — 5ff3f73
- [x] 2.6 Existing S-01 rule tests pass unchanged — 5ff3f73
- [x] 2.7 Integration suite passes: `npm run test:integration` — 5ff3f73
- [x] 2.8 Type checking passes: `npm run typecheck` — 5ff3f73
- [x] 2.9 Linting passes: `npm run check` — 5ff3f73

#### Manual

- [x] 2.10 No single problem is described twice under two names — delegated by the user and verified against a real crawl; one duplication found and fixed, so rule 4 now defers to the family finding

### Phase 3: Presentation

#### Automated

- [x] 3.1 Both new types render with a human label, never as a JSON dump — 463b328
- [x] 3.2 The browser journey passes: `npm run test:e2e` — 463b328
- [x] 3.3 Existing journeys pass unchanged — 463b328
- [x] 3.4 The whole suite passes: `npm run test:all` — 463b328
- [x] 3.5 Type checking passes: `npm run typecheck` — 463b328
- [x] 3.6 Linting passes: `npm run check` — 463b328

#### Manual

- [x] 3.7 The results screen reads as distinct problems rather than a wall — user asked for a page count alongside each problem; added and asserted in the browser suite
- [x] 3.8 A wide family's truncation states how many members were not shown — the rule is unit-tested at its boundary; the rendering of it is not, because no fixture family is wide enough to truncate
