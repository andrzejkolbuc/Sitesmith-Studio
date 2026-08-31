# hreflang graph and cross-variant parity — Plan Brief

> Full plan: `context/changes/hreflang-and-variant-parity/plan.md`

## What & Why

A user can already be told that a declared language variant is dead. They cannot
be told that their site's hreflang declarations contradict each other, or that
one variant of a page is failing while its siblings are fine. FR-025 and FR-026
require both. The gap was found while checking detection confidence in the test
rollout: `variants.ts` treats a one-directional declaration as a sibling
relationship, which is correct for grouping and leaves the asymmetry unreported.

## Starting Point

S-01 shipped the variant graph, the per-page status records, and four detection
rules — one of which, "declared variant is broken", already covers FR-025's
"pointing at dead URLs". The union-find grouping and the sibling-declaration map
both already exist and are already computed on every run. `findings.type` is a
varchar with a jsonb detail, so new finding types need no migration.

## Desired End State

Running a check against a site with inconsistent hreflang produces, per affected
page family, one finding that names the family and lists which member pages are
wrong and how. Where a variant is failing and its siblings are not, that
divergence is stated as such — unless an existing rule already reported that
member, in which case only the more specific finding appears.

## Key Decisions Made

| Decision | Choice | Why |
| --- | --- | --- |
| What "regressed" means | Divergence within one run | S-07 owns run-to-run comparison as its own slice; building it here builds it twice |
| Finding granularity | One per family, not per URL or per edge | The requirement asks for "the divergence itself, not five independent per-URL reports"; per-edge floods on a template bug |
| What "incomplete" measures against | What the family itself publishes | Needs no configuration and cannot be wrong about intent; measuring against configured locales duplicates rule 1 |
| Missing self-reference | Folded into the family finding | A real spec violation, already in the data, and folding it in avoids a fourth new type |
| Overlap with the broken-variant rule | Divergence defers where another rule spoke | Reuses the precedence approach that fixed the S-01 double report |
| Noise guard | Families of two or more only | Mirrors rule 1's guard, added after it fired seven times where two was correct |
| Acceptance | Fully verifiable without a real client site | S-01 is parked at "built" behind five real-site criteria; a second slice in that state compounds the problem |
| Rendering | A sentence plus the members it names | Matches the existing convention that a finding be actionable without opening the database |

## Scope

**In scope:** non-reciprocal hreflang edges; declarations short of what the
family publishes; missing self-references; within-run divergence across a family;
rendering both new types; a browser journey covering them.

**Out of scope:** run-to-run comparison (S-07); parity on title, canonical,
noindex or word count (S-05, S-03) — none of which is crawled today; families
that are uniformly incomplete; a per-run findings cap; the known `startRun`
status-code defect.

## Architecture / Approach

Two new members of `FINDING_TYPES`, both emitted by `detectMissingVariants`
alongside the existing four, both with a null `url` because they describe a
family rather than a page. The declaration edges they need are already assembled
by `groupVariants`; the phase-1 change exposes them rather than recomputing
them. Every edge is filtered through the existing `isLanguageTag`, without which
`x-default` — present on most real multilingual sites — reads as a
non-reciprocal locale.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. hreflang graph rule | One family finding covering non-reciprocity, short declarations, and missing self-references | Firing on `x-default`, which would make it wrong on most real sites |
| 2. Divergence rule | One family finding where some members fail and others do not | Restating what the broken-variant rule already said — the S-01 double report at family scale |
| 3. Presentation | Labels, evidence rendering with member lists, browser journey | A wide family filling the screen and burying the other findings |

**Prerequisites:** S-01 built (done). No migration, no new dependency, no new
crawl field.
**Estimated effort:** ~1–2 sessions across three phases.

## Open Risks & Assumptions

- **Noise volume on a real site is unmeasured, by choice.** Acceptance is
  fixture-based so the slice can actually be finished. Fixtures cannot tell us
  how loud non-reciprocity is on a real 200-page site — that observation is owed
  alongside S-01's five open real-site criteria.
- **Family-level reporting is assumed to be sufficient noise control.** If a
  real site disproves that, the answer is a cap, which this slice deliberately
  does not build.
- **"Regressed" is being read as divergence.** If the intent was genuinely
  temporal, FR-026 stays partly open until S-07.

## Success Criteria (Summary)

- A site with contradictory hreflang produces one readable finding per affected
  family, naming the pages to edit and what to add.
- A partly-failing family is reported as a divergence, and no underlying problem
  appears twice under two names.
- Every criterion is closable against fixtures and the browser suite, so the
  slice can be archived rather than parked.
