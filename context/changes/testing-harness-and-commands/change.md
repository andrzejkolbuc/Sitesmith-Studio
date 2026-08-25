---
change_id: testing-harness-and-commands
title: "Test harness and commands"
status: planned
created: 2026-08-25
updated: 2026-08-25
test_plan_phase: 1
risks: [R4]
---

# Test harness and commands

Rollout Phase 1 of `context/foundation/test-plan.md`.

**Risk covered — R4:** a user cannot complete sign in → create project → run
check → read findings because a UI surface broke. Zero test files exist under
`src/app/`; nine user-visible behaviours were verified by hand once during S-01
and never since.

**What must be proven:** a user completes the whole journey in a real browser
and reads a finding they could act on.

**What to challenge:** that passing server tests imply a working interface.
Every failure found by hand during S-01 was visual.

**Anti-pattern to avoid:** asserting DOM structure instead of what the user can
see and do — a test coupled to markup breaks on every restyle and catches
nothing.

- Plan: `plan.md`
