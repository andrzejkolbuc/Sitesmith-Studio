<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Tenant-scoped Records and Owner Sign-in

- **Plan**: `context/changes/tenant-scoped-owner-signin/plan.md`
- **Scope**: Full plan — Phases 1–5 of 5
- **Date**: 2026-08-24
- **Verdict**: NEEDS ATTENTION → **RESOLVED** (triaged 2026-08-24: 5 fixed, 1 accepted)
- **Findings**: 0 critical, 2 warnings, 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

All 33 Progress items complete. Automated criteria re-run during this review:
typecheck PASS, lint PASS, test suite 3/3 PASS, build PASS, db:push PASS,
no residual demo-router references PASS.

## Findings

### F1 — Signed-in user with no tenant hits an unhandled server error

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/app/(app)/projects/page.tsx:12`, `src/app/(app)/layout.tsx:24`
- **Detail**: The gated layout admits anyone with a session. `project.list` then throws
  `FORBIDDEN` for a caller with no tenant, and nothing catches it — there is no `error.tsx`
  anywhere in the app. Verified live rather than reasoned: seeding a user, nulling its
  `tenantId`, and signing in produces "This page couldn't load. A server error occurred."
  This is not a hypothetical path. `users.tenantId` was deliberately made nullable so the
  Auth.js adapter could create users, which means the design explicitly permits the state
  that crashes. The two halves of that decision were never joined up.
- **Fix A ⭐ Recommended**: Resolve the tenant in the gated layout and handle its absence there.
  - Strength: Puts the check at the same boundary that already decides admission, so every
    future gated page inherits it — the same structural argument that put the auth check in a
    layout rather than per page.
  - Tradeoff: Adds a second tenant lookup per gated request unless the value is threaded
    through; at single-digit users that cost is immaterial.
  - Confidence: HIGH — the layout already performs an async session check, so the shape is
    proven in this codebase.
  - Blind spot: Does not protect non-page callers (route handlers, server actions) that reach
    `project.list` outside the layout.
- **Fix B**: Add an `error.tsx` boundary that renders a message for `FORBIDDEN`.
  - Strength: Catches every failure mode on the route, not just this one, and is the idiomatic
    framework answer.
  - Tradeoff: Treats a predictable state as an exception — the user still lands on an error
    screen, just a nicer one, rather than being told what is wrong with their account.
  - Confidence: MEDIUM — needs care to distinguish `FORBIDDEN` from genuine faults.
  - Blind spot: Have not verified how the tRPC error surfaces through the RSC boundary.
- **Decision**: FIXED via Fix A — tenant resolved in the gated layout; a tenantless account now sees an explanation and a sign-out rather than a server error.

### F2 — `tenantScope` cannot tell a tenant column from any other column

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/server/api/trpc.ts:211`
- **Detail**: The signature is `tenantScope(column: PgColumn, tenantId: string)`. Any column of
  a compatible type satisfies it, so `tenantScope(projects.name, ctx.tenantId)` compiles and
  silently returns nothing. The helper exists to make scoping hard to get wrong; as typed it
  only makes scoping easy to *write*, which is a weaker guarantee than its own documentation
  claims. This matters more than a normal typing nit because the helper is explicitly presented
  as the pattern every future domain router should copy.
- **Fix**: Take the table rather than the column, constrained to tables that have a tenant
  column — `tenantScope(projects, ctx.tenantId)`, with the helper reading `.tenantId` itself.
  A table lacking the column then fails to compile, and pointing at the wrong column becomes
  unexpressible.
  - Strength: Converts a naming convention into a type-checked one, at one call site today.
  - Tradeoff: Slightly more involved generic signature; the constraint may need loosening to
    satisfy Drizzle's table types.
  - Confidence: MEDIUM — the approach is standard, but Drizzle's inferred table types have not
    been verified against this specific constraint.
  - Blind spot: Not verified whether the same constraint holds for tables where the column is
    nullable, such as `users`.
- **Decision**: FIXED — signature now takes the table and reads `tenantId` itself. Verified negatively: passing a column, or a table without a tenant column, both fail to compile (TS2345); the correct call is clean. The Drizzle-typing blind spot did not materialise.

### F3 — The plan no longer describes what was built

- **Severity**: 📄 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `context/changes/tenant-scoped-owner-signin/plan.md` — Phase 4
- **Detail**: Three documented divergences never made it back into the plan body. Phase 4's
  change #3 (the projects router) was implemented in Phase 2, because an empty `appRouter`
  fails to typecheck. Phase 4 names `src/app/projects/page.tsx`; the file is at
  `src/app/(app)/projects/page.tsx`. Phase 4 offers `src/middleware.ts` or a per-page guard;
  the implementation is a route-group layout, which is neither. Every divergence was agreed
  and is recorded in commit messages, so nothing was done silently — but the plan is the
  artifact future reviews read as ground truth, and it is now wrong in three places.
- **Fix**: Add a short addendum to Phase 4 noting the router moved to Phase 2 and the two path
  changes.
- **Decision**: FIXED — addendum added to Phase 4 recording the router move and both path changes.

### F4 — Four file groups changed outside the plan

- **Severity**: 📄 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: `tsconfig.json`, `src/app/layout.tsx`, `AGENTS.md`, `CLAUDE.md`, `test/global-setup.ts`
- **Detail**: `tsconfig.json` gained `allowImportingTsExtensions`, forced by the plan's own
  instruction to avoid adding a TypeScript runner. `src/app/layout.tsx` had its scaffold title
  replaced. `AGENTS.md` and `CLAUDE.md` are generated by `next dev` and were committed
  separately. `test/global-setup.ts` is implied by Phase 5's "test runner and database
  strategy" but not named. All are justified in their commits and none expand the product
  surface. Recorded so the divergence is visible rather than absorbed.
- **Fix**: None needed — noted for the record.
- **Decision**: ACCEPTED — no action. The finding exists to make the divergence visible; all four are justified in their commits.

### F5 — The dev-database guard protects only one entry point

- **Severity**: 📄 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `test/global-setup.ts:22`, `src/server/api/routers/project.test.ts:57`
- **Detail**: The `-test` suffix check lives in `globalSetup`. The suite's `beforeEach`
  truncates `projects`, `users` and `tenants` unconditionally against whatever `DATABASE_URL`
  the worker holds. That guard already earned its keep once during implementation, when
  `globalSetup` still saw the development URL. Anything that runs the test file without that
  setup — a different config, an IDE runner, a future `--project` split — truncates whatever
  it is pointed at.
- **Fix**: Repeat the `-test` assertion in the test file's setup, so the destructive operation
  and its guard live together.
- **Decision**: FIXED — the `-test` assertion is repeated in the test file, so the truncation and its guard live together.

### F6 — Fallback secret literal in the test config

- **Severity**: 📄 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `vitest.config.ts:60`
- **Detail**: `AUTH_SECRET` falls back to the literal `"test-secret-not-used-for-signing"`.
  Harmless — it is test-only, never signs a real session, and is named to say so — but it is
  a hardcoded credential-shaped string that a secret scanner will flag, and the noise costs
  more than the line saves.
- **Fix**: Generate the fallback at config load instead of hardcoding it.
- **Decision**: FIXED — fallback is generated with randomBytes at config load instead of a hardcoded literal.
