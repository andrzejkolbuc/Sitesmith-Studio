# Correlated Findings Implementation Plan

## Overview

Turn a run's raw findings into **one explained problem per underlying cause**, where "the same
cause" is operationally defined as *the set of hreflang variant families that the findings' origin
pages occupy*. Computed at read time from rows the crawl already stores, rendered above the existing
type groups, with each problem stating the shape of the correlation it claims.

This is roadmap item **S-09**, FR-040 and US-01 — the domain rule itself, the decision the product
makes that no other tool makes for the user.

## Current State Analysis

The crawl produces twenty-four finding types. Every one is already collapsed by cause *one level
down*: `link_broken` files one finding per dead target carrying every page that links to it,
`metadata_duplicated` one per duplicated string carrying every page publishing it. The results view
then groups those findings by `type` and shows two counts per heading — how many findings, and how
many pages they touch (`run-panel.tsx:511-545`).

What is missing is the level above. On the one real-site run available (`29fa2fc7`, yazaki-emea.com,
533 pages), that produces **67 list entries for what a human would call five or six problems** —
twenty broken links and eight diverged variants that are all one language-switcher bug, thirty-four
duplicated-metadata findings that are three CMS templates seen through ten locales.

Three constraints discovered during research bound the solution:

1. **FR-040's literal join key does not exist.** The requirement says "different check types on the
   same page", but only nine of twenty-four types file against a page, and on run `29fa2fc7` **all
   67 findings have `pageId = NULL`**. A same-page correlation produces zero groups.
2. **Correlating on shared evidence collapses everything.** Using the existing `pagesInvolved()` and
   taking the transitive closure of "shares at least one URL" puts **66 of 67 findings into a single
   group spanning all 533 pages**. Three hub findings bridge it: `link_external_broken` reaches 503
   URLs through `linkedFrom`, `page_missing_from_sitemap` 452, `page_orphaned` 71.
3. **There is one axis the site asserts itself.** `variantGroupKey` is derived from the hreflang
   graph, persisted per page and indexed on `(runId, variantGroupKey)`. Grouping on the families the
   *origin* pages occupy — not the union of subject and origin — reduces 67 findings to 7 groups
   with no threshold anywhere.

## Desired End State

Opening a settled run shows, above the type-grouped list, a short section of **correlated problems**.
Each states in words why its findings are one problem ("two pages in one variant family emit twenty
dead links"), and lists the findings it folds. Findings that were folded do not also appear in the
type groups below, so every finding is shown exactly once and the list is materially shorter than
the finding count.

Verified by: running the app against stored run `29fa2fc7` and confirming each rendered problem
against the question *would one edit fix all of these?* — plus a synthetic-shape suite whose
expectations were written before the rule ran against them.

### Key Discoveries

- `src/app/(app)/projects/[id]/parity.ts:1-17` — the precedent for this kind of module: pure, tested,
  route-folder-local, running "entirely on rows the crawl already stores", taking
  `{url, locale, variantGroupKey}`. Correlation is the same species and belongs beside it.
- `src/app/(app)/projects/[id]/run-panel.tsx:185-195` — both inputs are already fetched.
  `project.findings` and `project.runPages` are queried side by side, so **read-time correlation
  needs no new tRPC endpoint**.
- `src/app/(app)/projects/[id]/summarise.ts:52-190` — `pagesInvolved` is the single place `detail` is
  decoded per type, exhaustive, commented per case, with a safe `default`. It deliberately unions the
  dead URL and the pages linking to it, which is right for a page count and fatal for correlation.
- `src/server/db/schema.ts:281-285` — `variantGroupKey` is "derived from the hreflang graph rather
  than from any single URL", which is what makes it a site assertion rather than our inference.
- `src/server/crawl/findings.ts:1878-1892` — the both-trailing-slash-spellings lookup, added by the
  S-04 orphan fix. The same trap applies to matching `linkedFrom` URLs against `pages.url`.
- On run `29fa2fc7`: 533/533 pages carry a family key; 51 families of ten members plus 23 singletons.

## What We're NOT Doing

- **Not persisting correlations.** No `correlations` table, no migration. Correlation is computed at
  read time; if S-14 later needs it cached against the run, that is its own slice.
- **Not correlating the sitemap/orphan pair.** `page_missing_from_sitemap` and `page_orphaned` are
  statements about the corpus with no page-level origin, and `page_orphaned`'s URLs are not crawled
  pages at all. Joining them would assert a relationship between two *rules* rather than shared
  evidence. They stay uncorrelated by construction.
- **Not naming the defect.** A problem says *twenty dead links come from one variant family*. It does
  not say *the language switcher builds sibling URLs from the wrong slug* — true here, but our
  diagnosis rather than the site's assertion.
- **Not adding a second, non-hreflang axis** for monolingual sites. Recorded as a stated limit.
- **Not changing detection, the crawl, or any finding type.** No new outbound requests; NFR-1 is not
  engaged by this slice.
- **Not ranking or prioritising problems.** That is S-14.

## Implementation Approach

Four phases, mirroring the S-04 shape: an enabling refactor that is provably behaviour-preserving,
then the rule, then the surface, then the real-site proof last.

The rule is a pure function over two arrays the view already holds. Its grouping key is built in
three steps, each of which is a narrowing rather than a widening:

1. **Roles.** Each finding's `detail` yields a `subject` (what is wrong) and an `origin` (the pages
   that emit it — where an editor would go). Only `origin` feeds correlation.
2. **Exclusions by construction.** Five types have no page-level origin at all
   (`page_missing_from_sitemap`, `page_orphaned`, `robots_blocks_indexable`, `sitemap_url_failed`,
   `certificate_problem`). They are statements about the corpus, already one-finding-per-cause, and
   never correlate. This is structural, not a size threshold — the S-04 Phase 10 lesson is that a
   threshold scaling with the defect it hunts goes quiet exactly when it matters.
3. **The key.** The sorted set of `variantGroupKey`s the origin pages occupy. Equal sets correlate;
   unequal sets do not. Set equality, not similarity — the same move as S-03's exact-digest choice.

Two guards on top:

- **Internal never joins external.** `link_external_broken` correlates only with itself. A site's own
  URL rot and a third party deleting a page are different events, however much layout they share.
- **A problem needs two findings.** A group of one is just the finding, and stays in the type list.

## Critical Implementation Details

**URL spelling.** Family lookup joins `linkedFrom` / `declaredBy` / `urls` strings against
`pages.url`. Those are recorded by different code paths and can differ by a trailing slash — the
exact mismatch that produced the S-04 orphan false negative. Look up both spellings, as
`findings.ts:1878-1892` already does. Do **not** import `normaliseUrl` from `src/server/crawl/` into
the client bundle; `parity.ts` sets the precedent of route-folder modules staying self-contained.

**Ordering in the view.** Correlated problems must render above the type groups *and* remove their
own findings from those groups, in one pass — if the two happen independently the counts drift and a
finding shows twice. The remainder is the input to the existing `Findings` component; nothing else
about it changes.

## Phase 1: Evidence roles

### Overview

Split the per-type `detail` decode into the two roles correlation needs, without changing any
existing behaviour. This phase is user-invisible and exists so that Phase 2 has an honest input and
`detail` stays decoded in exactly one place.

### Changes Required

#### 1. The role mapping

**File**: `src/app/(app)/projects/[id]/summarise.ts`

**Intent**: Replace the body of the existing per-type switch with one that returns both roles, and
derive `pagesInvolved` from it as the deduped union. Every existing per-case comment explaining *why*
a type reports the pages it does must survive, and gains a sentence on which of them is the origin.
The five corpus-level types return an empty origin — that emptiness is the signal Phase 2 keys on, so
it is a decision to record in a comment, not an omission.

**Contract**: Add `export type EvidenceRoles = { subject: string[]; origin: string[] }` and
`export function evidenceRoles(finding: { type: string; url?: string | null; detail: Record<string, unknown> }): EvidenceRoles`.
`pagesInvolved` keeps its exact current signature and return value, implemented as the deduped
concatenation of both roles. `countPages` is untouched. The `default` case keeps its
never-reports-nothing property: `subject` falls back to `finding.url`, `origin` to the empty array.

Role sources, from the finding `detail` shapes:

| role | fields |
| --- | --- |
| `subject` | `target`, `brokenUrl`, `url`, `urls`, `from`, `entries[].normalised` |
| `origin` | `linkedFrom`, `declaredBy`, `affectedUrls`, `memberUrls`, `urls` |
| neither | `page_missing_from_sitemap`, `page_orphaned`, `robots_blocks_indexable`, `sitemap_url_failed`, `certificate_problem` have an empty `origin` |

`metadata_duplicated` and `content_duplicated` are the types where subject and origin coincide — the
pages carrying the duplicate are both the problem and the place it is fixed.

#### 2. Role tests

**File**: `src/app/(app)/projects/[id]/summarise.test.ts`

**Intent**: Cover `evidenceRoles` for every finding type, and assert that `pagesInvolved` output is
unchanged for each. The second assertion is the one that makes this phase safe: it is the refactor's
own proof.

**Contract**: One case per type in `FINDING_TYPES`, asserting the expected `subject` and `origin`
arrays; existing `pagesInvolved` and `countPages` tests remain and must pass unmodified.

### Success Criteria

#### Automated Verification

- Unit tests pass: `npm run test:unit`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- Existing `pagesInvolved` and `countPages` tests pass without modification
- Every type in `FINDING_TYPES` has an `evidenceRoles` case asserted

#### Manual Verification

- The results view is visibly unchanged: same headings, same finding counts, same page counts

**Implementation Note**: After completing this phase and all automated verification passes, pause for
manual confirmation before proceeding.

---

## Phase 2: The correlation rule

### Overview

The rule itself, as a pure function, with its expectations written before it runs against them.

### Changes Required

#### 1. The module

**File**: `src/app/(app)/projects/[id]/correlate.ts`

**Intent**: Group a run's findings into correlated problems on the origin-family key, applying the
two guards and the structural exclusions. Written in the register of `parity.ts` — a file header
explaining what question the module answers and why the vocabulary is deliberately small, and a
comment at each narrowing saying what it prevents.

**Contract**:

```ts
export type CorrelationShape = "one-family" | "family-set" | "same-pages";

export type CorrelatedProblem = {
  /** Stable within a run: the grouping key, so the UI can key on it. */
  key: string;
  shape: CorrelationShape;
  /** Families the origin occupies; empty for `same-pages`. */
  families: string[];
  /** The pages that emit it — where an editor goes. */
  originPages: string[];
  /** Two or more; a group of one is not a problem. */
  findings: CorrelatableFinding[];
};

export type Correlated = {
  problems: CorrelatedProblem[];
  /** Everything not folded, in the order it arrived. */
  remainder: CorrelatableFinding[];
};

export function correlate(
  findings: CorrelatableFinding[],
  pages: CorrelatablePage[],
): Correlated;
```

`CorrelatableFinding` is `{ id, type, detail }`; `CorrelatablePage` is `{ url, variantGroupKey }` —
structural types, matching how `parity.ts` declares `ParityPage` rather than importing schema types.

Rules, in order:

- A finding whose `origin` is empty is never correlated. It goes to `remainder`.
- The key is the sorted set of `variantGroupKey`s of the origin pages, looked up under both
  trailing-slash spellings. Shape is `one-family` for exactly one, `family-set` for more.
- Origin pages with no known family fall back to the sorted origin URL set: shape `same-pages`.
- `link_external_broken` is keyed into its own namespace so it can never share a group with an
  internal type.
- Groups of one finding are dissolved into `remainder`.
- `problems` are ordered by finding count descending, then by key, so the output is deterministic.

#### 2. Shape tests

**File**: `src/app/(app)/projects/[id]/correlate.test.ts`

**Intent**: Synthetic shapes with expectations written first, following the `site-shapes.test.ts`
discipline. The shapes that matter are the ones that could produce a *wrong* grouping, not the ones
that produce a right one.

**Contract**: At minimum —

- Twenty broken links emitted from two pages of one family fold into one `one-family` problem.
- Diverged-variant findings about that same family join the same problem, across two check types.
- Two findings whose origins occupy the same family *set* fold; changing one family in one of them
  splits them.
- A finding whose origin spans the whole site does **not** absorb an external-link finding.
- A corpus-level type (`page_orphaned`, `page_missing_from_sitemap`) never appears in a problem.
- A monolingual corpus (every page its own family) correlates only findings with identical origin
  sets, and otherwise returns everything as remainder.
- An origin URL recorded with a trailing slash matches a page recorded without one.
- A single finding never becomes a problem.
- `problems` and `remainder` together account for every input finding, exactly once — the invariant
  the view depends on.

### Success Criteria

#### Automated Verification

- Unit tests pass: `npm run test:unit`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- The partition invariant is asserted: every input finding appears in exactly one of `problems` or
  `remainder`
- Every `CorrelationShape` variant is exercised by at least one shape test

#### Manual Verification

- Each shape test's expectation was written before the rule was run against it, and any expectation
  changed afterwards is recorded with the reason it was wrong

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 3: The view

### Overview

Render correlated problems above the type groups, and shorten the type groups by exactly what was
folded.

### Changes Required

#### 1. Problem rendering

**File**: `src/app/(app)/projects/[id]/run-panel.tsx`

**Intent**: Call `correlate` with the findings and pages already fetched, render `problems` in a new
section between the parity grid and the findings list, and pass `remainder` to the existing
`Findings` component instead of the full list. Each problem states its shape as a sentence, gives the
count of findings and origin pages, and lists its findings using the existing `Evidence` renderer so
nothing about how a finding reads changes.

**Contract**: A new `Problems` component taking `CorrelatedProblem[]`, rendered before `<Findings>`
(currently line 273) and after `<ParityGrid>` (line 269). `Findings` keeps its current props and
receives `remainder`. Long origin lists go through the existing `summariseList` / `MAX_LISTED` cap —
a template fault must not let one problem push everything else off the screen, which is the failure
that heading-level summarising already exists to prevent.

The three sentence forms, one per shape:

| shape | sentence |
| --- | --- |
| `one-family` | one variant family emits all of these |
| `family-set` | the same N variant families exhibit all of these |
| `same-pages` | the same N pages emit all of these |

When `problems` is empty the section renders nothing at all — not an empty state. A run with no
correlations is a normal run, and the existing "Nothing found" state still owns the clean-run case.

#### 2. Labels

**File**: `src/app/(app)/projects/[id]/run-panel.tsx`

**Intent**: The section needs a heading in the same register as "Parity" and the type headings.

**Contract**: A section heading plus a one-line explanation of what a correlated problem is, so a
reader encountering it for the first time knows why findings are missing from the list below.

### Success Criteria

#### Automated Verification

- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`

#### Manual Verification

- Against stored run `29fa2fc7`, correlated problems appear above the type groups
- Every finding appears exactly once across the two sections — no duplication, nothing lost
- The type-group counts below match the remainder, not the run's total finding count
- A run with no correlations renders no problems section and looks as it does today
- Long origin lists are capped rather than pushing the page

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 4: Real-site proof

### Overview

The number is not the proof. Confirm each problem the rule produces against the only question that
matters — *would one edit fix all of these?* — and record the limits honestly.

### Changes Required

#### 1. The proof

**File**: `context/changes/correlated-findings/proof.md`

**Intent**: Record what the rule produced on run `29fa2fc7` and the manual verdict on each group.
Following the S-04 and S-05 precedent of a real-site proof recorded rather than asserted, including
the honesty clause: correctly silent is not the same as validated.

**Contract**: A before/after table (findings by type, before; problems with their folded types,
after), one row per problem with a verdict and the reasoning, and an explicit note of any group whose
verdict was "no". The pre-registered expectation from the research probe — five problems, three
uncorrelated findings, eight list entries from sixty-seven — is stated as a prediction made before
implementation, and any divergence is explained rather than accommodated.

#### 2. The stated limit

**File**: `context/changes/correlated-findings/change.md`

**Intent**: Record that the axis is the hreflang graph and what that means for a monolingual client,
so it is a known limit rather than a discovered one.

**Contract**: A short section noting the degradation (singleton families reduce the rule to identical
origin sets only), that this was accepted deliberately given US-01 is the multilingual story, and
what evidence would reopen it.

#### 3. Lesson capture

**File**: `context/foundation/lessons.md`

**Intent**: Only if the proof produces one. The candidate from research is that *grouping by shared
evidence is not grouping by shared cause* — with the measured 66-of-67 collapse as its evidence. Add
it only if the phase confirms it held during implementation rather than only during research.

**Contract**: Follows the existing entry format — Context, Problem, Rule, Applies to.

### Success Criteria

#### Automated Verification

- Full unit suite passes: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- Type checking passes: `npm run typecheck`
- Lint and format pass: `npm run check`
- No temporary scripts or harnesses remain in the working tree

#### Manual Verification

- Each correlated problem on run `29fa2fc7` is confirmed by hand against "would one edit fix all of
  these?", and any that fails is recorded and the rule narrowed rather than the verdict softened
- The twenty broken links and eight diverged variants appear as one problem
- `link_external_broken` is not folded in with the internal dead links
- The proof records the prediction made before implementation and explains any divergence
- The monolingual limit is written down in `change.md`

---

## Testing Strategy

### Unit Tests

- `evidenceRoles` for all twenty-four types; `pagesInvolved` unchanged (Phase 1)
- The correlation shapes listed in Phase 2, expectations written first
- The partition invariant: `problems` + `remainder` accounts for every finding exactly once
- Both trailing-slash spellings resolve to the same family
- Determinism: the same input produces the same order

### Integration Tests

The existing suite must keep passing; this slice adds no server behaviour, no schema change and no
new endpoint, so there is nothing new to integrate. Any new integration test here would be testing
the view, which is what Phase 3's manual criteria cover.

### Manual Testing Steps

1. Start the app against the local database with stored run `29fa2fc7`.
2. Open the yazaki project and let the latest run load.
3. Confirm the problems section renders above the type groups.
4. For each problem, open two of its findings and ask whether one edit would fix both.
5. Confirm the folded findings are absent from the type groups below, and that the counts agree.
6. Confirm `link_external_broken` stands alone rather than joining the dead internal links.

## Performance Considerations

Correlation is O(findings × origin pages) with a hash lookup per URL, over 67 findings and 533 pages
— immaterial. The one shape worth noting is a finding whose origin is site-wide: `linkedFrom` of 502
entries means 502 lookups for that single finding. Still immaterial, but it is the reason the
grouping key is a *set of families* rather than a pairwise intersection over findings, which would be
quadratic in the number of findings and is the shape that would eventually bite.

Because correlation is read-time, it runs on every view of a settled run. At current scale that is
invisible. If a future run produces findings in the thousands, the answer is persistence — which is
the S-14 conversation, deliberately not this slice.

## Migration Notes

None. No schema change, no migration, no stored data touched. Existing runs gain correlated problems
the next time they are viewed, because the rule reads only rows the crawl already wrote.

## References

- Research: `context/changes/correlated-findings/research.md`
- Change brief: `context/changes/correlated-findings/change.md`
- Lessons: `context/foundation/lessons.md` — "Trace every finding to the site's own assertion"
- Module precedent: `src/app/(app)/projects/[id]/parity.ts`
- Evidence decode: `src/app/(app)/projects/[id]/summarise.ts:52-190`
- Render order: `src/app/(app)/projects/[id]/run-panel.tsx:269-277`
- URL spelling precedent: `src/server/crawl/findings.ts:1878-1892`
- Real-site proof precedent: `context/archive/2026-09-02-crawl-technical-checks/`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Evidence roles

#### Automated

- [ ] 1.1 Unit tests pass: `npm run test:unit`
- [ ] 1.2 Type checking passes: `npm run typecheck`
- [ ] 1.3 Lint and format pass: `npm run check`
- [ ] 1.4 Existing `pagesInvolved` and `countPages` tests pass without modification
- [ ] 1.5 Every type in `FINDING_TYPES` has an `evidenceRoles` case asserted

#### Manual

- [ ] 1.6 The results view is visibly unchanged: same headings, same finding counts, same page counts

### Phase 2: The correlation rule

#### Automated

- [ ] 2.1 Unit tests pass: `npm run test:unit`
- [ ] 2.2 Type checking passes: `npm run typecheck`
- [ ] 2.3 Lint and format pass: `npm run check`
- [ ] 2.4 The partition invariant is asserted: every input finding appears in exactly one of `problems` or `remainder`
- [ ] 2.5 Every `CorrelationShape` variant is exercised by at least one shape test

#### Manual

- [ ] 2.6 Each shape test's expectation was written before the rule was run against it, and any expectation changed afterwards is recorded with the reason it was wrong

### Phase 3: The view

#### Automated

- [ ] 3.1 Type checking passes: `npm run typecheck`
- [ ] 3.2 Lint and format pass: `npm run check`
- [ ] 3.3 Unit tests pass: `npm run test:unit`
- [ ] 3.4 Integration tests pass: `npm run test:integration`

#### Manual

- [ ] 3.5 Against stored run `29fa2fc7`, correlated problems appear above the type groups
- [ ] 3.6 Every finding appears exactly once across the two sections — no duplication, nothing lost
- [ ] 3.7 The type-group counts below match the remainder, not the run's total finding count
- [ ] 3.8 A run with no correlations renders no problems section and looks as it does today
- [ ] 3.9 Long origin lists are capped rather than pushing the page

### Phase 4: Real-site proof

#### Automated

- [ ] 4.1 Full unit suite passes: `npm run test:unit`
- [ ] 4.2 Integration tests pass: `npm run test:integration`
- [ ] 4.3 Type checking passes: `npm run typecheck`
- [ ] 4.4 Lint and format pass: `npm run check`
- [ ] 4.5 No temporary scripts or harnesses remain in the working tree

#### Manual

- [ ] 4.6 Each correlated problem on run `29fa2fc7` is confirmed by hand against "would one edit fix all of these?", and any that fails is recorded and the rule narrowed rather than the verdict softened
- [ ] 4.7 The twenty broken links and eight diverged variants appear as one problem
- [ ] 4.8 `link_external_broken` is not folded in with the internal dead links
- [ ] 4.9 The proof records the prediction made before implementation and explains any divergence
- [ ] 4.10 The monolingual limit is written down in `change.md`
