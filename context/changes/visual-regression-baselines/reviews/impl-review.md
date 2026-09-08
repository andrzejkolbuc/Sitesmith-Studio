<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Visual regression with baselines and masked regions

- **Plan**: `context/changes/visual-regression-baselines/plan.md`
- **Scope**: Full plan — Phases 1–6 of 6
- **Date**: 2026-09-08
- **Verdict**: NEEDS ATTENTION (all 8 findings triaged and fixed 2026-09-08)
- **Findings**: 0 critical, 5 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | WARNING |
| Pattern Consistency | WARNING |
| Success Criteria | WARNING |

## Automated verification

| Check | Result |
|-------|--------|
| `npm run typecheck` | PASS (exit 0) |
| `npm run check` (biome) | PASS — 116 files, 0 fixes; 1 info (pre-existing `biome.jsonc` deprecation, outside this change) |
| `npm run test:unit` | PASS — 25 files, 745/745 (751/751 after fixes) |
| `npm run test:integration` | PASS — 8 files, 87/87 (88/88 after fixes) |
| `npm run build` | PASS — `/api/snapshots/[snapshotId]` present in the route table |
| `npm run test:e2e` | PASS — 17/17 (re-run after fixes) |

## Findings

### F1 — Diff route runs the whole comparison twice per image request

- **Severity**: WARNING
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/app/api/snapshots/[snapshotId]/route.ts:155
- **Detail**: The `diff` view guards with `if (!compareSnapshots(before, after).comparable) return notFound();` and then calls `diffOverlay(before, after)`. Both delegate to the same private `diff()`, so one overlay request performs **four** PNG decodes, **two** full pixelmatch passes and **two** full-size output allocations — and `compareSnapshots` additionally runs `regionsOf`, a per-pixel scan plus flood fill, whose result is thrown away. On the page sizes `proof.md` measured (1280 x 9,627px) a decoded RGBA buffer is ~49 MB, so this is roughly 200 MB of transient allocation for one `<img>` load. `diffOverlay` already returns `null` for every refusal reason, so the guard buys nothing.
- **Fix**: Delete the `compareSnapshots` guard and rely on `diffOverlay`'s own null: `const overlay = diffOverlay(before, after); if (!overlay) return notFound();`
- **Decision**: FIXED

### F2 — Run close holds both runs' snapshots in memory at once

- **Severity**: WARNING
- **Impact**: MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: src/server/crawl/run.ts:451
- **Detail**: The plan's Critical Implementation Details made this an explicit discipline: "Twelve full-page PNGs held until the loop ends is tens of megabytes... `renderSample` takes an optional async sink instead, called per page." The capture path honours it exactly. The comparison path then does the thing the discipline forbids, twice: `before` and `after` are each built by `load()`, which selects the `image` column for every snapshot of a run, and both maps are fully materialised before the comparison loop starts. At the ~2 MB per PNG `proof.md` measured, that is ~48 MB resident across 24 buffers, on top of the transient decode each `compareSnapshots` performs. Bounded by `MAX_RENDERS`, so not unbounded — but it is twice the footprint the plan singled out as unacceptable, in the same file.
- **Fix A (Recommended)**: Load each pair by URL inside the loop instead of two whole-run maps up front.
  - Strength: Restores the plan's stated flat-memory property with no change in behaviour; the loop already iterates `watched`, and both queries already filter by run.
  - Tradeoff: One query per watched page instead of two per run — up to 12 extra round trips against a local database.
  - Confidence: HIGH — the loop body already fetches per-URL state (`currentIdByUrl`), so the shape is established.
  - Blind spot: Have not measured whether the per-page queries meaningfully lengthen run close.
- **Fix B**: Leave as-is and record the bound in the plan/handoff.
  - Strength: No code risk; the footprint is genuinely capped by `MAX_RENDERS`.
  - Tradeoff: The file now contains a documented rule and a violation of it a hundred lines apart, which is how the rule gets lost.
  - Confidence: MEDIUM — safe today, but `MAX_RENDERS` is the kind of number that gets raised.
  - Blind spot: Unknown whether a future slice raises the render cap.
- **Decision**: FIXED

### F3 — `visualSummary.differing` uses a different threshold from the rule and the panel

- **Severity**: WARNING
- **Impact**: MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Architecture
- **Location**: src/server/crawl/run.ts:631
- **Detail**: `differing` is computed as `v.comparable && v.changedPixels > 0`. The finding rule gates on `share >= MIN_CHANGED_SHARE` (findings.ts:2381) and the panel gates on the same constant via `differsMeaningfully` (visual.ts). `visual-noise.ts` exists precisely because "two places need the number and neither may hold a second copy of it" — this is a third place, holding a different rule. Per `proof.md`, an untouched site still moved 1,831 pixels on its home page, so on a clean re-run this records `differing: 2` while the product reports zero findings and the panel says both pages match the baseline. Nothing renders `differing` today, so no contradiction is visible yet — but it is written into `runs.visualSummary` as the run's own claim, and like `ruleSet` it cannot be recovered afterwards. The first consumer inherits the disagreement.
- **Fix**: Gate on the same share the rule uses — `v.comparable && v.comparedPixels > 0 && v.changedPixels / v.comparedPixels >= MIN_CHANGED_SHARE`.
  - Strength: Makes the recorded number mean what every other surface means by "differs"; imports the one constant the module was created to centralise.
  - Tradeoff: Runs recorded before the fix keep the old semantics, so the column is not uniform across history.
  - Confidence: HIGH — `MIN_CHANGED_SHARE` is already imported into `findings.ts` from the same directory.
  - Blind spot: Have not checked whether S-12's trend work intends to read this column.
- **Decision**: FIXED

### F4 — Snapshot-route isolation test re-implements the handler's query instead of calling it

- **Severity**: WARNING
- **Impact**: MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: src/server/api/tenant-isolation.test.ts:423
- **Detail**: Plan Phase 5 §1 is explicit: the route "gets its own case in `tenant-isolation.test.ts`, not just a code review." The case that exists never imports or invokes `GET`. It asserts that a `pageSnapshots.findFirst` scoped to the intruder's tenant returns undefined — a property of a query the test itself writes. If the handler's `where` clause lost `eq(pageSnapshots.tenantId, user.tenantId)`, this test would still pass, and Progress row 5.8 ("A snapshot route request for another tenant's snapshot answers 404") is recorded as met on that basis. The handler's code is correct today; the guard against it stopping being correct is not there.
- **Fix**: Import `GET` from the route module, stub `~/server/auth`'s `auth()` to return the intruder's session, and assert `(await GET(new Request(url), { params: Promise.resolve({ snapshotId: victim.snapshot.id }) })).status === 404`.
  - Strength: Tests the commitment NFR-2 actually makes — what the surface answers — rather than a restatement of its implementation.
  - Tradeoff: Needs an `auth()` mock, which no test in this file currently sets up.
  - Confidence: MEDIUM — the handler is a plain exported function taking a `Request`, so it is directly callable; the only unknown is the mocking ergonomics for `auth()`.
  - Blind spot: Have not verified how `~/server/auth` behaves under `vi.mock` in the integration config.
- **Decision**: FIXED

### F5 — Roadmap still lists S-08 as `proposed`

- **Severity**: WARNING
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: context/foundation/roadmap.md:62
- **Detail**: The slice's own detail section (lines 234-248) records the bookkeeping Phase 6 asked for — FR-032/033/034/035 met, FR-031 partly met with its reason, F-02 gaining no new constraint — so Progress row 6.9 is literally satisfied. But the index table at the top still shows `S-08 ... proposed`, while every completed sibling (S-02 through S-07, S-09, S-12) reads `done`. That table is what the next planner scans to know what has shipped.
- **Fix**: Change the S-08 Status cell from `proposed` to `done`.
- **Decision**: FIXED

### F6 — The planned changed-region overlay on the current image was not built

- **Severity**: OBSERVATION
- **Impact**: MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: src/app/(app)/projects/[id]/visual-panel.tsx:380
- **Detail**: Plan Phase 5 §3 specified: "The bounding boxes are drawn over the current image so 'where' is visible without loading the overlay." No boxes are drawn. `regions` never reach the client at all — `runSnapshots` does not select them, and `pageSnapshots.comparison` does not store them (only `changedPixels`, `comparedPixels`, `heightDelta`). "Where" reaches the reader two other ways: as text coordinates in the finding via `describeVisualChange`, and by switching to the Difference view. So FR-033's intent is met — which is why this is an observation rather than a failure — but the affordance the plan specified is absent, and given F1 the diff view is the expensive path the boxes existed to avoid.
- **Fix A (Recommended)**: Carry `regions`/`regionsCapped` into the stored `comparison` jsonb, return them from `runSnapshots`, and draw absolutely-positioned outlines over the current `Figure`.
  - Strength: Delivers the planned affordance and removes the reason to load a 200 MB overlay just to see where something moved.
  - Tradeoff: A schema shape change plus real UI work; older rows would have no regions and must render without them.
  - Confidence: MEDIUM — `regionsOf` already produces the boxes in image coordinates and `compareSnapshots` already returns them; only the transport and the rendering are missing.
  - Blind spot: Scaling the boxes from image pixels to the rendered `img` width needs care to stay correct as the column resizes.
- **Fix B**: Record the omission in the plan and HANDOFF as a deliberate cut.
  - Strength: Honest and cheap; the capability is genuinely delivered by two other paths.
  - Tradeoff: Leaves the diff view as the only visual "where", which F1 makes costly.
  - Confidence: HIGH — nothing depends on the boxes existing.
  - Blind spot: None significant.
- **Decision**: FIXED

### F7 — Two doc comments lost their cross-reference mid-sentence

- **Severity**: OBSERVATION
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/server/crawl/findings.ts:2372
- **Detail**: `findings.ts:2372` ends "...invisible to a reader. See ." and `run.ts:623` reads "Recorded even when there is no baseline:  is the fact that this run had nothing to compare with". Both read as a `{@link ...}` or filename token that was stripped, leaving a dangling sentence. In a codebase where the docblocks are the argument, a broken citation is a small hole in the reasoning a later reader is meant to follow.
- **Fix**: Restore the two references — `visual-noise.ts` / `proof.md` in `findings.ts`, and the missing subject (`baselineRunId: null`) in `run.ts`.
- **Decision**: FIXED

### F8 — Mask limits duplicated as bare literals in two files

- **Severity**: OBSERVATION
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/app/(app)/projects/[id]/visual.ts:300
- **Detail**: `visual.ts` declares `MAX_MASKS = 50` and `MAX_SELECTOR_LENGTH = 255`; `project.ts:208` independently writes `z.array(z.string().min(1).max(255)).max(50)`. The docblock argues the repetition is intentional and it is right about the *roles* — the client tells the typist what is wrong before sending, the server refuses bad input. But the *numbers* being two literals is exactly the divergence `visual-noise.ts` was created to eliminate for `MIN_CHANGED_SHARE`: raise the server cap and the client silently keeps refusing at the old one.
- **Fix**: Export the two constants from one module and import them into both the Zod schema and `parseMaskSelectors`.
- **Decision**: FIXED

## What matched

- **Phase 1** — `pageSnapshots` follows `pageObservations` in shape and reasoning; the three-state nullability is implemented and commented as load-bearing; `runsToExpire` is pure with all five planned cases tested plus three more; `expireSnapshots` updates rather than deletes and its `isNotNull(image)` predicate makes it genuinely idempotent rather than merely re-writing `expiredAt`. Signature improved on the plan by taking `{tenantId, projectId}` instead of a bare `projectId`.
- **Phase 2** — `SNAPSHOT_VIEWPORT` exported and pinned; the scroll sweep runs *after* the vitals `evaluate`, with the CLS ordering argued in place; capture failures land in `snapshotError` and nothing throws out of `measure()`; the `onCapture` sink writes per page so bytes never accumulate across the render loop.
- **Phase 3** — `pinBaseline` checks project, run *and* tenant, and refuses a run with no usable image with a readable message; cross-tenant answers NOT_FOUND, not FORBIDDEN. The watched set is read from baseline rows and capped by `sample.cap`, so a baseline pinned under a larger cap cannot raise later cost.
- **Phase 4** — `compareSnapshots` refuses on all four planned grounds plus `unreadable`; `includeAA: false` and pixelmatch's own default threshold are kept and defended; `regionsOf` is deterministic by construction with an iterative flood fill; `diffOverlay` shares the private `diff()` so overlay and count cannot disagree. `comparability()` is genuinely untouched and `visualComparability` sits beside it. 14 differ cases, all planned ones present.
- **Phase 5** — The route re-establishes tenant ownership itself and answers 404 rather than 403 throughout; `private, no-store` set. `visualState` covers every planned union member plus `predates_baseline`, which is a real distinction the plan missed. The panel does not restate the finding's sentence, and `describeVisualChange`'s docblock says so explicitly. `runSnapshots` never selects `image`.
- **Phase 6** — `proof.md` is 315 lines and records what went wrong, including that the plan's storage estimate was four to ten times low. The `MIN_CHANGED_SHARE` floor is derived from a stated measurement and carried in every finding's detail so a reader can disagree with it — exactly the discipline Phase 6 asked for.
- **Scope discipline** — Every addition beyond the plan is either plan-sanctioned (the noise floor, authorised by Phase 6), a documented refinement (`predates_baseline`, the `comparison` column, the `unreadable` reason), or recorded in `change.md` as deliberate work beyond the plan serving FR-035 (the mask control). Nothing on the "What We're NOT Doing" list was built: no similarity score, no second viewport, no stored overlay, no per-finding muting, no baseline history.
