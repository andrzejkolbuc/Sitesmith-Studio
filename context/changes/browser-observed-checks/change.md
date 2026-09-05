---
change_id: browser-observed-checks
title: Browser-observed checks
status: implementing
created: 2026-09-05
updated: 2026-09-05
archived_at: null
---

## Notes

Roadmap item **S-06**, opened 2026-09-05 immediately after S-12 archived.
Prerequisite S-01 is satisfied (`built`).

The roadmap's framing:

> User can see JavaScript console errors, Core Web Vitals and performance
> scores for a representative sample of pages, and image weight problems.

PRD refs: FR-015, FR-028, FR-029.

**Why this slice next.** It unblocks the most: S-08 (visual regression) cannot
start without the rendering capability introduced here, and S-12 closed with
FR-039 recorded as only *partly* met — its "scores" half is precisely the Core
Web Vitals this slice produces. S-06 is the named prerequisite for that
remainder.

**The roadmap's own risk note**, carried forward because it shapes the whole
slice: this is where rendering pages in a real browser enters the product, and
it is introduced here rather than in a foundation because this is the first
slice that needs it. Performance is sampled rather than per-page **by explicit
PRD decision** — measuring every URL would take hours and destroy the primary
success criterion ("fast enough that it actually gets run").

**The open unknown**, from the roadmap, owner: user, non-blocking:

- Does adding page rendering to a run break the run-duration property S-01
  measured?

Things to settle while researching:

- **Where rendering sits relative to the existing crawl.** The crawl today is a
  fetch-based pipeline; a browser is a second, far more expensive channel. Is it
  a second pass over a sample, or an option on the existing pass?
- **What counts as a "representative sample".** The PRD decided sampling; it did
  not define the sample. Whatever we pick is a claim about coverage and has to
  be sayable to the reader.
- **What a console error is evidence of.** Every finding must be traceable to
  something the site itself asserted (`lessons.md` rule 1) — a console error is
  the site's own runtime complaining, which is strong, but third-party scripts
  complaining about themselves are not the client's defect.
- **Rule-set bookkeeping.** S-12 shipped `runs.ruleSet`, derived from
  `FINDING_TYPES`. New finding types here change the recorded rule set, which is
  exactly the case `rules_changed` was written for: the first comparison across
  this slice's deployment will correctly refuse rather than report the new
  findings as the site breaking. Worth verifying on a real project, not assuming.
