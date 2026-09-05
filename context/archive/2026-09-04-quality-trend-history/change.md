---
change_id: quality-trend-history
title: Quality trend history
status: archived
created: 2026-09-04
updated: 2026-09-05
archived_at: 2026-09-05T17:07:58Z
---

## Notes

Roadmap item **S-12**, opened on 2026-09-04 once S-07 closed. Prerequisite
satisfied: run history exists, and every run produced from now on records the
metadata that says whether it can be compared to another.

PRD ref: FR-039 — **nice-to-have**, unlike everything shipped so far. Worth
holding that in view while planning: this is the first slice whose absence
nobody would call a defect.

The roadmap's framing:

> User can see scores and issue counts tracked over time, revealing drift rather
> than only last-run state.

Both of its stated unknowns are already answered:

- **Retention** — PRD Open Question 5, resolved 2026-08-31. Run metadata and
  findings are kilobytes of rows and are kept indefinitely, so the trend needs
  no window at all. Only snapshots expire, and this slice draws no snapshots.
- **Sequencing** — S-07 shipped 2026-09-04
  (`context/archive/2026-09-04-run-history-and-comparison/`).

Three things to settle while planning. Research answered the first and it turned
out to be an external dependency after all — see `research.md`.

- **~~What is a "score"?~~** Answered, and not as guessed. The PRD's "scores"
  are Core Web Vitals and page performance scores (FR-028, and the regression
  catalogue at `prd.md:62`) — numbers a browser reports, not an index this
  product would invent. They are delivered by **S-06 `browser-observed-checks`,
  which is `proposed` and unbuilt**. So S-12 as scoped can deliver only the
  issue-counts half of FR-039, and the roadmap's prerequisite list for S-12
  (S-07 only) is incomplete.
- **What is a comparable point on the trend?** S-07 established that two runs
  are only comparable when both finished and ran under the same scope. A trend
  line drawn through runs of different scopes has the same defect the comparison
  refuses — a change in the line that describes our configuration, not the site.
  The `crawlComplete` / `reachedPageLimit` / `scope` columns S-07 added are what
  makes this answerable.
- **Counts of what?** Raw findings, correlated problems (S-09), or per-type
  series. Correlated problems are the number the product would rather stand
  behind, but they are computed at read time and were deliberately not frozen,
  so a trend over them is recomputed history rather than recorded history.

Real data already exists to draw against: yazaki has 10 runs spanning
2026-08-30 to 2026-09-04, with finding counts moving 12 → 8 → 9 → 42 → 66 → 67
as detection rules were added. Which is itself the trap worth naming early —
most of that movement is us, not them.

## Scope decision, 2026-09-04

**Ship the issue-counts half now; flag FR-039 as partly met.** Decided by the
user after research established that FR-039's "scores" are S-06's Core Web
Vitals rather than a number this slice could compute.

What that means for planning:

- FR-039 is **partly** delivered by this change. The roadmap and PRD should say
  so rather than recording the requirement as met — a half-met requirement
  silently marked done is worse than one openly left open.
- S-06 remains an unrecorded prerequisite for the scores half. Closing S-12 must
  not close FR-039.
- The counts half is the whole of this slice's scope: what to count, which runs
  are legitimate points, and what has to be recorded per run so a series is
  about the site rather than about our rule set.
