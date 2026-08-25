---
change_id: detection-rule-confidence
title: "Detection-rule confidence"
status: complete
created: 2026-08-25
updated: 2026-08-25
test_plan_phase: 3
risks: [R1]
---

# Detection-rule confidence

Rollout Phase 3 of `context/foundation/test-plan.md`. The highest-ranked risk in
the map — high impact, high likelihood.

**Risk covered — R1:** a finding fires on something that is not a problem, the
operator stops reading findings, and the product becomes shelfware. Sourced from
the PRD guardrail "no false-positive fatigue — the developer stops reading them
and the product is dead", from the interview, and from implementation itself,
where rule 1 fired seven times where two was correct and a broken variant was
reported twice under two names.

**What had to be proven:** a site shape the rules have never seen produces the
findings a human would agree with — and stays silent where a human would.

**What was challenged:** that the existing fixture represents real sites. It was
written to make chosen rules pass, by the author of those rules, in the same
sitting.

**Anti-pattern avoided:** the oracle problem. Expectations were written down
before the rules were run against each shape, and sourced from outside the
implementation — hreflang guidance, ISO 639-1, and the PRD's own guardrail.
Where a rule disagreed, the disagreement was investigated rather than the
expectation edited, because an expectation adjusted to match the output is just
the output written twice.

- Plan: `plan.md`
