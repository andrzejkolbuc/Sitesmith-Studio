---
change_id: politeness-under-stress
title: "Politeness under stress"
status: complete
created: 2026-08-25
updated: 2026-08-25
test_plan_phase: 4
risks: [R2]
---

# Politeness under stress

Rollout Phase 4 of `context/foundation/test-plan.md`, and the last.

**Risk covered — R2:** a check degrades the client site it is checking. Sourced
from NFR-1, "causing a client incident is a worse outcome than the regression
being hunted", from the interview, and from `src/server/crawl/` being the
heaviest-churn directory in the repo. The crawler has still never run against a
real client site.

**What had to be proven:** a site that is slow, flapping or hostile causes the
run to stop rather than escalate — and every run terminates.

**What was challenged:** that "aborts on 5 consecutive failures" covers the
shapes that actually occur. It does not: intermittent failure never accumulates
consecutively.

**Anti-pattern avoided:** testing only the clean abort. The dangerous case is
degradation that never trips a threshold, and it was the one defect this phase
found.

- Plan: `plan.md`
