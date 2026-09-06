# Browser-Observed Checks — Plan Brief

> Full plan: `context/changes/browser-observed-checks/plan.md`
> Research: `context/changes/browser-observed-checks/research.md`

## What & Why

Roadmap slice **S-06**. Two capabilities under one heading: what a page's images
cost, and what a page does when a browser actually runs it — console errors and
Core Web Vitals. It is the last unbuilt piece of the product's checking work, it
unblocks S-08 (visual regression), and it is the named prerequisite for the half
of FR-039 that S-12 had to leave open.

## Starting Point

The crawl parses every page's HTML and keeps a fixed-size summary of it, but
extracts anchors only — no images at all. Nothing renders anything: there is no
browser in the runtime, and Playwright exists solely as a devDependency for the
e2e suite. `external.ts` already established how to make many extra requests
after a crawl without wrecking anything, and that pattern is reused wholesale.

## Desired End State

Every page in a run carries what its images cost and which of them are missing
dimensions or served in a legacy format. A small, named sample of pages also
carries what a browser saw: console errors, TTFB, LCP and CLS. The run panel
shows both and states plainly which pages were measured — an unmeasured page
reads as not measured, never as a fast one.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Slice shape | Image half first (no browser), render half second | The image answers are already in HTML we fetch and throw away; only the render half costs a dependency and a duration multiple | Research |
| The sample | Entry page + most-linked pages per **declared** locale, hard cap | Any *templates × locales* formula multiplies — measured at **143 renders** on yazaki; declared locales are operator-controlled, discovered ones are not | Research |
| "Page template" | Not claimed at all | A multilingual site translates its URL segments — yazaki shows 113 sections for ~10 real ones — so template coverage is unobservable | Research |
| Ranking signal | Inbound link count | The site's own navigation saying which pages matter, per `lessons.md` rule 1 — not our guess about importance | Plan |
| Lighthouse? | No. Vitals plus Google's published bands, cited as Google's | A 0-100 composite is an index we assert; S-12 refused to invent a score for the same reason. **FR-028 partly met** | Plan |
| Console errors on every page? | No — the rendered sample only | Rendering every page is the cost the PRD already rejected under FR-028. **FR-015 partly met** | Plan |
| Third-party console errors | Counted, shown, but never a finding | A widget breaking itself is on the client's page but is not the client's defect | Plan |
| Slow-page finding? | None — vitals are displayed, not detected | A threshold on LCP is a verdict; the measurement is an observation | Plan |
| Where rendering runs | In-process, hard per-render timeout | Matches `run.ts`'s existing trade; a hung render is bounded like a hung request | Plan |
| Per-project toggle | Not built | No project edit UI exists — a switch nobody can flip is a half-feature; the cap is the cost control | Plan |
| Storage for observations | A `page_observation` table, not columns on `pages` | Only sampled pages have rows, so absence *is* "not measured" | Plan |

## Scope

**In scope:** image weight, missing dimensions and legacy formats for every page;
console errors and Core Web Vitals for a capped sample; a performance section that
states its own coverage; four new finding types; the real-site proof.

**Out of scope:** Lighthouse and any composite score; a slow-page finding;
screenshots (S-08); INP; a per-project rendering toggle; F-02's container shape.

## Architecture / Approach

Two passes after the crawl, both on the `external.ts` model — sharing the crawl's
pacer, carrying their own budget, and reporting `complete` so the rules go silent
rather than guessing when a pass was cut short. The image sweep asks each distinct
image URL its size over HEAD. The render pass launches one browser, renders the
sampled pages, and stores one observation row per measured page. The sample is a
pure function built and fixed **before** the browser exists, because which pages
get measured is the decision that bounds everything the slice claims.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Image markup | Per-page image summary; missing-dimensions and legacy-format findings | Regex extraction missing `picture`/`srcset` shapes |
| 2. Image weight | Bounded HEAD sweep; oversized finding with its threshold shown | Request count growing out of proportion on image-heavy sites |
| 3. The sample | Pure selection function and its cap, no browser | Choosing a rule that reads well but starves a locale |
| 4. The render | Playwright at runtime; console errors and vitals stored | Run duration; a hung or crashing render taking the run with it |
| 5. The view | Performance section and four finding renderers | Implying the whole site was measured |
| 6. Proof | Real project measured, requirements recorded honestly | Vitals disagreeing with devtools |

**Prerequisites:** S-01 (`built`). No client access needed until Phase 1's manual
check; Phase 6 needs one real project.
**Estimated effort:** ~4-6 sessions across 6 phases; Phase 4 is the largest.

## Open Risks & Assumptions

- **Playwright becomes a runtime dependency**, so any container must ship Chromium
  and its system libraries. **F-02 is unbuilt**, so this slice constrains a
  foundation nobody has planned yet. Phase 6 records the constraint where F-02's
  planner will find it.
- **Run duration is the design constraint, not a footnote.** The bound is the cap
  multiplied by the per-render timeout. It is stateable in advance, but there is
  no run-duration *target* to test against — the PRD declined every numeric
  threshold, and shape-notes Open Question 6 asks whether full-scope run time is
  compatible with a go-live gate at all. This slice makes that question real.
- **Four new finding types change `runs.ruleSet`**, so the first comparison
  spanning this deployment will refuse with `rules_changed`. That is S-12's guard
  working; Phase 6 confirms it on real data rather than assuming it.
- **Vitals from a single synthetic load are not field data.** They are what one
  browser saw once, from wherever the run executes — worth saying in the section
  rather than implying otherwise.

## Success Criteria (Summary)

- A run reports image problems traceable to the site's own markup and headers, and
  a reader can check any of them by hand.
- A sampled page's vitals match what that page's devtools report, and an unsampled
  page reads as not measured rather than as having no problems.
- The run still finishes in a time the operator would accept, and the delta is
  recorded rather than assumed.
