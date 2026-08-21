# Tenant-scoped Records and Owner Sign-in — Plan Brief

> Full plan: `context/changes/tenant-scoped-owner-signin/plan.md`
> Roadmap item: `context/foundation/roadmap.md` § F-01

## What & Why

Make tenancy an enforced property of every data access path, and give an Owner a way to sign in.
This is sequenced first on the roadmap because retrofitting tenant scoping onto existing domain
tables is a migration rather than an edit — and the next slice, S-01, creates the first domain
tables.

## Starting Point

A freshly scaffolded T3 app. Sign-in logic exists and is runtime-verified, but nothing creates a
user, no tenant concept exists, and `protectedProcedure` proves identity without proving tenancy.
The scaffold's own demo router does an unscoped `findFirst` behind an authenticated procedure —
the exact shape of a cross-tenant leak, and currently the only worked router example in the tree.

## Desired End State

An Owner signs in and sees the projects belonging to their tenant, and cannot reach another
tenant's projects — enforced at the procedure boundary rather than by per-query discipline, and
guarded by a test that fails automatically if a future router forgets to scope.

## Key Decisions Made

| Decision                   | Choice                                          | Why (1 sentence)                                                                                       | Source   |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------- |
| Enforcement mechanism      | `tenantProcedure` + pre-scoped query helper      | Scoping is inherited by construction; row-level security is stronger but needs hand-maintained SQL on a push-based workflow. | Plan     |
| Tenant identity at runtime | Resolved per request from the user id            | A token claim would stay wrong until expiry, and JWT sessions already removed the ability to revoke early. | Plan     |
| First account              | Seed command                                     | Repeatable and adds no public surface, which matches an invite-only product with no registration route.  | Plan     |
| User↔tenant shape          | One tenant per user, as a column                 | A join table rebuilds the multi-agency capability the PRD explicitly cut when it dropped the admin role. | Plan     |
| Scope boundary             | Creates tenants + projects, read-only list       | Makes "view your projects" verifiable here and hands S-01 an already-scoped table.                      | Plan     |
| Verification               | Cross-tenant integration test                    | A binary commitment the PRD calls business-ending deserves an automated guard, not a one-time review.   | Plan     |
| Gated-route behaviour      | Redirect to sign-in                              | Resolves PRD Open Question 7; least confusing for a client contact following a stale link.              | Roadmap  |

## Scope

**In scope:** tenants table; tenant column on user; minimally-scoped projects table;
per-request tenant resolution; `tenantProcedure` and a scoping helper; removal of the demo
router, its table and component; Owner seed command; sign-in page; read-only projects list;
unauthenticated redirect; first test infrastructure plus a cross-tenant isolation test.

**Out of scope:** roles, invites, client access (all S-10); public registration; password reset
and email verification; project creation and configuration (S-01); row-level security; session
revocation; visual design beyond legibility.

## Architecture / Approach

A middleware resolves the caller's tenant once per request and exposes it on the tRPC context.
`tenantProcedure` builds on `protectedProcedure`, rejects a tenantless caller with `FORBIDDEN`,
and narrows the context type so downstream code sees a non-nullable tenant. Domain routers
compose a tenant-equality helper into their `where` clauses. The new `project.list` router
becomes the reference example that future routers copy — replacing the unscoped demo that is
deleted in the same change.

## Phases at a Glance

| Phase                            | What it delivers                                          | Key risk                                                                       |
| -------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1. Tenant and project schema     | tenants table, tenant column on user, scoped projects table | Nullable tenant column is a deliberate compromise that reads like an oversight |
| 2. Tenant-scoped access layer    | Per-request resolution, `tenantProcedure`, demo removed     | Deleting the demo touches the home page; build breaks if a usage is missed     |
| 3. Owner seed command            | An account that can actually sign in                        | Email normalisation must match sign-in or the account can never authenticate   |
| 4. Sign-in and project list      | First user-visible surface, gated-route behaviour settled   | The error message must not undo the deliberate account-enumeration defence     |
| 5. Cross-tenant isolation test   | Automated guard on the isolation commitment                 | Introduces the project's first test infrastructure — real setup cost           |

**Prerequisites:** running Postgres container (already up), schema applied, `.env` populated.
No blocking unknowns; the roadmap lists this item as ready.

**Estimated effort:** five phases, each independently verifiable; phases 1–4 are small and
sequential, phase 5 carries most of the setup cost because it bootstraps testing.

## Open Risks & Assumptions

- **The procedure boundary is a convention, not a guarantee.** `ctx.db` remains reachable, so a
  determined or careless router can still bypass scoping. The Phase 5 test catches it for
  `project.list`; it does not catch it for a router written later. Row-level security is the
  upgrade path if that becomes unacceptable.
- **`users.tenantId` is nullable while the application treats it as required.** Deliberate, so
  the Auth.js adapter's user-creation path does not break the first time a federated provider is
  added. The invariant is enforced in the resolver instead.
- **Test infrastructure is new.** Phase 5 is the largest phase for this reason, and its estimate
  is the least reliable.
- **Session revocation remains absent.** Inherited from the credentials/JWT decision, not
  introduced here, and not addressed here.

## Success Criteria (Summary)

- An Owner can sign in and see their tenant's projects, and only theirs.
- A signed-out visitor hitting a gated route lands on sign-in rather than an error.
- Breaking the scoping deliberately makes the test suite fail.
