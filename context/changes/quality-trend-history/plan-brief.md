# Quality Trend History — Plan Brief

> Full plan: `context/changes/quality-trend-history/plan.md`
> Research: `context/changes/quality-trend-history/research.md`

## What & Why

Roadmap slice **S-12**. A user can see how many findings of each kind a project
has had over time — but only across runs produced under the same conditions, so
the line describes the site rather than our own changing rule set. Scoped to the
**issue-counts half of FR-039**; the "scores" half is Core Web Vitals and belongs
to S-06.

## Starting Point

Everything a counts trend reads is already stored, and S-07 added the columns
that make a run judgeable. What is missing is a record of *which detection rules
produced a run* — so a type with no findings cannot be told apart from a rule
that did not exist. The same gap is a live defect in S-07's comparison: the first
comparison after any new rule ships will report every finding it produces as
`new`.

## Desired End State

Below the run history, a grid: finding types down, qualifying runs across, counts
in the cells. A type not checked by a run reads as *not checked*, never as zero.
Runs that do not qualify — truncated, rescoped, or produced by different rules —
are not plotted at all, and while nothing qualifies the section says what is
missing rather than showing an empty frame.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| What "score" means | Core Web Vitals — S-06's, not ours | The PRD uses the word three times and means CWV each time; nothing here computes a score | Research |
| FR-039 scope | Ship counts, record FR-039 as partly met | The counts half is deliverable now; the scores half is not deliverable at all | User |
| Primary series | Per-type, with the total as context | A rule arriving reads as a series beginning, not a site degrading; yazaki's 12 → 42 → 66 is almost entirely us | Plan |
| Rule-set record | Full type list as jsonb, derived from `FINDING_TYPES` | Self-updating, so nobody can forget to bump it — the one failure mode of a hand-kept version | Plan |
| Trend eligibility | Complete crawl, same scope, same rule set | Every plotted point genuinely on one axis; inherits the comparison's guarantee instead of re-creating the problem | Plan |
| Where the guard lives | Extend `comparability()`, don't duplicate | The trend's question is the comparison's question plus one clause; two checks would drift | Plan |
| Rendering | A grid, types down / runs across | Reuses `ParityGrid`'s exact grammar and row-cap behaviour; no dependency, no new idiom in a codebase with no SVG at all | Plan |
| Placement | Section on the project page | The product has one project route; a sub-route is new navigation for a nice-to-have | Plan |
| Empty state | Explain what is missing | Matches the comparison's refusal wording; hiding it makes the feature look absent | Plan |
| Existing runs | Not backfilled | Their rule set was never observed; the next two runs establish a baseline | Plan |

## Scope

**In scope:** a `ruleSet` column written per run; a `rules_changed` clause in the
comparability guard and its reader-facing sentence; a per-type aggregate query;
a pure `buildTrend`; the grid section and its empty state; real-site proof; the
roadmap note recording FR-039 as partly met.

**Out of scope:** the scores half of FR-039 (needs S-06); any invented quality
score; trending the parity ratio; trending correlated problems; backfilling
`ruleSet`; plotting ineligible runs with a caveat; a new route; a charting
dependency.

## Architecture / Approach

Four dependencies in order. A run records the rules that produced it. The
comparability guard gains a clause for them — which simultaneously fixes S-07's
comparison, since the same clause that makes a trend point legitimate makes a
diff honest. A query aggregates per-type counts across the runs that pass the
guard, and a pure builder shapes them into types-down/runs-across. The view
renders that in the parity grid's existing grammar.

Computed per request and never stored, for the reason the comparison is not
stored: it is derived, and freezing it would leave old projects described by a
rule nobody would write today.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Record the rule set | `ruleSet` written per run | A hand-maintained list instead of a derived one |
| 2. Rule-set comparability | The fourth reason, plus a fix to S-07's comparison | Changes shipped behaviour; ordering against `scope_changed` matters |
| 3. The trend model | Aggregate query and pure `buildTrend` | Conflating *not checked* with zero — the whole point of Phase 1 |
| 4. The trend grid | The section and its empty state | A 24-row grid staying legible; `FINDING_LABEL` duplication |
| 5. Real-site proof | A populated grid, FR-039 recorded honestly | An unchanged project showing any movement at all |

**Prerequisites:** none — S-07 is archived and its columns are in.
**Estimated effort:** ~2 sessions across five phases.

## Open Risks & Assumptions

- **Phase 2 changes shipped behaviour.** Comparisons across a rule-set change
  start refusing where they previously reported false `new` findings. That is the
  correct answer, but it is a visible change to a feature closed yesterday.
- **Nothing plots on release.** No existing run has a `ruleSet`, so every project
  shows the empty state until it has been run twice more. Accepted as the cost of
  not backfilling, and the same shape as S-07's rollout.
- **A 24-row grid may not be legible** on a project exercising every rule. The
  row cap and movement-first sorting are the mitigation; Phase 4's manual check
  is where that gets judged.
- **Column capping is a guess.** How many runs belong on screen is not knowable
  before seeing one; expect to adjust it after the real-site proof.

## Success Criteria (Summary)

- Two runs of an unchanged project produce a grid whose rows are all flat.
- A rule shipped between two runs shows as a series beginning, never as a spike.
- A scope change removes a run from the series rather than drawing it as a cliff.
