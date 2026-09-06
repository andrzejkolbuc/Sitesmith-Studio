---
date: 2026-09-06T07:12:00Z
researcher: Andrzej Kolbuc
git_commit: e109975a1bf2f4f1fe2d8b8ac4b3bc9c4dbb256f
branch: master
repository: Sitesmith-Studio
topic: "S-08 visual regression with baselines and masked regions — what exists, what is missing, and what the codebase's own rules constrain"
tags: [research, codebase, visual-regression, snapshots, storage, retention, render, comparison]
status: complete
last_updated: 2026-09-06
last_updated_by: Andrzej Kolbuc
---

# Research: Visual regression with baselines and masked regions (S-08)

**Date**: 2026-09-06T07:12:00Z
**Researcher**: Andrzej Kolbuc
**Git Commit**: `e109975a1bf2f4f1fe2d8b8ac4b3bc9c4dbb256f`
**Branch**: `master`
**Repository**: Sitesmith-Studio

## Research Question

What does the codebase already provide for S-08 (FR-031 to FR-035), what does it
not provide, and which of the repo's standing decisions constrain how the slice
can be built? Specifically, the four questions `change.md` opened with: what gets
snapshotted and how many, where images live, what "differs" means, and what a
masked region is a coordinate of.

## Summary

**S-06 built most of the machinery and none of the storage.** A browser already
launches, a sample is already chosen deterministically, a per-page render loop
already exists with per-page isolation and a failure discipline that never fails
the run. Adding `page.screenshot()` to `measure()` is close to a one-line change.
Everything difficult about this slice is downstream of that line.

Four findings shape the plan, in descending order of how much they change it:

1. **There is no place to put bytes, and no precedent for one.** Every artifact
   the product has ever stored is a Postgres row: `runs`, `pages`,
   `pageObservations`, `findings`. There is no object store, no filesystem
   writer, no `STORAGE_*` env var, no `sharp`, no S3 client — `src/env.js` has
   exactly three variables and one of them is `NODE_ENV`. This slice introduces
   the first artifact that is not a row, and the retention rule that unblocked it
   (baseline pinned, three most recent runs) currently has **nothing that
   enforces it** — the PRD resolved the policy, the codebase has no sweeper, no
   expiry job, and no place a sweeper would delete from.

2. **FR-031 as written is in direct conflict with what S-06 measured.** It says
   the product "captures a rendered snapshot of **each page** in a run". A render
   costs 4–6s measured on a real client site; the sample is capped at twelve for
   exactly that reason, and the naive per-template formula came to 143 renders on
   a 533-page site. Snapshotting each page of a 1,200-URL site is 1.5–2 hours of
   rendering per run and, at four retained sets across ten projects, tens of
   gigabytes. The PRD **already recorded this objection and did not adopt it**
   (`prd.md:274`, "the line item most likely to force a hosting bill"), deferring
   it to Open Question 5 — which was then resolved in a way that bounds *history
   depth* and says nothing about *breadth*. FR-031 is the same requirement shape
   FR-028 had before it was rewritten from per-page to sampled. This slice has to
   make the same call, and say so.

3. **The existing sample is stable only across runs where nothing changed.**
   `chooseRenderSample` ranks by inbound-link count with URL as tiebreak,
   documented as making "two runs of an unchanged site choose the same pages"
   ([sample.ts:133](src/server/crawl/sample.ts)). That is the right property for
   vitals and an insufficient one here: a visual comparison needs the *same page*
   in both runs, and inbound-link counts move whenever navigation changes — which
   is one of the deploys most likely to break a page visually. A sample that
   reshuffles under the exact condition being hunted would silently drop pages
   out of comparison and report nothing.

4. **A re-baseline is our state changing, not the site's** — and
   `lessons.md` rule 4 is the entry that anticipates this exactly. `comparability`
   already refuses on `rules_changed`, `scope_changed`, `incomplete_crawl` and
   `not_recorded`. A visual comparison adds two more preconditions of the same
   kind: the baseline must not have been re-pinned in between, and the ignore-mask
   must not have changed. Both are cases where a difference count moves because
   *we* changed, and both belong in the refusal path rather than in the results.

## Detailed Findings

### A. The render pipeline — what already exists

[`src/server/crawl/render.ts`](src/server/crawl/render.ts) is 276 lines and does
exactly one job: launch Chromium, visit a list of URLs, collect console errors
and vitals.

- `renderSample(options)` launches once, loops the URLs serially, closes in a
  `finally` ([render.ts:153](src/server/crawl/render.ts)). Serial, not parallel —
  consistent with the politeness ceiling the crawl obeys.
- `measure()` creates **a fresh `browser.newContext()` per page** with the stated
  reason that a warm cache would report a speed no first-time visitor sees
  ([render.ts:211](src/server/crawl/render.ts)). This is also what a screenshot
  needs: no carried-over cookie banner state, no service worker.
- **No viewport is set**, so Playwright's default applies. A screenshot is a
  claim about a rendering at a size; the size has to be pinned and recorded
  alongside the image, or a change to it later reads as every page changing.
- Failure is recorded, never thrown: a browser that will not launch returns
  `{observations: [], complete: false}` and the run carries on
  ([render.ts:169](src/server/crawl/render.ts)). The comment names the reason —
  reporting our infrastructure as the client's defect would be `lessons.md`
  rule 1 again. Screenshot capture must join this discipline, not add a throw.
- `SETTLE_MS = 1_500` after `load`, to catch late layout shift
  ([render.ts:107](src/server/crawl/render.ts)). A screenshot taken at the same
  moment inherits that settle for free — but fonts, lazy images and animation are
  a different problem from CLS, and Playwright's `screenshot({animations:
  "disabled"})` is the mechanism that exists for it.
- **Returning image bytes through `RenderResult` would put megabytes in memory
  across the loop.** The current return type is small structured data. The crawl's
  documented habit is to write as it goes so memory stays flat across a 1,200-URL
  run ([run.ts:230](src/server/crawl/run.ts) and the `pages` table comment) — the
  same argument applies per screenshot.

### B. The sample — the decision the whole slice inherits

[`src/server/crawl/sample.ts`](src/server/crawl/sample.ts) is the most
argued-through file in the directory, and its docblock is effectively a design
record: template coverage is not observable, `products`/`produkte`/`produits`
produced 113 sections for ten real ones, and `MAX_RENDERS = 12` is "the entire
cost control".

Load-bearing for this slice:

- The entry page is always taken first when the cap allows
  ([sample.ts:109](src/server/crawl/sample.ts)).
- Then per declared locale, ranked by inbound links, **round-robin** so a cap
  never starves a locale ([sample.ts:133](src/server/crawl/sample.ts)).
- `cap = 0` genuinely means zero — the code refuses to clamp up, because a caller
  that asked for no measurement must not receive one
  ([sample.ts:90](src/server/crawl/sample.ts)). This was a real bug caught in
  Phase 4 of S-06.
- `countInboundLinks` excludes self-links ([sample.ts:176](src/server/crawl/sample.ts)).

The open design question this raises: **should the visual sample be the render
sample, or a pinned set of its own?** A pinned set (the URLs promoted with the
baseline) is stable by construction and makes "which pages are under visual
watch" a thing the reader can see and edit. Reusing the render sample is free but
inherits the reshuffle problem in finding 3.

### C. Storage — the gap

Confirmed absent, by inspection rather than assumption:

| Thing | Status |
| --- | --- |
| Object store / blob client | none — no S3, no Azure Blob, no MinIO in `package.json` |
| Filesystem write path | none — nothing in `src/server` writes a file |
| Image library | none — no `sharp`, no `pngjs`, no `jimp` |
| Pixel-diff library | none — no `pixelmatch`, no `odiff` |
| Storage env var | none — `src/env.js` has `AUTH_SECRET`, `DATABASE_URL`, `NODE_ENV` |
| Retention sweeper | none — nothing deletes anything, anywhere |

`@playwright/test`'s `toMatchSnapshot` is **not** available here: `@playwright/test`
is a devDependency and a test-runner API. Runtime diffing is a new dependency
whichever way it goes, and it grows F-02's constraint a second time — that
foundation already has to ship Chromium and its system libraries because of S-06,
and would now also need whatever native bits the image path pulls in.

Storage shape is a genuine fork with no precedent to follow:

- **Postgres `bytea`** — keeps the one-datastore property, makes tenant scoping
  and cascade deletion automatic (every table here carries `tenantId` and the
  isolation tests assert on it), and makes retention a `DELETE`. Costs: images in
  the row store, backup size, and a query path that must never accidentally
  `SELECT *` a screenshot into a list view.
- **Filesystem under a configured root** — cheap and obvious, but introduces a
  second source of truth that can drift from the rows, needs its own tenant-path
  discipline, and does not survive the container F-02 will build unless a volume
  is mounted, which is a deployment fact nobody has decided.

Either way the **retention rule needs an owner in code**. "The baseline never
expires; beyond it only the three most recent runs keep their images" is a
sentence in the PRD; nothing in the repo would make it true.

### D. Comparison and the honesty rules

[`src/server/crawl/comparison.ts`](src/server/crawl/comparison.ts) is the model
this slice should extend rather than duplicate.

- `ComparabilityReason` is a closed union of four reasons, checked
  most-fundamental-first so the reader is told the thing they can fix
  ([comparison.ts:78](src/server/crawl/comparison.ts)).
- `rules_changed` is evaluated **last and deliberately**, because it is the one
  reason that is about us rather than their site
  ([comparison.ts:127](src/server/crawl/comparison.ts)).
- `runs.ruleSet` is derived from `FINDING_TYPES` at close, never hand-maintained
  ([run.ts:433](src/server/crawl/run.ts)) — so any new visual finding type
  automatically changes the rule set, and the first comparison across this
  slice's deploy correctly refuses. That is already handled; it needs verifying
  on a real project, not building.
- The nullable columns all carry the same comment: **null means *not recorded*,
  not false**, with an explicit "do not fix this to `notNull().default(false)`"
  on `crawlComplete` ([schema.ts:246](src/server/db/schema.ts)). Any new column
  here inherits that convention.
- Absence-as-representation is the `pageObservations` design: a table rather than
  columns on `pages`, "because only a sample is measured" and absence of a row
  *is* "not measured" ([schema.ts:407](src/server/db/schema.ts)). A `pageSnapshots`
  table would be the same shape for the same reason.

### E. Findings and the UI shell

- `FINDING_TYPES` holds 28 entries at [findings.ts:28](src/server/crawl/findings.ts);
  S-06 added four (`image_missing_dimensions`, `image_legacy_format`,
  `image_oversized`, `console_error`). Every entry needs a reader-facing label in
  [`finding-labels.ts`](src/app/\(app\)/projects/\[id\]/finding-labels.ts) — S-06's
  plan carried an automated check asserting exactly that (row 5.7), worth
  repeating.
- [`run-panel.tsx`](src/app/\(app\)/projects/\[id\]/run-panel.tsx) is 1,763 lines
  and is where sections compose: `RunHistory`, `TrendGrid`, the comparison
  refusal block, `Problems`, `Findings`, `Evidence`, `Performance`. The
  convention is that **presentation logic is split into a pure sibling module**
  with its own unit test — `summarise.ts`, `parity.ts`, `trend.ts`,
  `correlate.ts`, `comparison-view.ts`, `performance.ts`. A visual section should
  follow it.
- `performance.ts` is the closest template for this slice's honesty problem: its
  `PerformanceState` union distinguishes `not_recorded` / `unavailable` /
  `nothing_to_measure` / `measured`, and the docblock states the rule plainly —
  never "no problems found" on a section that looked at twelve pages of five
  hundred ([performance.ts:85](src/app/\(app\)/projects/\[id\]/performance.ts)).
  A visual section needs the same four-way distinction plus a fifth: **no
  baseline pinned yet**, which is neither a pass nor a failure.
- Serving an image to the browser is a new surface: tRPC returns JSON via
  superjson and is the wrong channel for binary. A route handler under
  `src/app/api/` is the shape that exists (`api/auth/[...nextauth]`,
  `api/trpc/[trpc]`), and it must re-establish tenant ownership itself — NFR-2 is
  a binary commitment and the isolation tests
  ([tenant-isolation.test.ts](src/server/api/tenant-isolation.test.ts)) assert
  across surfaces. **A snapshot URL is a surface a result can appear on.**

### F. Ignore-regions — what a region is a coordinate of

FR-035 scopes masks **per project**, not per page. `projects` currently holds
scalar and `text[]` columns plus pacing integers; there is no per-project JSON
config column and no settings UI beyond create
([projects/new/page.tsx](src/app/\(app\)/projects/new/page.tsx)) — `project.create`
is the only mutation on the router besides `startRun`.

The substantive question is what a mask is expressed in:

- **A viewport rectangle** is what a user can draw, and it breaks the moment the
  page reflows — including at a different viewport width than the one it was
  drawn at, which is why the viewport has to be pinned and recorded (finding A).
- **A CSS selector** survives reflow and is what the volatile thing actually is
  (`.carousel`, `#ad-slot`), but it is DOM structure — and `CLAUDE.md`'s own
  locator rule and `lessons.md` rule 1 are both suspicious of reasoning from
  structure. Against that: a mask is *not a finding*. It is the user telling us
  what to ignore, so it is their assertion, not our inference. That distinction
  is worth writing down explicitly, because the rule as stated would otherwise
  read as forbidding it.
- Playwright supports both natively: `screenshot({mask: [locator, ...]})` paints
  masked elements over at capture time, which has the significant property that
  **the volatile region never enters the stored image** — nothing to leak, and no
  need to re-apply masks when comparing old snapshots.

## Code References

- `src/server/crawl/render.ts:153` — `renderSample`, the browser lifecycle
- `src/server/crawl/render.ts:211` — fresh context per page, and why
- `src/server/crawl/render.ts:107` — `SETTLE_MS`, the post-load settle
- `src/server/crawl/sample.ts:60` — `MAX_RENDERS = 12`, "the entire cost control"
- `src/server/crawl/sample.ts:133` — round-robin ranking and the stability claim
- `src/server/crawl/run.ts:276` — where the sample is chosen inside a run
- `src/server/crawl/run.ts:300` — the render pass, wrapped so it cannot fail the run
- `src/server/crawl/run.ts:433` — `ruleSet` derived from `FINDING_TYPES` at close
- `src/server/crawl/comparison.ts:78` — `comparability`, ordered most-fundamental-first
- `src/server/db/schema.ts:246` — `crawlComplete`, the "null means not recorded" convention
- `src/server/db/schema.ts:407` — `pageObservations`, absence-as-representation
- `src/server/api/routers/project.ts:350` — `runObservations`, summary travelling with data
- `src/app/(app)/projects/[id]/performance.ts:85` — `performanceState`, the coverage sentence
- `src/app/(app)/projects/[id]/run-panel.tsx:376` — section composition order

## Architecture Insights

The repo has a consistent, unusually explicit house style, and every one of these
applies to S-08:

1. **Null means *not recorded*, never a default.** Stated three times in
   `schema.ts` with a "do not fix this" warning attached.
2. **Absence is a representation.** A missing `pageObservations` row means "not
   measured" and is deliberately distinguishable from "measured, nothing found".
3. **The product never asserts an index it invented.** No composite performance
   score, no quality score in the trend. A "visual difference score" would be the
   third time this is refused — a *pixel count* is a measurement, a *0–100
   similarity grade* is an opinion.
4. **A claim about coverage travels with the data.** `renderSummary` sits on the
   run row rather than being inferred from how many observation rows exist, so a
   reader is told the sample was a sample.
5. **Our failures are never reported as the client's defects.** The render pass
   catches everything and records `complete: false`.
6. **Refusal is a first-class output.** The comparison refuses and names the
   precondition, because "a view that shows nothing and says nothing is the thing
   that makes people stop trusting a tool".
7. **Presentation logic is pure and unit-tested** in a sibling module; components
   render what it returns.
8. **Tests split on what must already be running**: `test:unit` needs nothing
   (`vitest.unit.config.ts` names its files explicitly — a new pure module must
   be added to that `include` list), `test:integration` needs Postgres,
   `test:e2e` is Playwright. Note there is **no `drizzle/` migrations directory**:
   schema changes go through `db:push`.

## Historical Context (from prior changes)

- `context/archive/2026-09-05-browser-observed-checks/plan.md:94` — "**Not
  capturing screenshots.** That is S-08, and it depends on this." The boundary was
  drawn deliberately.
- `context/archive/2026-09-05-browser-observed-checks/proof.md` — the 4–6s per
  render measurement, and the finding that rendering is affordable *only at an
  absolute cap*. This is the number the FR-031 decision has to be argued against.
- `context/archive/2026-09-04-run-history-and-comparison/change.md:46` — S-07
  named as a hard prerequisite for S-08 at the time it was built.
- `context/archive/2026-09-04-quality-trend-history/plan.md:37` — the observation
  that new slices shipping rules make every prior comparison answer
  `rules_changed`; the same will happen on this slice's first run.
- `context/foundation/prd.md:274` — the snapshot-storage objection, raised during
  shaping and **not adopted**, deferred to Open Question 5.
- `context/foundation/prd.md:516` — Open Question 5's resolution: baseline pinned
  and never expiring, three most recent runs beyond it. Bounds depth, not breadth.

## Related Research

- `context/archive/2026-09-05-browser-observed-checks/research.md` — the render
  pipeline's own research, including the sampling measurements
- `context/archive/2026-09-04-run-history-and-comparison/research.md` — the
  comparability model this slice extends

## Open Questions

1. **Does FR-031 mean each page, or the sample?** The requirement says each page;
   the measured cost says that is 1.5–2 hours per run on the target site size.
   Recommendation: capture for a bounded, *pinned* set and record the coverage
   the way `renderSummary` does — then record FR-031 as partly met, the way S-06
   recorded FR-015 and FR-028. Owner: user. Block: yes — it sizes the slice.
2. **`bytea` or filesystem?** Postgres keeps one datastore, automatic tenant
   cascade and `DELETE`-based retention; the filesystem is cheaper but adds a
   second source of truth and a volume F-02 has not decided on. Owner: user.
   Block: yes — the schema depends on it.
3. **Is the visual set the render sample, or its own pinned list?** Reusing the
   render sample is free and inherits a reshuffle under exactly the deploys being
   hunted. Owner: research/plan. Block: no — resolvable with an argument.
4. **What is shown as "where it differs"?** A bounding box over changed regions
   is derivable from a pixel diff; a highlighted overlay image is another stored
   artifact. FR-033 wants *where*, FR-034 wants side-by-side. Owner: plan.
   Block: no.
5. **Does a masked region need to be per-page as well as per-project?** FR-035
   says per-project. A selector generalises across pages naturally; a rectangle
   does not. Owner: user. Block: no — start per-project as written.
6. **What refuses a visual comparison?** Proposed additions to
   `ComparabilityReason`, or a parallel union: `baseline_changed`,
   `mask_changed`, `viewport_changed`, `not_snapshotted`. Owner: plan. Block: no.
