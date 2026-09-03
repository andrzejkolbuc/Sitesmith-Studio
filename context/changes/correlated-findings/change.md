---
change_id: correlated-findings
title: "One explained problem per underlying cause, instead of many symptoms"
status: new
created: 2026-09-03
updated: 2026-09-03
archived_at: null
---

## Notes

Roadmap item **S-09**, unblocked on 2026-09-03 when S-04 closed. Its three
prerequisites — S-02, S-04, S-05 — are all done, so twenty-four finding types now
exist to correlate. FR-040 and US-01.

The roadmap's own risk note sets the bar: this is "the domain rule — the decision
the product makes that no other tool makes for the user", and "if this slice does
not produce findings that feel smarter than the raw list, the product is a
formatter over other tools."

### The unknown to settle while planning

**What operationally counts as "the same underlying cause"?** The PRD states the
rule and not the test for it. The roadmap marks this as a design decision to make
during planning rather than an external dependency — but Open Roadmap Question 2
(*what mechanism delivers the no-false-positive-fatigue guardrail?*) lists S-09 as
blocked, and per-finding muting was offered and declined. So the correlation has
to earn its signal quality the way every rule here has: conservative detection,
traceable to something the site itself asserted, with no threshold that cannot be
defended.

### What the last run actually produced, as raw material

`29fa2fc7` against yazaki-emea.com, 2026-09-03: 67 findings over 533 pages, from
six of twenty-four rule types. Candidate correlations visible by eye in that data:

- **One dead URL, twenty-two findings.** `previous-career-pages/` link rot appears
  as 20 `link_broken` findings across ten locales, all from language-switcher
  blocks on the same archived pages. One cause, one fix.
- **One footer link, 502 pages.** `yazaki-group.com/global` is a single
  `link_external_broken` already collapsed by that rule — evidence that the
  collapse shape works and a precedent for what this slice generalises.
- **A test page in two navigation templates.** `dev/sunzinet-test` and
  `dev/test-page` are two findings with one origin: an agency artefact left in a
  layout.
- **Sitemap and orphans are the same story told twice.** 452 pages missing from
  the sitemap and 71 sitemap URLs nothing links to are both "the sitemap and the
  site disagree about what exists".
- **34 `metadata_duplicated` findings across 114 pages** trace to a handful of CMS
  templates, not to 34 independent editorial mistakes.

Whether those groupings are *the* rule or merely five examples of it is exactly
what research and planning have to establish. Grouping by shared evidence is not
the same as grouping by shared cause, and the difference is where a false
correlation would come from.

### Carried forward

`context/foundation/lessons.md` still applies, and S-04's Phase 10 added one to
it: **a threshold that scales with the defect it hunts goes quiet exactly when it
matters.** A correlation confidence score would be that shape of mistake if it
were tuned rather than derived.
