---
change_id: crawl-technical-checks
title: "Broken links, sitemap and robots reconciliation, orphans, duplicates and TLS checks"
status: preparing
created: 2026-09-02
updated: 2026-09-02
archived_at: null
---

## Notes

Roadmap item **S-04**, the other independent branch off S-01 in Stream B (S-05
closed 2026-09-02). Six must-have requirements:

- **FR-016** — broken internal and external links; redirect chains or loops
- **FR-017** — sitemap↔crawl reconciliation: sitemap URLs that fail, live pages
  absent from the sitemap
- **FR-018** — robots.txt rules blocking pages that were intended to be indexable
- **FR-019** — orphan pages: reachable via sitemap but linked from nowhere
- **FR-020** — duplicate titles and near-identical content across URLs
- **FR-030** — security header and certificate problems, including expiry

### Two things to settle before this can be planned

- **Scope.** Six requirements is the largest single roadmap item on the board,
  and they do not share an implementation: link-graph work (FR-016, FR-019),
  a new sitemap/robots fetch-and-parse channel (FR-017, FR-018), a content
  comparison (FR-020), and a transport-layer probe that has nothing to do with
  page markup at all (FR-030). Phasing, or splitting, is a planning decision
  that should be made explicitly rather than by drift.
- **Overlap with work already shipped.** FR-020's "duplicate titles" is the rule
  S-05 already built and validated (`metadata_duplicated`, 34 findings on
  yazaki-emea.com); "near-identical content across URLs" is adjacent to S-03's
  drift comparison but scoped across URLs rather than across variants. Research
  must establish what is genuinely new here before anything is rebuilt.

### The roadmap's own objection, carried forward

S-04's risk note records that the PRD's Socratic pass called these checks a
rebuild of a mature existing tool, and that they were kept must-have with the
objection acknowledged and overruled. That does not change the scope, but it
does set the bar: the value has to come from these findings sitting beside the
multilingual ones in one run, not from the checks themselves.

`context/foundation/lessons.md` still applies — every finding must trace to
something the site itself asserted. A 404 and an expired certificate are direct
assertions; "near-identical" and "intended to be indexable" are inferences and
will need the same defended-threshold treatment S-03 and S-05 both needed.
