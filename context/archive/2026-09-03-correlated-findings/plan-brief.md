# Correlated Findings — Plan Brief

> Full plan: `context/changes/correlated-findings/plan.md`
> Research: `context/changes/correlated-findings/research.md`

## What & Why

Report **one explained problem per underlying cause** instead of many symptoms. This is roadmap
S-09, FR-040, US-01 — the domain rule itself, and the roadmap's own risk note sets the bar: *if this
slice does not produce findings that feel smarter than the raw list, the product is a formatter over
other tools.*

## Starting Point

Twenty-four rules, each already collapsed by cause one level down, presented in a list grouped by
finding type. On the one real-site run available (`29fa2fc7`, yazaki-emea.com, 533 pages) that is
**67 list entries for what a human would call five or six problems**: twenty broken links and eight
diverged variants that are one language-switcher bug, thirty-four duplicated-metadata findings that
are three CMS templates seen through ten locales.

Research established that FR-040's stated join key — different check types *on the same page* —
does not exist in the data. Only nine of twenty-four types file against a page, and on that run
**every finding has `pageId = NULL`**. It also measured the obvious alternative: correlating on
shared involved-URLs collapses 66 of 67 findings into one group covering all 533 pages.

## Desired End State

Opening a settled run shows a short section of correlated problems above the type-grouped list. Each
states in words why its findings are one problem — "one variant family emits all of these" — and
lists what it folds. Folded findings leave the list below, so every finding appears exactly once and
the list is materially shorter than the finding count.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| What counts as one cause | The set of hreflang variant families the findings' **origin** pages occupy | The site asserts the relationship itself; equal sets correlate, so there is no threshold anywhere | Research |
| Evidence model | Split each finding's `detail` into **subject** (what is wrong) and **origin** (who emits it) | Correlating on the union is what produced the 66-of-67 collapse; only origin carries the site's claim | Research |
| Corpus-level findings | Never correlated, by construction — five types have no page-level origin | Excluding them for being *wide* would be a threshold that scales with the defect it hunts | Research |
| The shared-layout case | Internal link failures never correlate with external ones | A shared layout is a shared location, not a shared cause; splits the false group with no number | Plan |
| Where it runs | Read time, no persistence | Free iteration while the rule is young; no migration, nothing frozen wrong | Plan |
| Presentation | Above the type groups; folded findings hidden below | A problem spanning two types has no home under a type heading; every finding shown exactly once | Plan |
| What a problem says | Named shape plus its evidence | FR-040 requires inference stated, not collation; naming the *defect* would be our diagnosis, not the site's | Plan |
| Sitemap/orphan pair | Left out | Not joinable on this axis — it would assert a relationship between two rules rather than shared evidence | Research |
| Monolingual sites | Accepted limit, written down | US-01 is the multilingual story; the only other axis available would be our inference | Plan |
| Verification | Synthetic shapes with expectations written first, then the real run | The established discipline — four shipped rules were found wrong this way | Plan |

## Scope

**In scope:** the evidence role split; the correlation rule as a pure module; the problems section in
the results view; a real-site proof on run `29fa2fc7`; the monolingual limit recorded.

**Out of scope:** persistence and any migration; correlating the sitemap/orphan pair; naming the
defect behind a correlation; a second non-hreflang axis; ranking or prioritising problems (S-14); any
change to detection, the crawl, or the finding types.

## Architecture / Approach

A pure function over two arrays the view already fetches — no new endpoint, no schema change.
`parity.ts` is the precedent: route-folder-local, tested, running entirely on rows the crawl already
stores.

```
findings + pages  →  evidenceRoles()  →  origin URLs  →  variantGroupKey lookup
                                                              ↓
                     remainder  ←  correlate()  →  problems (≥2 findings each)
                         ↓                              ↓
                   type groups                   problems section (above)
```

Three narrowings, in order: roles (only origin counts) → structural exclusions (no page-level origin
means no correlation) → set equality on families. Two guards: internal never joins external, and a
group of one is not a problem.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Evidence roles | `evidenceRoles()` returning subject and origin; `pagesInvolved` derived as the union | A silent behaviour change in the existing page counts — guarded by keeping its tests unmodified |
| 2. The correlation rule | `correlate.ts` plus shape tests written expectations-first | Getting the grouping key subtly wrong in a way that only shows at whole-run scale |
| 3. The view | Problems above the type groups; folded findings removed below | Duplication or loss if the fold and the removal happen independently |
| 4. Real-site proof | Confirmed groups on run `29fa2fc7`, limits recorded | Softening a verdict to keep an attractive number |

**Prerequisites:** S-02, S-04, S-05 complete (they are); local database running with stored run
`29fa2fc7`.
**Estimated effort:** ~2–3 sessions across 4 phases; Phase 1 is small, Phase 2 carries most of it.

## Open Risks & Assumptions

- **The number is seductive.** 67 → 7 was measured by probe before implementation. It is a
  pre-registered prediction, not a target; if the rule lands elsewhere, the plan explains the
  divergence rather than tuning toward the number.
- **One measured false correlation exists** — the shared-layout case. The internal/external guard
  splits it correctly on this run, but the underlying tension (shared layout ≠ shared cause) will
  recur for a future pair of types and will need its own ruling.
- **The whole axis rests on hreflang.** Yazaki has 51 ten-member families over 533 pages, which is
  why it pays so well. A monolingual client gets much less. Accepted, recorded.
- **Read-time recomputation** is invisible at 67 findings and would not be at thousands. The answer
  then is persistence, which is deliberately deferred.

## Success Criteria (Summary)

- Twenty broken links and eight diverged variants — two different check types — appear as **one**
  explained problem, because the site's own hreflang graph says the pages emitting them are the same
  page in two languages.
- Every finding appears exactly once: folded into a problem, or in the type list, never both.
- Each problem survives the question *would one edit fix all of these?*, checked by hand on a real
  client site.
