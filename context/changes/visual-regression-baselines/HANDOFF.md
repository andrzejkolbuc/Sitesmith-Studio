# Handoff — S-08 `visual-regression-baselines`

**Written:** 2026-09-06, end of the implementation session.
**Read this first**, then `plan-brief.md`, then `proof.md`. The full plan is
`plan.md`; its `## Progress` section is the authoritative state.

---

## Where things stand in one paragraph

S-08 is **code-complete across all six phases and proven on a real client
site**. Every automated Progress row is ticked and carries its commit SHA. What
remains is **manual verification only** — 16 rows the implementing session
deliberately did not tick, because ticking a manual row is the human's call. Most
of them were in fact observed during the real-site run and are described below,
so confirming them should be quick rather than a fresh investigation.

Nothing is half-built. The working tree is clean, the whole suite is green, and
the feature works end to end against `tecalliance.net`.

---

## What to do next, in order

### 1. Confirm the manual rows (the only blocking work)

Open `plan.md`'s `## Progress` section. Sixteen `- [ ]` rows remain, all under
`#### Manual`. Below is what the implementing session actually observed for each,
so you can confirm rather than rediscover. **Do not tick these without the user
confirming** — they are the human's verification, not the agent's.

| Row | What was observed on the real run |
| --- | --- |
| 1.7 A project with no baseline reads as having none | ✅ Seen. Section reads *"No baseline is pinned, so there is nothing to compare this run against"* with a pin control. |
| 2.7 A captured PNG looks like the page, full length, masks blanked | ✅ Partly. Full-length capture confirmed (9,627px and 7,038px tall). **Masked-region blanking was not exercised on the real site** — only in the fixture test. See gap (a) below. |
| 2.8 Lazy content below the fold is in the capture | ✅ Seen; the scroll sweep is covered by a dedicated fixture route (`/lazy-below-fold`) and the capture shows the site's lazy imagery. |
| 2.9 Run-duration delta measured and acceptable | ✅ Measured: +~3s per page for capture. See `proof.md`. |
| 3.7 Pinning a baseline and re-running visits the same pages | ✅ Seen; also covered by an integration test. |
| 4.8 An unchanged page reports no visual difference | ✅ **Now true**, after the noise floor. Measured twice: zero findings. |
| 5.10 No-baseline reads as needing one, not as clean | ✅ Seen. |
| 5.11 Side by side renders, overlay marks the difference | ✅ Seen; all three views returned 200. **The overlay was only viewed on a page with sub-visible differences**, so "marks the *real* difference" is unproven. See gap (b). |
| 5.12 The section says how much of the site it describes | ✅ Seen: *"2 pages compared against the baseline of 2 pages crawled"*. |
| 5.13 Finding and panel do not print the same sentence | ✅ Seen; deliberately different wording. |
| 5.14 The rest of the project page is unchanged | ✅ Seen. |
| 6.5 Two runs of an unchanged real site report no differing pages | ✅ **Now true.** Was the headline failure; fixed by the floor. |
| 6.6 A deliberately changed page is caught, regions point at it | ❌ **Not done.** See gap (b) — this is the main outstanding verification. |
| 6.7 A masked region suppresses a difference | ❌ **Not done on a real site.** See gap (a). |
| 6.8 Duration and storage deltas recorded and acceptable | ✅ Both in `proof.md`. Storage came out 4–10× the plan's estimate — read that section. |
| 6.9 Roadmap records the requirement outcomes | ✅ Done; check `roadmap.md` under S-08 and confirm you agree with the wording. |

### 2. Close the two real verification gaps

These are the only things genuinely unproven on a real site.

**(a) Masks against a real page (rows 2.7, 6.7).** `setMasks` exists as a tRPC
procedure but **has no UI** — the panel only exposes pinning. To verify: call
`project.setMasks` directly (e.g. from a scratch script against the dev DB, or
add the control), point a selector at something on `tecalliance.net`, re-run, and
confirm the region is painted out in the stored PNG and stops reporting.
Note that changing masks makes the next comparison refuse with `masks_differ`
until a new baseline is pinned — that is by design, and worth seeing.

**(b) A deliberately changed page (row 6.6).** The unchanged-site case is proven;
the changed-site case is not, on a real page. The cheapest honest test is a local
fixture page you can edit between two runs, or a project pointed at a page you
control. Confirm the reported regions land on what you changed.

### 3. Then archive

Once the manual rows are confirmed:

- `plan.md` — tick them (with SHAs where a fix was needed).
- `change.md` — `status: implemented`.
- Commit, then `/10x-archive visual-regression-baselines`, which moves the folder
  to `context/archive/2026-09-06-visual-regression-baselines/` and flips the
  roadmap item to `done`.

---

## What was built, and the decisions behind it

Read `plan-brief.md` for the full decision table. The four that matter most:

1. **Pinning a baseline pins the render set.** Once a project has a baseline, the
   pages a run renders are the pages that baseline captured, read from rows and
   never re-derived. `chooseRenderSample` ranks by inbound links, which is stable
   only across runs of an *unchanged* site — and a visual comparison is asked its
   question precisely when the site changed.
2. **Snapshots are Postgres `bytea`**, three-state: image present / `captureError`
   set / `expiredAt` set. Retention **updates, never deletes**, so an expired
   snapshot stays distinguishable from one never taken.
3. **Masks are CSS selectors applied by Playwright at capture**, so volatile
   content never enters storage.
4. **No similarity score.** Changed-pixel counts, a share, and bounding boxes.

### FR-031 is recorded as *partly met*, deliberately

It says "a rendered snapshot of **each page** in a run". That is 1.5–2 hours per
run on a 1,200-URL site and ~2 MB per page. Snapshots are captured for a bounded
watched set instead — the same call FR-028 already got. Do not "fix" this without
re-opening the PRD decision.

### The noise floor is the newest decision

`src/server/crawl/visual-noise.ts` holds `MIN_CHANGED_SHARE = 0.0005` (0.05%),
**derived from measurement, not chosen**: two runs of an unchanged real site
differ by 0.014–0.015% of the compared area even with anti-aliasing excluded. The
floor sits at ~3× that. It is read by both the rule and the presentation module
from one place, so a findings list and a panel can never disagree about a page.
It is reported in every finding's `detail.thresholdShare`.

---

## Facts a fresh session will want

- **Commits, in order:** `0bce206` (p1 schema/retention), `59927ff` (p2 capture),
  `e8708ac` (p3 pinning), `c0ac500` (p4 comparison), `df876c6` (p5 UI),
  `568017c` (p6 proof), `0d4aa43` (SHA write-back), plus the noise-floor commit
  that follows this handoff.
- **Test counts to expect:** 727 unit, 87 integration, 17 e2e.
- **Schema changes go through `npm run db:push`.** There is no `drizzle/`
  migrations directory. If `db:push` warns about data loss on a NOT NULL column,
  it needs a database-level `.default()`, not `$defaultFn` — that bit us once.
- **Running e2e requires no other dev server in this directory.** Next 16 refuses
  a second one *per directory*, regardless of port, so stop any preview server
  first (`preview_stop`) or `npm run test:e2e` fails before it starts.
- **The e2e run budget is `RUN_TIMEOUT_MS = 180_000`** in `e2e/fixtures.ts`,
  raised from 60s because capture genuinely made runs slower. It is the render
  cap's own ceiling, not a number raised until things passed.
- **`crawler.test.ts` is timing-sensitive on this machine.** One full-suite run
  showed 30 spurious failures that vanished on re-run and in isolation. It is
  pre-existing and unrelated to S-08 — but if you see it, re-run before
  investigating.
- **The real-site project** is Tecalliance, id
  `a03c07cc-0f5b-499a-a7bc-fd5c9fff43df`, scoped to `/` and `/company`, with a
  baseline currently pinned to run `22d72d70-147e-4341-a109-6b6b8ee79db6`.

## Two known gaps that are not bugs

- **`setMasks` has no UI.** The procedure and the capture-time masking both work
  and are tested; nothing on the project page calls it. FR-035 is recorded as met
  on the strength of the mechanism, which is defensible but worth a second
  opinion before archiving.
- **Storage is ~960 MB at full scale**, not the "tens to low hundreds of
  megabytes" the plan estimated. Bounded and affordable, but F-02 should size a
  host from the measured figure in `proof.md`.

## What comes after S-08

`roadmap.md` has S-10 (`roles-invites-and-client-access`) and S-13
(`scheduled-and-staging-runs`, blocked on Open Question 8 — which host) as the
next unblocked slices. There is also an unbuilt follow-on that trends the Core
Web Vitals S-06 records, which is the remaining half of FR-039.
