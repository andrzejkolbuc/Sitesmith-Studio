---
change_id: visual-regression-baselines
title: Visual regression with baselines and masked regions
status: preparing
created: 2026-09-06
updated: 2026-09-06
archived_at: null
---

## Notes

Roadmap item **S-08**, opened 2026-09-06 immediately after S-06 archived.
Prerequisites S-06 (`browser-observed-checks`) and S-07
(`run-history-and-comparison`) are both `done`.

The roadmap's framing:

> User can promote a snapshot to be a project's baseline, see which pages differ
> from it and where, review differences side by side, and mask volatile regions
> so they stop reporting.

PRD refs: US-02, FR-031, FR-032, FR-033, FR-034, FR-035.

**Why this slice next.** It is the slice S-06 was sequenced to unblock — the
browser rendering S-06 introduced is what makes a snapshot possible at all — and
it answers the user's most-stated pain in US-02. The roadmap has called it the
most expensive subsystem in the product and the one most likely to be abandoned;
that is the risk this slice is managing, not a reason to defer it further.

**What is already answered, and must not be re-litigated:**

- **Retention** (PRD Open Question 5, resolved 2026-08-31). Run metadata and
  findings are kilobytes of rows, kept indefinitely. **Snapshots are the line
  item that would force a hosting bill**: the pinned baseline never expires;
  beyond it, only the three most recent runs keep their images. This is what
  un-blocked the slice.
- **Rendering cost** (S-06's proof). About 4–6s per rendered page, and affordable
  **only at an absolute cap** — a sample defined by a formula measured 143
  renders on a 533-page site. Whatever this slice renders, the cap has to be
  absolute and stateable in advance.
- **No per-finding muting** (PRD Non-Goals, declined). Per-project
  ignore-regions (FR-035) are the *only* suppression mechanism that survived,
  and they cover visual noise only.

**Things to settle while researching:**

- **What gets snapshotted, and how many.** FR-031 says "each page in a run",
  which is the same per-page-versus-sample tension S-06 resolved by capping. A
  snapshot is both a render (4–6s) and bytes on disk, so it is constrained twice.
  Whatever coverage we pick is a claim about the reader's site and has to be
  sayable, the way S-06's `renderSummary` is.
- **Where images live.** Every artifact so far is a row. This is the first one
  that isn't, and retention has to be enforced by something rather than assumed.
- **What "differs" means, and what the reader is shown.** FR-033 wants *where*
  on the page, not just that it changed. Anti-aliasing, font loading and
  animation all move pixels without the page changing — the same
  conservative-detection problem as `lessons.md` rule 1, in a medium where our
  own rendering is part of the evidence.
- **Ignore-regions: what is a region a coordinate of?** A viewport rectangle
  breaks when the page reflows; a selector survives reflow but is DOM structure.
  FR-035 scopes them per project, not per page.
- **Rule-set bookkeeping, again.** `lessons.md` rule 4 — a rule shipping is not
  the site changing. New finding types here change `runs.ruleSet`, so the first
  comparison across this slice's deployment should refuse rather than report.
  Additionally: a *re-baseline* is our state changing, not the site's, and the
  comparison has to know that.
