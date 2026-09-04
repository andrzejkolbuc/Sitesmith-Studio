---
change_id: run-history-and-comparison
title: Run history and run-over-run comparison
status: implemented
created: 2026-09-04
updated: 2026-09-04
archived_at: null
---

## Notes

Roadmap item **S-07**, opened on 2026-09-04. Prerequisite S-01 is `built`;
S-09 (`correlated-findings`) closed the same day, which makes this the second
half of the product's domain rule: S-09 collapses many symptoms into one
explained problem, S-07 separates what *changed* from accumulated known state.

PRD refs: US-02, FR-037, FR-038.

The roadmap's framing to carry into planning:

> The second half of the domain rule — separating what changed from accumulated
> known state — and the thing that makes a go-live decision possible rather than
> just a list of problems. Cannot come earlier: it needs at least two stored runs
> to demonstrate anything. Cheap once S-01 stores runs, since it adds comparison
> rather than collection.

Roadmap lists no unknowns for this slice. Two things to settle while planning,
neither an external dependency:

- What identity does a finding carry across runs, so "the same problem, still
  there" is distinguishable from "a new problem that looks similar"? Page
  identity under redirects was already normalised (see
  `context/archive/2026-08-31-page-identity-under-redirects/`), which this
  should build on rather than re-derive.
- How does comparison interact with S-09's correlated problems — does the diff
  run over raw findings, over correlated groups, or both?

Research answered both, and found a third thing the roadmap did not list: two runs
of the same project are not automatically comparable. See `research.md`.

Open Roadmap Question 5 (retention) turns out to be **resolved** in the PRD as of
2026-08-31 — run metadata and findings are kept indefinitely, and only snapshots
are bounded. `context/foundation/roadmap.md` still lists it as open; that is a
roadmap staleness, not a constraint on this slice.

Unblocks S-12 (quality trend history) and is a hard prerequisite for S-08
(visual regression baselines).
