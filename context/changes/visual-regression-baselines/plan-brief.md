# Visual regression with baselines and masked regions — Plan Brief

> Full plan: `context/changes/visual-regression-baselines/plan.md`
> Research: `context/changes/visual-regression-baselines/research.md`

## What & Why

Roadmap slice **S-08**. A user pins one run's rendered snapshots as a project's
baseline; every later run reports which of those pages now look different, where
on the page, and side by side against the baseline. It answers the pain US-02
names — deciding whether a deploy broke anything — and it is the slice S-06 was
sequenced to unblock, since the browser rendering S-06 introduced is what makes a
snapshot possible at all.

## Starting Point

S-06 built the machinery and none of the storage. `render.ts` already launches
Chromium, loops a sample serially with a fresh context per page, and records
failure rather than throwing. What does not exist: anywhere to put bytes (every
artifact stored so far is a Postgres row), anything that enforces the retention
policy the PRD resolved, any project mutation besides `create` and `startRun`,
and any surface that can serve binary. The render sample that does exist ranks by
inbound-link count, so it reshuffles precisely when navigation changes.

## Desired End State

A project has a baseline, and every later run renders exactly the pages that
baseline captured, photographs each as a masked full-page PNG at a pinned
viewport, and reports the ones that no longer match — with a changed-pixel count,
bounding boxes saying where, and a side-by-side review with an on-demand overlay.
Images expire on the PRD's rule, enforced by code, and a snapshot that expired
stays distinguishable from one that was never taken.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| What gets snapshotted | A bounded watched set, not each page | FR-031's "each page" is 1.5–2h per run at S-06's measured 4–6s per render; same shape FR-028 had before it was rewritten to sampled | Plan |
| Image storage | Postgres `bytea` | Keeps one datastore; tenant scoping and cascade come free; retention becomes a `DELETE` | Plan |
| How the watched set is chosen | Pinned by the baseline | Stable by construction — cannot drift when navigation changes, which is the deploy most likely to break a page | Research → Plan |
| Diff library | `pixelmatch` + `pngjs` | Pure JS, so F-02's container gains no native dependency; anti-alias handling is the library's published heuristic, not one we invented | Plan |
| What a difference reports | Changed-pixel count, share, bounding boxes | Measurements, not a grade — the third time a composite index has been refused | Plan |
| Masks | CSS selectors, applied at capture | The volatile content never enters storage; survives reflow, unlike a rectangle | Plan |
| Geometry | Full page at a pinned viewport | Catches below-the-fold breakage; recording the viewport lets a mismatch refuse instead of reporting every page changed | Plan |
| Visual difference | A `FINDING_TYPES` entry | Enters `ruleSet`, correlation and the trend automatically — a visually broken page correlating with a console error is what FR-040 exists for | Plan |
| Re-baseline handling | New `visualComparability`, not a change to `comparability()` | A baseline moving is our state changing, but it must not suppress the hreflang comparison | Research → Plan |

## Scope

**In scope:** snapshot capture inside the existing render pass; `pageSnapshots`
storage with three-state nullability; retention rule and its enforcer; baseline
pinning and per-project masks; pixel comparison with regions; a `visual_changed`
finding; a review panel; a tenant-scoped image route; real-site proof.

**Out of scope:** snapshotting every page; a similarity score; mobile or
second-viewport capture; storing the diff overlay; per-finding muting; baseline
history.

## Architecture / Approach

The spine is one decision: **pinning a baseline pins the render set.** Once a
project has a baseline, the pages a run renders are the pages the baseline
captured — read from rows, never re-derived — which makes the comparison possible
and stops the vitals sample drifting as a side effect.

Capture happens inside `measure()` after the vitals read (scrolling first would
contaminate CLS), with bytes handed to a per-page sink so nothing accumulates
across the loop and `render.ts` stays free of any database import. Comparison
happens at run close alongside every other rule, producing finding rows. The
project page gains a section; a new route handler serves the PNGs and
re-establishes tenant ownership itself.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Where a snapshot lives | Schema, baseline and mask columns, retention rule + enforcer | Getting the three-state nullability wrong makes "expired" indistinguishable from "never taken" |
| 2. What a snapshot is a picture of | Capture at a pinned viewport, masked, full page | Lazy content below the fold not loading, so every such region reads as changed |
| 3. Pinning a baseline | `pinBaseline`, `setMasks`, the stable watched set | The watched set silently falling back to the drifting sample |
| 4. What differs, and where | pixelmatch, regions, the finding, visual comparability | Our own renderer being the noise source rather than the site |
| 5. Showing it | Review panel, image route, coverage sentence | The route leaking across tenants; the panel restating the finding's sentence |
| 6. Real-site proof | Measured proof on tecalliance, requirement bookkeeping | An unchanged site not comparing clean, which would invalidate every number |

**Prerequisites:** S-06 and S-07 both archived (done). A real client project to
run against — tecalliance, as S-06 and S-12 used. Two new npm dependencies.
**Estimated effort:** ~6 sessions, one per phase, matching S-06's shape.

## Open Risks & Assumptions

- **The renderer may be its own noise source.** If two runs of an unchanged site
  do not compare clean once anti-aliasing is excluded, every number this slice
  reports is ours rather than the site's. Phase 6 measures it; any floor is
  derived from that measurement, never guessed in advance.
- **Full-page height varies with content**, so a page that grew produces a taller
  PNG. Compared over the overlap with the delta reported — chosen deliberately,
  but it means a content change and a layout break look similar until read.
- **A mask is a CSS selector**, so a wrong one silently masks nothing, and
  changing the list invalidates comparison against older snapshots.
- **Storage is estimated, not measured.** Tens to low hundreds of megabytes at
  twelve watched pages across ten projects; Phase 6 records the real number.

## Success Criteria (Summary)

- Two runs of an unchanged real site report no differing pages.
- A deliberately changed page is caught, with regions pointing at what changed,
  and a mask over that region stops it reporting.
- A project with no baseline reads as needing one — never as having no problems.
