---
change_id: hreflang-and-variant-parity
title: "hreflang graph and cross-variant parity"
status: planned
created: 2026-08-25
updated: 2026-08-25
roadmap_ref: S-02
prd_refs: [US-01, FR-025, FR-026]
---

# hreflang graph and cross-variant parity

Roadmap slice S-02. Depends on S-01, which is built.

**Outcome:** the user can see hreflang declarations that are non-reciprocal or
incomplete, and see a page family where one language variant is failing while
its siblings are fine.

**Why now:** half of FR-025 already ships — "pointing at dead URLs" is covered
by the broken-variant and unreached rules. The other half does not exist, and
Phase 3 of the test rollout found the gap while checking detection confidence:
`variants.ts` treats a one-directional declaration as a sibling relationship,
which is right for grouping and leaves the asymmetry itself unreported.

**Why it is cheap:** no new infrastructure. The variant graph, the sibling
declaration map, and the per-page status records all exist from S-01, and
`findings.type` is a varchar with a jsonb detail, so new finding types need no
migration.

**The governing constraint:** the product's stated fatal failure is
false-positive fatigue. Non-reciprocity fires heavily on real sites, so every
rule here reports at the level of the family rather than the URL — which is also
what the business-logic requirement asks for: "the divergence itself is the
finding, not five independent per-URL reports".

- Plan: `plan.md`
- Brief: `plan-brief.md`
