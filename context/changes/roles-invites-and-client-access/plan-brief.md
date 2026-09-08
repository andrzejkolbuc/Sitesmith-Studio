# Roles, Invites and Client Access — Plan Brief

> Full plan: `context/changes/roles-invites-and-client-access/plan.md`
> Research: `context/changes/roles-invites-and-client-access/research.md`

## What & Why

Roadmap slice S-10. An Owner can invite a Team-member to the tenant and a Client-viewer to a single project, assign team members to specific projects, and be sure a client sees only their own project. It satisfies FR-001, FR-003, FR-004, FR-005, FR-010 and NFR-2, and it is the client identity S-11 depends on.

The roadmap frames this as completing the account model F-01 opened. Research showed that undersells it: F-01 built a **one-dimensional** model, and this slice adds a second dimension that has no slot anywhere in the existing code.

## Starting Point

The product has exactly one authorization axis: tenant. A user is bound to a tenant by a single nullable column; there is no role column, no user↔project edge, and no code path that asks "may this user see *this project*". Everything inside a tenant is fully visible and fully mutable by everyone in it. An audit of all 11 non-test database access sites confirmed the isolation guarantee currently holds — but every predicate it rests on answers *which tenant*, and none has room for a second term.

The invite seams are already cut: `passwordHash` is nullable "for a user invited but who has not yet set a password", and the sign-in page already tells people accounts are created by invitation.

## Desired End State

An Owner opens a members page, invites someone, and hands them a link. The invitee sets a password and lands in the product scoped to exactly what they were granted. A Team-member sees their assigned projects and can run checks on them. A Client-viewer sees one project, read-only, and cannot discover that any other exists — including through the snapshot image route, which serves raw PNG bytes and inherits no middleware.

## Key Decisions Made

| Decision | Choice | Why | Source |
|---|---|---|---|
| Role & assignment storage | `users.role` + `projectAssignments` join table | Role stays a property of the person in their one tenant, matching F-01's column shape; the Owner path needs no join, so existing queries keep their cost | Plan |
| Client-viewer tenancy | Carries the agency's `tenantId`, restricted within it | `tenantProcedure`, the layout guard and all 20 tenant predicates keep working; the second dimension composes onto the first instead of replacing it | Plan |
| Invite delivery | Copyable link, sent out-of-band | Needs no mail transport and no base-URL env var — the browser builds the URL from its own origin, so the slice does not inherit F-02's unresolved hosting decision | Plan |
| Refusal shape | Uniform 404 | Preserves the policy written in three places, and is correct for the case that matters most: a Client-viewer must not learn the agency has other clients | Plan |
| Where the predicate lands | Extend the four non-tRPC sites in place; no refactor | Each site keeps re-establishing its own authority, as the snapshot route's own comment argues for; a shared resolver would turn a feature slice into a crawl-engine refactor | Plan |
| Role resolution | Per request, alongside the tenant | Follows the written precedent — an unrevocable JWT claim "would stay wrong until expiry"; role comes free on the row already read | Research |
| Project deletion | Out of scope | No FR requires it and it exists for nobody today; its cascade deserves its own slice | Plan |
| Invite token | New table, SHA-256 hashed, single-use, expiring | Carries role, target project and inviter, which `verificationTokens` cannot; a database dump yields no working link | Plan |
| Management surface | The FRs plus revoking a *pending* invite | Revocation mitigates the bearer-token risk accepted by choosing links; removing accepted members is deferred | Plan |
| Enforcement point | Once at the project/run boundary, not per query | Avoids threading a second predicate through 20 sites, and fixes the four procedures that check no project at all | Plan |

## Scope

**In scope:** role column and assignment table; per-request role resolution; Owner-only procedure builder; project-access boundary check on every project- and run-scoped procedure; narrowed project list; role gates on the four mutations; project scoping on the snapshot byte route; invite issue/accept/revoke with a hashed single-use token; members page with assignment; role-conditional UI; the within-tenant authorization matrix that has never existed.

**Out of scope:** project deletion; removing an accepted member or changing a role; email delivery; refactoring the four enforcement points into a shared resolver; password reset and email verification; session revocation; rate limiting on the accept route; a platform Admin role.

## Architecture / Approach

Role and assigned-project ids are resolved on the same per-request path that already resolves the tenant, and land on the tRPC context. A new `ownerProcedure` refuses non-Owners at the boundary. A single helper, `assertProjectAccess(ctx, projectId)`, is called once per procedure where the project or run is resolved and throws a uniform `NOT_FOUND` — so the second dimension is checked at the boundary rather than threaded through every query. The snapshot route, which inherits nothing, gains the same check by hand. Invites live in their own table holding only a hash of the token; acceptance creates the user, grants the assignment and deletes the invite in one transaction.

Owner is the default and the unchanged path: existing rows default to `owner`, Owners have no assignment rows, and the access check short-circuits for them — so Phases 1–3 ship with no observable behaviour change.

## Phases at a Glance

| Phase | What it delivers | Key risk |
|---|---|---|
| 1. Schema & resolution | Role column, assignment and invite tables, widened per-request lookup | Adding a non-null column to a populated table — needs a database-level default, not `$defaultFn` |
| 2. tRPC enforcement | Owner-only builder, project-access boundary, narrowed list, mutation gates, within-tenant test matrix | 15 procedures to touch; a missed `assertProjectAccess` is a silent hole |
| 3. Snapshot route | Project scoping on raw image bytes | The only place the new dimension is a real leak; the check must cover the default view, not just the diff path |
| 4. Invite issue & accept | Owner-only invite procedures; ungated accept page; first in-app password write | The accept transaction must be atomic, or a consumed link still reads as pending |
| 5. Members page & UI | Members list, assignment, revoke, role-conditional controls, E2E journey | First shell element in the app; hiding controls is presentation, not enforcement |

**Prerequisites:** F-01 (done). A running Postgres for the integration and E2E buckets. No new dependencies, no new environment variables.
**Estimated effort:** ~4–5 sessions across 5 phases; Phase 2 is the largest.

## Open Risks & Assumptions

- **`pinBaseline` and `setMasks` are Owner-only by interpretation, not quotation.** The PRD grants a Team-member "run checks and view results" and reserves "configure checks" to the Owner; this plan reads baseline and masks as configuration. If wrong, it is one line per procedure.
- **The password minimum (12 characters) is a new decision.** Nothing in the PRD or lessons specifies one; sign-in validates `min(1)` because it must accept whatever is stored.
- **An invite link is a bearer token in someone's message history.** Accepted deliberately in exchange for shipping without a mail transport; mitigated by expiry, single use, and revocation.
- **The procedure boundary remains a convention, not a guarantee** — `ctx.db` stays reachable. Inherited from F-01, not introduced here. The completeness guard is what keeps it honest.
- **PRD Open Question 7 is recorded as open but was answered by F-01** (unauthenticated → redirect to sign-in, implemented and tested). Only the write-back is missing; it should not be re-litigated as though undecided. This plan answers the genuinely open half — authenticated but unauthorised → 404.

## Success Criteria (Summary)

- An Owner can invite both roles, assign projects, revoke a pending invite, and see who has access to what.
- A Client-viewer sees exactly one project and cannot reach another's pages, findings, or snapshot images by any route.
- The full suite is green — unit, integration, E2E, typecheck and Biome — with the within-tenant matrix failing by name if any access check is removed.
