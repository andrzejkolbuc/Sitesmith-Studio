---
change_id: auth-and-abuse-behaviours
title: "Auth and abuse behaviours"
status: archived
created: 2026-08-25
archived_at: 2026-08-31T07:33:51Z
updated: 2026-08-31
test_plan_phase: 2
risks: [R3, R5, R6, R7]
---

# Auth and abuse behaviours

Rollout Phase 2 of `context/foundation/test-plan.md`.

**Risks covered:**

- **R3** — a newly added query forgets tenant scoping and one client's data
  reaches another's session. Thirteen roadmap slices remain, each adding
  routers; the archived impl-review finding F2 showed the scoping helper
  accepting any column.
- **R5** — an account in a legitimate but partial state crashes instead of
  explaining itself. Archived finding F1, reproduced live and fixed, with no
  automated guard since. S-10 introduces invites and more partial states.
- **R6** — password verification accepts a wrong password or rejects a correct
  one. Security-critical, verified once by a throwaway script that was deleted.
- **R7** — sign-in reveals which email addresses hold accounts. Invite-only
  access; the deliberate timing defence had no test.

**What had to be proven:** a correct password verifies and a malformed stored
value fails closed; a caller holding another tenant's identifier is refused by
every read path *including ones added later*; an account missing its tenant is
told what is wrong and offered a way out on *every* gated surface; and an
unknown address is indistinguishable from a wrong password in both message and
timing.

**What was challenged:** that round-tripping one password is sufficient
evidence; that the scoping helper is a guarantee rather than a convention; that
the one fixed partial state is the only one; and that returning the same string
closes the enumeration channel.

**Anti-patterns avoided:** testing only hash-then-verify — the interesting cases
are corrupt, truncated and foreign-format digests. Testing only the procedures
that exist today — the risk is the router written next month. Asserting the
sign-in message alone, which silently permits a timing regression.

- Plan: `plan.md`
