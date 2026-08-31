---
change_id: cross-variant-content-drift
title: "Cross-variant content drift"
status: preparing
created: 2026-08-31
updated: 2026-08-31
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
