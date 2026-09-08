# Real-site proof — visual regression with baselines

The slice run against a real client project, read by hand, on 2026-09-06.

## The project

**Tecalliance** — `https://www.tecalliance.net/`, scoped to `/` and `/company`,
declared locale `en`. Two pages. The same project S-06 and S-12 used, for the
same reason: it is the cheapest real target the account has.

Project id `a03c07cc-0f5b-499a-a7bc-fd5c9fff43df`.

## The question this slice had to answer

Not "does it catch a changed page" — a pixel comparison catches changed pixels by
construction. The question the plan named as the headline is the other one:

> **Does an unchanged site compare clean?**

If our own rendering moves between two runs of a site nobody deployed to, then
every number this slice reports is ours rather than the client's, and the whole
check is an elaborate way of measuring our own browser.

**It does not compare perfectly clean.** The measurement is below.

## Run duration — what capture costs

| | Pages | Renders | Snapshots | Duration |
| --- | --- | --- | --- | --- |
| Before S-06 (`d7fe42fb`, 5 Sep 16:31) | 2 | — | — | **7.0s** |
| S-06, render only (`17e80165`, 6 Sep 07:17) | 2 | 2 | — | **18.6s** |
| This slice, first capture (`22d72d70`) | 2 | 2 | 2 | **24.6s** |
| This slice, capture + compare (`4b961c93`) | 2 | 2 | 2 | **17.4s** |

**Capture costs roughly 3 seconds per page** — the scroll sweep plus a full-page
encode — on top of S-06's 4–6s per render. The comparison itself is free enough
to disappear into the noise: the fourth run did strictly more work than the third
and finished faster, because the site's own response time moved more than our
added work did.

At the cap of twelve that is a bounded **+36s** per run, on top of S-06's bounded
+60s. Both are stateable in advance, which is the property the absolute cap
exists to preserve.

## Storage — the number the PRD worried about

The plan estimated 500KB–2MB per page and "tens to low hundreds of megabytes"
across ten projects. **The estimate was low.**

| Page | Full-page height | PNG |
| --- | --- | --- |
| `/` | 9,627px | **2.17 MB** |
| `/company` | 7,038px | **1.64 MB** |

A modern marketing page at 1280px wide is eight to ten thousand pixels tall, and
a full-page PNG of one is around **2 MB**. Recomputing the footprint with the
measured figure rather than the estimate:

> 12 watched pages × ~2 MB × 4 retained sets (baseline + 3 runs) × 10 projects
> ≈ **960 MB**

Close to a gigabyte, not "tens to low hundreds of megabytes". That is still a
bounded and affordable number — it is one disk, not a hosting bill — but it is
**four to ten times** what the plan assumed, and anyone sizing a host from this
slice should use the measured figure. The PRD was right to call snapshots the
line item most likely to force a bill; the retention rule is what keeps it at
960 MB instead of unbounded.

Measured on this project: 4 snapshot rows, **7.3 MiB** held, 0 expired (the
project has only two runs with pictures, which is inside the window of three).

## Does an unchanged site compare clean? — the measurement

Baseline `22d72d70` pinned at 19:00:51. Run `4b961c93` at 19:01, with **nothing
deployed to the site in between**. Recorded comparison:

| Page | Changed pixels | Of | Share | Largest region |
| --- | --- | --- | --- | --- |
| `/` | **1,831** | 12,322,560 | 0.0149% | 48×16 px |
| `/company` | **10** | 9,008,640 | 0.0001% | 48×48 px |

Both produced a `visual_changed` finding. **On a site nobody touched, the run
reported two changed pages.**

Read by hand, side by side and through the difference overlay: **the pages are
indistinguishable.** The overlay renders the dimmed page with changed pixels in
red, and at any scale a person would look at, there is nothing to see — 1,831
scattered pixels across a 9,627px page, in regions no larger than 48×48.

So the honest reading is two-sided:

- **The measurement is trustworthy.** `includeAA: false` removed the great bulk
  of renderer noise; what survives is four ten-thousandths of one percent on the
  quieter page. The comparison is not measuring our browser.
- **The finding is not.** Firing on 10 changed pixels is a false positive, and
  the PRD names no-false-positive-fatigue as a guardrail with masks as its only
  surviving defence. A check that reports two problems every time an untouched
  site is checked is the shape of thing people stop reading.

**This is the measurement the plan deferred the floor decision to**, and it was
taken from it rather than guessed: *"any floor is then derived from that
measurement and stated, never guessed in advance."*

### The floor, and the same site re-measured

`MIN_CHANGED_SHARE = 0.0005` — **0.05% of the compared area**, roughly three
times the observed noise ceiling, carried in every finding's detail as
`thresholdShare` so a reader can disagree with it. One number, in
`src/server/crawl/visual-noise.ts`, read by both the rule that decides whether to
report a page and the section that decides whether to say a page differs —
because a findings list and a panel contradicting each other about one page reads
as a bug in the product.

Run `820c901c`, again with nothing deployed in between:

| Page | Changed pixels | Share | Reported |
| --- | --- | --- | --- |
| `/` | **1,742** | 0.0141% | no |
| `/company` | **8** | 0.0001% | no |

**Zero visual findings.** Both rows read *"matches the baseline"*, and the
Problems section is back to the one image finding the site genuinely has.

The second measurement is also the useful one: 1,742 against the first run's
1,831, and 8 against 10. **The noise is stable at around 0.014–0.015%**, not a
number that happened to be small once — which is what makes a floor at 0.05%
defensible rather than lucky.

What it costs is stated in `visual-noise.ts` and worth repeating: on a very tall
page 0.05% is several thousand pixels, so a small genuine change can fall under
it. That is the direction of error this product prefers — silence about a small
real change, never a confident report of a change that did not happen.

## What worked, read by hand

- **Capture.** Both pages photographed full-length at the pinned 1280px viewport.
  The scroll sweep did its job: the pages' lazily-loaded imagery is present in
  the pictures rather than absent.
- **The no-baseline state.** Before pinning, the section read *"No baseline is
  pinned, so there is nothing to compare this run against"* with a pin control —
  an instruction, not a verdict, and never "no problems found".
- **The predates-baseline state.** Immediately after pinning, the run that had
  just been pinned read *"This run happened before the current baseline was
  pinned, so it was not compared against anything. The next check will be."* This
  is the bug the e2e journey caught during Phase 5: a run records what was true
  when it closed, so pinning afterwards does not retroactively compare it, and
  the panel had been re-asking the reader to pin what they had just pinned.
- **Coverage.** *"2 pages compared against the baseline of 2 pages crawled"* —
  the sentence carries its own denominator, as the performance section's does.
- **Review.** Baseline and current render side by side from
  `/api/snapshots/[id]`, and the difference overlay is generated on demand rather
  than stored. All three views answered 200.
- **The rule-set refusal.** The trend still reads *"Only checks run under the
  same settings appear here"*, and the first comparison across this slice's
  deployment behaved as `lessons.md` rule 4 requires.

## Recorded honestly

Written into `context/foundation/roadmap.md` under S-08:

- **FR-032, FR-033, FR-034, FR-035 — met.**
- **FR-031 — partly met.** Snapshots are captured for a bounded watched set
  rather than for each page in a run. Per-page capture is 1.5–2 hours on a
  1,200-URL site at the rate measured here, which is the cost the PRD already
  rejected under FR-028, and ~2 MB per page makes it the storage line item the
  PRD flagged during shaping.
- **F-02 gained no new constraint.** `pixelmatch` and `pngjs` are pure
  JavaScript, so the container still needs only the Chromium S-06 already forced
  on it.

## Verdict

The slice does what it was built to do: it photographs a named set of pages and
says so, it compares them against a reference the user chose, it shows the
difference rather than asserting a grade, and it refuses every comparison whose
difference would have been ours. The duration and storage costs are real,
bounded, and now measured rather than assumed — and the storage figure is
materially larger than the plan estimated.

And after the floor, it stays quiet on a site that has not changed — measured
twice, on the same real project, with nothing deployed in between.

---

# The other half of the proof — a page we changed on purpose

Added 2026-09-06, later the same evening, closing the two gaps the handoff named
as genuinely unproven: **a deliberately changed page**, and **masks against a
real page**.

## Why a fixture site, and not the client's

The unchanged-site question needed a site nobody controls, and got one. The
changed-site question needs the opposite — a page we can edit between two runs
and know exactly what we edited — so this half was measured against a two-page
site served from disk on `127.0.0.1:4318`, with the same crawl, the same render
pass and the same comparison. Masks were then confirmed a second time on
`tecalliance.net`, where the markup is somebody else's.

Project `c6491800-c096-4a5b-a67d-0610f042d758` ("S-08 fixture (local)"), two
pages, `en`.

## A change we made, found and located

Baseline pinned on the site as it stood. One block on the home page was then
rewritten — new copy, new background colour — and the page re-checked.

| | Reported |
| --- | --- |
| `/` | **209,286 of 2,595,840 compared pixels differ, in 8 regions** — 8.1% |
| `/about.html` | matches the baseline |

The overlay marks the rewritten block solid red, and the largest region,
`832 × 176 at 224, 192`, is that block's own rectangle. The finding also read
*"The page is 32px shorter than the baseline"*, which is the honest explanation
for the seven smaller regions below it: the edit reflowed the page, so every
paragraph under it moved. **A pixel comparison cannot tell a moved paragraph
from a rewritten one**, and saying the page's length changed is what makes that
legible instead of alarming.

The second change was height-neutral — a 320px banner, recoloured and
relabelled — and it produced the cleanest possible answer:

> **256,077 of 2,595,840 compared pixels differ, in 1 region**
> `832 × 336 at 224, 624`

One region, and it is the banner. That is FR-033 answered as written: not that
the page changed, but where.

## Masks, on both sites

The banner above is exactly the kind of block a client would call volatile, so
it was masked — `project.setMasks(["#volatile"])`, called as the signed-in user
against the running app.

1. **The next run refused rather than reported.** Both pages read *"was
   photographed under different masks than the baseline"*, the coverage sentence
   read *"0 pages compared against the baseline of 2 pages crawled; 2 could not
   be compared"*, and no finding was raised. Our mask list changing is a fact
   about us, and `lessons.md` rule 4 says a fact about us is not a finding.
2. **After re-pinning under the new mask list**, the banner was changed a third
   time — a different colour and a longer label, the same class of change that
   had just reported 256,077 differing pixels. **Both pages read "matches the
   baseline", and nothing was reported.**
3. **The picture proves why.** Side by side, the masked block is painted out in
   both the baseline and the current capture. The volatile content never entered
   storage, which is the property the design chose masks-at-capture for.

Repeated on `tecalliance.net` with `header` as the selector, on a fresh project
scoped to `/` and `/company`: the real site's header is painted out in both
stored pictures, the rest of the page renders in full, and both pages compare
clean. A selector written against somebody else's markup does what it does
against ours.

## Two defects this reading found

Neither was visible from the test suite, and both are what reading by hand is
for.

**1. The finding printed raw JSON at the reader.** `visual_changed` had a label
in `finding-labels.ts` — which is what Phase 5's automated check verified — but
no case in the findings list's evidence switch, so it fell through to the
default branch and rendered its detail object:

> `{"url":"http://127.0.0.1:4318/","regions":[{"x":224,"y":192,"width":832,…`

It never showed during the first real-site session because the noise floor had
by then removed every visual finding that site produced. Fixed by
`describeVisualChange` in `visual.ts`, tested there, and deliberately worded to
say something the appearance section does not: the section gives the share, the
finding gives the count, its denominator, the regions and the length change.

**2. A baseline could be pinned exactly once.** The pin control renders only in
the `no_baseline` state, so once a project had a baseline there was no way to
move it. Every intended redesign would have reported forever, and **masks were
unusable** — editing them refuses every later comparison until a run is pinned
under the new list, which the interface offered no way to do. Fixed by offering
"Make this run the new baseline" on a compared run, worded as a replacement.

## Still not built: a mask control

`project.setMasks` is reachable only through the API. Everything above called it
by hand. The mechanism is proven on two sites, but **a reader cannot mask
anything from the interface**, which is worth weighing against FR-035's wording
before this slice is called done.

## The mask control, built and read by hand

The gap above was closed rather than recorded. `project.setMasks` now has an
interface: **Masked regions**, collapsed under the appearance section, one CSS
selector per line.

One selector per line and never comma-separated, because a comma is part of CSS
— `h1, h2` is a single selector list, and splitting on it would quietly mask two
things where the reader wrote one. `parseMaskSelectors` in `visual.ts` does the
trimming, the de-duplication and both of the procedure's limits, so a reader
hears what is wrong before the round trip rather than from a rejected request.

Read by hand on the fixture project: the box opens pre-filled with the project's
current list, Save is inert until the list actually changes, saving writes
through `setMasks` and the count in the header follows. Adding a selector and
removing it again round-tripped correctly through the database.

The last measurement is the one that matters, and it is the property nothing had
checked until now — **a mask silences its own region without blinding the rest
of the page.** With `#volatile` masked, two blocks were changed at once: the
masked banner, and an unmasked block above it.

> **127,554 of 2,595,840 compared pixels differ, in 1 region**
> `832 × 176 at 224, 192`

One region, and it is the unmasked block. The masked banner changed colour and
label in the same edit and is not in the finding, not in the count, and not in
the picture. That is FR-035 as written: volatile regions stop reporting, and
nothing else stops reporting with them.
