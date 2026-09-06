# Real-site proof — browser-observed checks

The slice run against a real client project, read by hand, on 2026-09-05/06.

## The project

**Tecalliance** — `https://www.tecalliance.net/`, scoped to `/` and `/company`,
declared locale `en`. Two pages. The same project S-12's proof used, and for the
same reason: it is the cheapest real target the account has.

Project id `a03c07cc-0f5b-499a-a7bc-fd5c9fff43df`.

## Run duration — the question the roadmap asked

The roadmap's open unknown for S-06 was whether adding page rendering breaks the
run-duration property S-01 measured. Measured on this project:

| | Pages | Renders | Duration |
| --- | --- | --- | --- |
| Before this slice (`d7fe42fb`, 5 Sep 16:31) | 2 | — | **7s** |
| After (`7c567a20`, 5 Sep 22:07) | 2 | 2 | **15.7s** |
| After (`17e80165`, 6 Sep 07:17) | 2 | 2 | **18.6s** |

**About 4–6 seconds per rendered page**, which is the low end of the 5–15s the
research predicted. On this project that is a ratio of roughly 2.2x, because the
crawl itself is only seven seconds; on a site where the crawl dominates — yazaki
crawls 533 pages in ~320s — twelve renders at this rate is roughly +60s, or under
20%.

**The answer to the unknown: rendering is affordable at an absolute cap and only
at an absolute cap.** The naive sample rule the research measured (one page per
URL section per discovered locale) came to 143 renders on yazaki, which at the
rate observed here would be 10–14 minutes on top of a 5-minute crawl. The cap of
twelve is what keeps this a bounded cost an operator can be told in advance.

## What the browser measured

From `17e80165`, both pages of the sample, `renderSummary`
`{chosen: 2, measured: 2, cap: 12, complete: true}`:

| Page | TTFB | LCP | CLS | First-party errors | Third-party |
| --- | --- | --- | --- | --- | --- |
| `/` | 3133ms | 3440ms | 0.0065 | 0 | 0 |
| `/company` | 297ms | 704ms | 0.0062 | 0 | 0 |

Rendered as: `/` — 3.1s / 3.4s / 0.007, `/company` — 297ms / 704ms / 0.006, with
the homepage's TTFB and LCP coloured against Google's published thresholds and
the rest quiet.

**Are these attributable to the site?** Yes, and they are the browser's own
numbers rather than ours — read from its `PerformanceObserver` and its navigation
timing, so anyone can open devtools on the same page and check them. The homepage
being an order of magnitude slower than `/company` is stable across both runs
(3005/3400 then 3133/3440), which is what a real property of the page looks like
rather than measurement noise.

**No composite score is reported**, and that is deliberate: FR-028 asks for
"standard page performance scores", and a 0–100 grade would be an index this
product asserts. The measurements are the site's behaviour; a grade is our
opinion of it. See "Recorded honestly" below.

## What the images turned out to be

`17e80165` produced three findings: `image_missing_dimensions` on both pages and
`metadata_missing` on `/company`.

The image finding on `/company` reads:

> **39 of 57 images declare no width and height, so the page moves as they load**

Checked by hand against the page: the URLs cited are a CMS's transform pipeline
(`/f/297549/1200x896/…/m/filters:quality(80)`), served as `.webp` and `.png`, and
they genuinely carry no `width`/`height` attributes. **Attributable to the site**
— it is their markup, and the finding cites the exact files.

**No `image_oversized` and no `image_legacy_format` fired**, which is the correct
answer for this site rather than a gap: it serves `.webp` throughout and its
transform pipeline keeps the files small. The rules being quiet on a site that
has done the work is the property that matters.

**No `console_error` fired** on either page — neither page's own scripts failed
during load, and no third-party script did either.

## The comparison guard, exercised for real

This slice adds four finding types, taking `runs.ruleSet` from **24 to 28**. The
first comparison spanning the deployment refused, exactly as S-12's Phase 2
intended, and the trend said so in the reader's words:

> **Not compared — our checks changed**
> We added or changed checks between these two runs, so the two runs were not
> looking for the same things. There is nothing to fix on your side — the next
> run will have a matching baseline.

This is the first time that clause has fired outside a fixture. Without it, the
39-image finding and its partner would have been reported as **new problems that
appeared on the client's site**, on the day we started checking for them.

The following run then compared normally — two 28-rule runs are on the same
footing — and the trend now plots them as a two-column grid with flat rows. The
guard refused once, across the change, and resumed. That is the whole design.

## Three things reading it by hand changed

1. **`page.evaluate` given a string evaluates it as an expression.** A string
   beginning `() =>` therefore produced the function and never called it, so
   every vitals reading arrived `undefined`. Caught by the render integration
   test, not by review.
2. **A render cap of zero still rendered one page.** The entry page was taken
   unconditionally, before the cap was consulted — turning "render nothing" into
   "render one page", and a run that renders when told not to is a run whose cost
   nobody agreed to.
3. **The image sentence read wrong on a real page**: *"39 images declare no width
   and height, so the page moves as they load of 57 on the page"*. The proportion
   was appended after the clause instead of sitting with the count. Only visible
   with a real number in it.

A fourth, found in the same reading: the trend's explanation and the comparison's
refusal printed **the same paragraph twice, one directly above the other**. Both
drew on `REASON_SENTENCE`, which was right about the vocabulary and wrong about
the repetition — two sections agreeing verbatim reads as a bug in the page. The
trend now names the reason and leaves the explanation to the refusal that is
already on screen giving it.

## Recorded honestly

Written into `context/foundation/roadmap.md` under S-06:

- **FR-029 — met.** Image weight, missing dimensions and legacy formats, for
  every page, from the site's own markup and headers.
- **FR-015 — partly met.** Console errors are captured for the rendered sample
  only. As written the requirement says *each page*, and rendering every page is
  the cost the PRD already rejected under FR-028.
- **FR-028 — partly met.** Core Web Vitals are delivered; the "standard page
  performance scores" clause is not, and deliberately so.
- **FR-039's scores half is now deliverable**, which was S-12's stated blocker.
  It is not delivered here — S-12 is archived — and wants a follow-on that trends
  the vitals this slice began recording.
- **F-02 now has a constraint it did not have when it was proposed**: any
  container must ship Chromium and its system libraries, because `playwright` is
  a runtime dependency from this slice onward.

## Verdict

The product measures a named sample of pages and says so; it reports image
problems traceable to the client's own markup; it stays quiet where the site has
done the work; and it refused the one comparison it should have refused. The
duration cost is real, bounded, and now measured rather than assumed.
