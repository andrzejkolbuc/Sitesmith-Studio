---
change_id: cross-variant-content-drift
title: "Cross-variant content drift"
status: impl_reviewed
created: 2026-08-31
updated: 2026-09-01
archived_at: null
roadmap_ref: S-03
prd_refs: [FR-027]
---

## Notes

Roadmap item **S-03**, unblocked on 2026-08-31 when PRD Open Question 3 was
answered. It sat blocked deliberately: the PRD kept FR-027 as must-have with the
noise objection raised and unresolved, and the roadmap's own risk note says
planning it before deciding what drift means would produce a check nobody
trusts.

The answer is not a threshold but a **decomposition**. FR-027 bundles three
signals whose false-positive rates differ by orders of magnitude, and bundling
them means the worst one decides whether the other two are believed. So: three
independent rules, shipped in ascending order of noise.

1. **Untranslated placeholder text** — `lorem ipsum`, `TODO`, unrendered
   interpolation markers, or a variant whose body is substantially identical to
   its sibling's. A site never means to publish these. Near-zero false
   positives; trustworthy on day one.
2. **Missing sections** — compared *structurally* (heading counts and depth,
   presence of a form, table, or media block), never as prose. Structure is a
   translation-invariant the way word count is not.
3. **Word count** — last, and only at the extreme: a member far below its
   family's median, where the honest reading is "most of this page is absent"
   rather than "German runs longer than English". Requires a family of three or
   more so that one short sibling cannot define the baseline.

Rule 3 is the one the PRD warned about, and it is deliberately the one that can
be dropped without touching the other two.

The prerequisite S-02 is done, and the crawl already stores what rules 1 and 2
need to read — but confirm that before planning: the crawler currently extracts
hreflang and links from the HTML and does not obviously retain the body text.
If it does not, capturing page content is part of this slice's cost and NFR-1
(never degrade the client's site) constrains how it is captured.

Carry forward the lesson from `context/foundation/lessons.md` — trace every
finding to the site's own assertion — and the two-member guard that fixed
detection rules 1 and 6. Open Question 2 still stands: there is no mechanism for
suppressing a known-acceptable finding, so signal quality has to come entirely
from conservative detection.

## Adaptation during phase 2

The plan's phase 2 contract says the sibling condition is "reported once per
page, naming the sibling it matches". Implemented literally, an identical pair
fires from both sides — two findings for one problem, and three on a family
where German and French were both copied from English. That is the double-report
class rule 6 exists to collapse, and the one this project has now corrected four
times.

Adapted, with the user's agreement, to **one finding per identical set**. The
type keeps a `kind` discriminator in its detail, following the pattern rule 5
already uses for its defects:

- `placeholder_markers` — per page (`url` set). A marker is a fact about one
  page, needs no family, and needs no `crawlComplete` guard: the evidence is on
  the page in front of us.
- `identical_to_siblings` — per set (`url: null`). Names every URL sharing that
  content, so a three-way copy reports once.

A second correction came out of mutation testing rather than review. The guard
was first written as "two locale tags", which reports `en` beside `en-gb`
serving one body — a British page carrying the generic English text has not
failed to be translated, because no second language was ever involved. It now
compares primary language subtags, the same way `satisfies` treats a regional
refinement as answering for its language.

## Phase 4 results — yazaki-emea.com, 2026-09-01

Run `af97d198`, same project and pacing as the two runs of 2026-08-31: two
requests at a time, 500ms apart.

| | 2026-08-31 | 2026-09-01 |
|---|---|---|
| Pages | 533 | 533 |
| `variant_diverged` | 8 | 9 |
| `content_untranslated` | — | **0** |
| `content_structure_differs` | — | **0** |
| Duration | 305s | 412s |

**Both new rules were completely silent, and the silence is genuine rather than
blindness.** A 14-page sample re-fetched from the live site shows the extractor
had full visibility:

- `<main>` found on **14 of 14** pages — rule 8 could see every page it was
  offered.
- Every page cleared the comparable-length floor, 1,276–5,830 characters — rule
  7 could compare every page.
- **51 families of two or more members, covering 510 of 533 pages.**

So rule 8 compared 51 families and found no block-type disagreement; rule 7
compared 510 digested pages and found no two sharing content. Yazaki translates
its content properly and renders it from a consistent template, and both rules
agreed.

That is the evidence the PRD's noise objection needed: **zero false positives
across 510 pages in 51 families**, on a site nobody designed for these rules. It
is not evidence the rules find anything — no true positive has been observed in
the wild — and that distinction should not be blurred when S-03 is judged.

### A pre-existing defect this surfaced

The ninth `variant_diverged` is new since yesterday and answers **200** on five
consecutive fetches. The crawl recorded **502** for it; both earlier runs
recorded 200.

`/news-press/one-team-many-languages-mother-language-day` was therefore reported
on the strength of one unlucky request. The finding is a true observation at
crawl time and a false statement about the site — a client opening the URL sees
a working page and concludes the tool is wrong.

This is the lessons.md failure mode again — a finding resting on how we
collected the data rather than on something the site asserts — in an existing
rule rather than either new one. Out of scope for S-03; recorded here because it
was found here.
