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
| 2.7 A captured PNG looks like the page, full length, masks blanked | ✅ **Now whole.** Full-length capture confirmed (9,627px and 7,038px tall); masked-region blanking then read by hand in the stored pictures of both a local fixture page and `tecalliance.net`. |
| 2.8 Lazy content below the fold is in the capture | ✅ Seen; the scroll sweep is covered by a dedicated fixture route (`/lazy-below-fold`) and the capture shows the site's lazy imagery. |
| 2.9 Run-duration delta measured and acceptable | ✅ Measured: +~3s per page for capture. See `proof.md`. |
| 3.7 Pinning a baseline and re-running visits the same pages | ✅ Seen; also covered by an integration test. |
| 4.8 An unchanged page reports no visual difference | ✅ **Now true**, after the noise floor. Measured twice: zero findings. |
| 5.10 No-baseline reads as needing one, not as clean | ✅ Seen. |
| 5.11 Side by side renders, overlay marks the difference | ✅ **Now whole.** Seen against a change we made on purpose: the overlay paints the rewritten block solid red and leaves the rest of the page dimmed. |
| 5.12 The section says how much of the site it describes | ✅ Seen: *"2 pages compared against the baseline of 2 pages crawled"*. |
| 5.13 Finding and panel do not print the same sentence | ⚠ **Was true only because the finding printed no sentence at all** — raw JSON. Fixed this session; now the section gives the share and the finding gives the count, regions and length change. |
| 5.14 The rest of the project page is unchanged | ✅ Seen. |
| 6.5 Two runs of an unchanged real site report no differing pages | ✅ **Now true.** Was the headline failure; fixed by the floor. |
| 6.6 A deliberately changed page is caught, regions point at it | ✅ **Done.** Two changes on a fixture site. The height-neutral one reported one region, `832 × 336 at 224, 624`, which is the changed banner exactly. See `proof.md`, second half. |
| 6.7 A masked region suppresses a difference | ✅ **Done.** The same banner change that reported 256,077 differing pixels unmasked reported nothing once masked; the region is painted out in storage. Repeated on `tecalliance.net` with `header`. |
| 6.8 Duration and storage deltas recorded and acceptable | ✅ Both in `proof.md`. Storage came out 4–10× the plan's estimate — read that section. |
| 6.9 Roadmap records the requirement outcomes | ✅ Done; check `roadmap.md` under S-08 and confirm you agree with the wording. |

### 2. The two verification gaps are closed

Both were closed on 2026-09-06 in a second session; `proof.md` carries the
measurements under **"The other half of the proof"**. In short:

- **A deliberately changed page** was checked on a two-page fixture site served
  from disk, edited between runs. A height-neutral change reported **one region,
  `832 × 336 at 224, 624`** — the changed banner exactly. A reflowing change
  reported eight, which is correct and now explained in the finding by a
  "32px shorter than the baseline" line.
- **Masks** were set through `project.setMasks` on both the fixture and a fresh
  `tecalliance.net` project. The refusal (`masks_differ`) was seen, the re-pin
  was seen, the suppression was seen — the same change that reported 256,077
  pixels unmasked reported nothing masked — and the masked block is painted out
  in the stored pictures on both sites.

That reading found two defects, both fixed in the commit that follows this
handoff:

1. **`visual_changed` rendered as raw JSON** in the findings list. It had a
   label but no case in the evidence switch, so it hit the default branch. Now
   `describeVisualChange` in `visual.ts`, with unit tests.
2. **A baseline could be pinned exactly once.** The pin control renders only in
   the `no_baseline` state, so a project that had one could never move it — and
   masks were unusable, because editing them refuses every comparison until a
   run is pinned under the new list. The compared state now offers **"Make this
   run the new baseline"**.

**The mask control was then built**, on the user's call: **Masked regions**,
collapsed under the appearance section, one CSS selector per line, parsed by
`parseMaskSelectors` in `visual.ts` against the procedure's own limits. Verified
by hand end to end — saved through the interface, and the final run proved the
property nothing had checked before it: with `#volatile` masked, two blocks were
changed at once and the finding named **only the unmasked one**, one region,
`832 × 176 at 224, 192`. A mask silences its own region without blinding the
rest of the page.

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
- **Test counts to expect:** 745 unit, 87 integration, 17 e2e.
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

## One known gap that is not a bug

- **~~`setMasks` has no UI.~~** Built 2026-09-06. FR-035 is now met through the
  interface rather than on the strength of the mechanism.
- **Storage is ~960 MB at full scale**, not the "tens to low hundreds of
  megabytes" the plan estimated. Bounded and affordable, but F-02 should size a
  host from the measured figure in `proof.md`.

## What comes after S-08

`roadmap.md` has S-10 (`roles-invites-and-client-access`) and S-13
(`scheduled-and-staging-runs`, blocked on Open Question 8 — which host) as the
next unblocked slices. There is also an unbuilt follow-on that trends the Core
Web Vitals S-06 records, which is the remaining half of FR-039.
