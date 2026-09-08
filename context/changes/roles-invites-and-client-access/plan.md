# Roles, Invites and Client Access — Implementation Plan

## Overview

Add a second authorization dimension — role and project assignment — to a model that today knows only tenant, then build the invite flow that brings non-Owner accounts into existence. Enforcement ships **before** the ability to create the roles it constrains, so an unconstrained non-Owner can never exist even transiently.

This is roadmap slice S-10, satisfying FR-001, FR-003, FR-004, FR-005, FR-010 and NFR-2.

## Current State Analysis

The product has exactly one authorization axis: tenant. A user is bound to a tenant by a single nullable column, `users.tenantId` (`src/server/db/schema.ts:84`). There is no role column, no user↔project edge, and no code path anywhere that asks "may this user see *this project*". Everything inside a tenant is fully visible and fully mutable by every user in it.

Consequently S-10 **introduces** project-level authorization rather than extending it. Full detail in `context/changes/roles-invites-and-client-access/research.md`; the load-bearing facts:

- **Isolation holds today.** An audit of all 11 non-test database access sites found zero gaps. Every predicate answers *which tenant*; none has a slot for a second dimension.
- **The tRPC surface is centralised.** One context resolver (`src/server/api/trpc.ts:49-57`), one builder chain ending in `tenantProcedure` (`:180-194`), one predicate helper `tenantScope` (`:217-220`), and 15 procedures composing it identically.
- **Four enforcement points sit outside tRPC and inherit nothing**: the snapshot byte route, the crawl engine, retention, and the `(app)` route-group layout.
- **The invite seams are already cut.** `users.passwordHash` is nullable with the comment "a user invited but who has not yet set a password has none" (`schema.ts:68-73`); the sign-in page already says "Accounts are created by invitation"; the no-tenant notice already says "Accounts are attached when they are invited."
- **No mail transport, no base URL.** Zero mail dependencies. The app declares three env vars — `AUTH_SECRET`, `DATABASE_URL`, `NODE_ENV` (`src/env.js:15-19`). No `AUTH_URL`/`APP_URL`/`BASE_URL`.
- **No migrations directory.** Drizzle is push-based; both test harnesses apply schema with `drizzle-kit push --force`.
- **`emailVerified` defaults to `new Date()`** (`schema.ts:65-71`), so every row is born verified. That column is spent as a pending signal; a pending invite is a row in the invites table, nothing more.

## Desired End State

An Owner can invite a Team-member to the tenant or a Client-viewer to a single project, assign Team-members to specific projects, revoke an invite that has not been accepted, and see who has access to what. An invitee opens a link, sets a password, and lands in the product scoped to exactly what they were granted. A Client-viewer sees one project and cannot discover that any other exists — including through the snapshot image route, which serves raw PNG bytes and inherits no tRPC middleware.

Verified by: the existing generated isolation suite extended with a within-tenant matrix; a new E2E journey that drives owner → invite → accept → constrained view end to end.

### Key Discoveries

- `tenantScope` takes the **table**, not a column, so a table without `tenantId` cannot be passed (`src/server/api/trpc.ts:205-220`). New tables must carry `tenantId` to compose with it.
- `src/server/api/tenant-isolation.test.ts:419` reflects over `appRouter._def.procedures` and fails while any procedure is unclassified. Every new procedure fails the suite **by name** until added to `CASES`.
- `e2e/journeys/partial-account.spec.ts:34-59` derives gated routes by walking `src/app/(app)/` on the filesystem. Any new page under that group is auto-enrolled and must render the no-workspace notice for an orphan account without a 5xx.
- `test/reset.ts:40-42` derives its truncation list from the schema module at runtime — new tables need no harness wiring.
- `scripts/seed-owner.ts:55` normalises email as `trim().toLowerCase()`, matching `src/server/auth/config.ts:70`. **Any code that creates a user must apply the same normalisation** or the account becomes unreachable at sign-in.
- The established crypto idiom is `randomBytes(n).toString("hex")` for secrets and `createHash("sha256")` for digests, both from `node:crypto`. No token library is installed and none is needed.
- The shared page idiom is: inline `"use server"` action → validate in a server-side layer with zod → on failure `redirect("<same path>?error=1")` → render one fixed-text `role="alert"` banner → on success `redirect` elsewhere. `searchParams` is `Promise`-wrapped and awaited (Next 16).
- A database-level `.default()` is required rather than `$defaultFn` when adding a non-null column to a populated table — the trap is documented at `src/server/db/schema.ts:210-215`.

## What We're NOT Doing

- **Project deletion.** The PRD role matrix names it, but no FR requires it and it exists for nobody today. Its cascade across runs, pages, observations, snapshots and findings deserves its own slice. The matrix line stays unviolated because no role can delete.
- **Removing an accepted member, or changing someone's role.** Only revoking a *pending* invite is in scope. Fixing an accepted mistake needs a follow-up slice or a database edit.
- **Email delivery.** Invites are copyable links sent out-of-band. No transport, no API key, no base-URL env var — the browser builds the absolute URL from its own origin.
- **Refactoring the four hand-written enforcement points into a shared resolver.** Each keeps re-establishing its own authority, as F-01 left it and as the snapshot route's own comment argues for.
- **Password reset, email verification, account settings.** Not required by any FR in this slice.
- **Session revocation.** Already lost to the JWT strategy; not restored here. Role and assignment are re-read per request precisely so this does not matter for access.
- **Rate limiting or lockout on the accept route.** Absent everywhere in the product today; introducing it here would be inconsistent and is not required by any FR.
- **A platform-level Admin role.** Dropped during shaping; the role set is exactly three.

## Implementation Approach

**Check project access at the boundary, not in every query.** Rather than threading a second predicate through all 20 query sites, every procedure resolves project access once — at the project or run boundary — and the existing tenant scoping carries the rest. A single helper, `assertProjectAccess(ctx, projectId)`, throws `NOT_FOUND` uniformly. This fixes, as a side effect, the four procedures that currently perform no project-existence check at all (`latestRun`, `runs`, `trend`, `runPages`).

**Role and assignments are resolved per request, never carried in the token.** This follows the precedent set for tenant and stated in writing at `src/server/api/trpc.ts:38-48`: an unrevocable JWT claim "would stay wrong until expiry". Role comes free on the row already being read; the assignment list costs a second query, and only for non-Owners.

**Owner is the default and the unchanged path.** Existing rows default to `owner`, an Owner has no assignment rows, and `assertProjectAccess` short-circuits for them. Phases 1–3 therefore ship with zero observable behaviour change until a non-Owner exists.

**Uniform 404.** A project you may not see is indistinguishable from one that does not exist, which preserves the policy written down in three places and is the correct answer for the case that matters most: a Client-viewer must not learn the agency has other clients.

## Critical Implementation Details

**Role assignment for `pinBaseline` and `setMasks` is an interpretation, not a quotation.** The PRD role matrix grants a Team-member "Run checks and view results on assigned projects" and reserves "configure checks" to the Owner. Baseline pinning and mask editing are project configuration, so this plan makes them Owner-only and leaves `startRun` available to an assigned Team-member. If that reading is wrong, the fix is one line per procedure in Phase 2.

**Ordering within Phase 4's accept action matters.** User creation, assignment insertion and invite deletion must happen in one transaction. A crash between creating the user and deleting the invite would leave a consumed link that still appears pending and could be replayed against an email that now exists.

**The password minimum is a new decision.** Sign-in validates `password: z.string().min(1)` because it must accept whatever is stored. Setting a password needs a real floor; this plan uses 12 characters. Nothing in the PRD or lessons specifies one.

---

## Phase 1: Schema and per-request resolution

### Overview

Introduce the role column, the assignment table and the invites table, and widen the two places that resolve a caller's tenant so they also resolve role and assigned projects. No authorization behaviour changes: every existing user is an Owner and sees exactly what they see today.

### Changes Required:

#### 1. Role column on users

**File**: `src/server/db/schema.ts`

**Intent**: Give every user a tenant-level role so authorization has something to read. Existing rows must come out as `owner` without a backfill step.

**Contract**: `role` on the `users` table, `varchar({ length: 16 }).notNull()` carrying a `$type<UserRole>()` where `UserRole = "owner" | "member" | "viewer"`. The default must be a **database-level** `.default("owner")`, not `$defaultFn` — the trap is documented at `schema.ts:210-215`: a `$defaultFn` default leaves existing rows violating the constraint when `db:push` runs.

#### 2. Project assignment table

**File**: `src/server/db/schema.ts`

**Intent**: Represent the many-to-many between users and projects that FR-005 requires. F-01's ruling against a join table constrained user↔*tenant* only; this edge was never addressed.

**Contract**: `projectAssignments` with `tenantId` (notNull, FK to tenants), `userId` (notNull, FK to users), `projectId` (notNull, FK to projects), `createdAt`. Composite primary key `(userId, projectId)`. Indexes on `tenantId`, `userId`, `projectId`. **`tenantId` is required even though it is derivable** — without it the table cannot be passed to `tenantScope`, whose signature demands a `tenantId` column.

#### 3. Invites table

**File**: `src/server/db/schema.ts`

**Intent**: Hold a pending invite: who it is for, what it grants, and a hash of the token that redeems it. A row in this table *is* a pending invite; acceptance and revocation both delete it.

**Contract**: `invites` with `id` (uuid PK via `$defaultFn`, matching the other eight tables), `tenantId` (notNull FK), `email` (notNull, stored already normalised), `role` (`$type<UserRole>()`), `projectId` (nullable FK to projects — required when role is `viewer`, optional initial assignment when `member`), `tokenHash` (`varchar({ length: 64 })`, notNull, **unique index**), `expiresAt` (notNull timestamp with timezone), `invitedByUserId` (notNull FK to users), `createdAt`. Index on `tenantId`.

Only the SHA-256 hex digest of the token is stored; the token itself is returned once at issue time and never persisted.

#### 4. Role type and invite constants

**File**: `src/server/auth/roles.ts` (new)

**Intent**: One place defining the role union, its ordering, and the predicates other modules ask about, so role checks read the same everywhere.

**Contract**: Exports `UserRole` (the union), `USER_ROLES` (the tuple, for zod), and small predicates — `isOwner(role)`, `canRunChecks(role)`, `canConfigureProject(role)`. `canRunChecks` is true for owner and member; `canConfigureProject` is true for owner only (see Critical Implementation Details).

#### 5. Widen the tRPC context resolver

**File**: `src/server/api/trpc.ts`

**Intent**: Resolve role and assigned projects on the same per-request path that already resolves the tenant, so no procedure has to remember to.

**Contract**: `createTRPCContext` selects `{ tenantId, role }` from `users` in the existing single lookup. When the role is not `owner`, it performs a second query returning the caller's assigned project ids. `ctx` gains `role: UserRole | null` and `assignedProjectIds: string[] | null`, where `null` means "unrestricted" (an Owner). An Owner therefore still costs exactly one query.

#### 6. Widen the layout's account lookup

**File**: `src/app/(app)/layout.tsx`

**Intent**: The layout re-reads the account per request rather than trusting the JWT; it needs the role for Phase 5's navigation and must not become a third source of truth that disagrees with tRPC.

**Contract**: The existing `db.query.users.findFirst` selects `role` in addition to `tenantId`. Behaviour is otherwise unchanged: no session still redirects, no tenant still renders `NoTenantNotice`.

#### 7. Leave the session type alone

**File**: `src/server/auth/config.ts`

**Intent**: Record why the commented-out `// role: UserRole;` at line 27 stays commented, so the next reader does not "finish" it.

**Contract**: Replace the placeholder comment with a short note that role is deliberately resolved per request rather than carried on the session, pointing at the reasoning already written at `trpc.ts:38-48`. No functional change.

### Success Criteria:

#### Automated Verification:

- Schema applies cleanly to a populated database: `npm run db:push`
- Type checking passes: `npm run typecheck`
- Linting and formatting pass: `npm run check`
- Unit tests pass: `npm run test:unit`
- Integration tests pass unchanged: `npm run test:integration`
- A new unit test asserts every existing user row resolves as `owner` when `role` is unset

#### Manual Verification:

- Signing in as the seeded owner still reaches the projects list with every project visible
- `npm run db:studio` shows the three new/changed structures with the expected columns and constraints

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 2: tRPC enforcement

### Overview

Add the Owner-only builder and the project-access boundary check, narrow `list` for non-Owners, gate the four mutations, and extend the isolation suite with the within-tenant matrix it has never had.

### Changes Required:

#### 1. Owner-only procedure builder

**File**: `src/server/api/trpc.ts`

**Intent**: Give user-management and project-configuration procedures a builder that refuses non-Owners at the boundary, the way `tenantProcedure` refuses tenant-less callers.

**Contract**: `ownerProcedure`, built on `tenantProcedure`, throwing `FORBIDDEN` when `ctx.role !== "owner"`. `FORBIDDEN` rather than `NOT_FOUND` is correct here and consistent with the precedent at `trpc.ts:177-178`: the failure is about the caller's own capability, not about concealing a resource. Document it in the builder's docblock alongside `tenantProcedure`'s.

#### 2. The project access boundary

**File**: `src/server/api/trpc.ts`

**Intent**: One helper answering "may this caller reach this project", used once per procedure at the point the project or run is resolved, instead of a second predicate threaded through every query.

**Contract**: `assertProjectAccess(ctx, projectId): Promise<void>`, throwing `TRPCError({ code: "NOT_FOUND" })` when access is refused. For an Owner (`assignedProjectIds === null`) it verifies the project exists within the tenant; for anyone else it additionally requires membership in `ctx.assignedProjectIds`. The refusal is identical in both cases and identical to a project that does not exist.

#### 3. Narrow the project list

**File**: `src/server/api/routers/project.ts`

**Intent**: `list` is the one procedure whose result set differs for all three roles; a non-Owner must see only their assigned projects.

**Contract**: `list` keeps `tenantScope(projects, ctx.tenantId)` and, when `ctx.assignedProjectIds` is non-null, adds an `inArray(projects.id, ...)` term. An empty assignment list must produce an empty result, not an unfiltered one.

#### 4. Project-access checks on every project- and run-scoped procedure

**File**: `src/server/api/routers/project.ts`

**Intent**: Every read that names a project or a run must confirm the caller may reach that project. This also closes the four procedures that today perform no project-existence check at all.

**Contract**: Procedures taking `projectId` (`byId`, `latestRun`, `runs`, `trend`, `pinBaseline`, `setMasks`, `startRun`) call `assertProjectAccess(ctx, input.projectId)` before their existing queries. Procedures taking `runId` (`runStatus`, `findings`, `comparison`, `runObservations`, `runSnapshots`, `runPages`) resolve the run under its existing `tenantScope` predicate first, then call `assertProjectAccess(ctx, run.projectId)`. `runPages` currently has no run lookup at all and gains one.

#### 5. Role gates on the four mutations

**File**: `src/server/api/routers/project.ts`

**Intent**: Apply the PRD capability matrix to the complete set of write operations.

**Contract**: `create` moves to `ownerProcedure`. `pinBaseline` and `setMasks` move to `ownerProcedure` (project configuration). `startRun` stays on `tenantProcedure` and additionally refuses when `canRunChecks(ctx.role)` is false, so an assigned Team-member may run a check and a Client-viewer may not. All four keep every predicate they have today.

#### 6. Classify the new surface in the isolation suite

**File**: `src/server/api/tenant-isolation.test.ts`

**Intent**: The completeness guard at line 419 fails while any procedure is unclassified. New procedures must declare their isolation behaviour rather than silently inherit a classification.

**Contract**: Every procedure added in this slice is entered in `CASES`. The `Case` union gains a third kind for Owner-only procedures, whose cross-tenant expectation is refusal-by-role rather than refusal-by-scope. The existing blunt assertion — no fingerprint of the victim in any outcome, thrown messages included — applies unchanged.

#### 7. Within-tenant authorization matrix

**File**: `src/server/api/within-tenant-access.test.ts` (new, integration)

**Intent**: Nothing today asserts that user A in tenant T is denied anything user B in tenant T can do, because until now nothing was. This is the test that makes the second dimension real.

**Contract**: Seeds one tenant with two projects and three users — owner, member assigned to project 1 only, viewer assigned to project 2 only — and asserts the full matrix: `list` returns the right subset per role; every project- and run-scoped read is refused for the unassigned project with the same shape as a nonexistent one; `create`, `pinBaseline` and `setMasks` are refused for member and viewer; `startRun` succeeds for the assigned member and is refused for the viewer. Follows the `-test` database guard pattern used by every integration file (e.g. `src/server/api/tenant-isolation.test.ts:36-42`).

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`
- Unit tests pass: `npm run test:unit`
- Integration tests pass, including the new matrix: `npm run test:integration`
- The isolation completeness guard passes with every new procedure classified
- Deliberate-break check: removing one `assertProjectAccess` call fails the within-tenant matrix by name

#### Manual Verification:

- Signing in as the seeded Owner shows every project and every control exactly as before this phase

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 3: The enforcement point outside tRPC

### Overview

Close the one non-tRPC surface where the new dimension actually matters. The snapshot route serves raw PNG bytes, inherits no tRPC middleware, and today scopes on tenant alone — so a Client-viewer restricted to one project could otherwise fetch screenshots of every other client's site.

### Changes Required:

#### 1. Project scoping on the snapshot byte route

**File**: `src/app/api/snapshots/[snapshotId]/route.ts`

**Intent**: Extend the route's own ownership chain with the project dimension, in place. The route deliberately re-establishes its own authority rather than inheriting it, and that stays true.

**Contract**: The account lookup at `:57-61` also selects `role`. After the run is resolved (the handler already holds `run.projectId` on the diff/baseline path), a non-Owner caller's assigned project ids are fetched and the run's project must be among them. Refusal uses the existing shared `notFound()` helper at `:35`, so it is indistinguishable from every other refusal this route makes. The check must apply to the **default view as well as the diff and baseline views** — the current project lookup only happens on the diff path.

#### 2. Confirm the other two sites need no change

**File**: — (verification only)

**Intent**: Record why the crawl engine and retention are untouched, so a reviewer does not read their absence as an oversight.

**Contract**: `src/server/crawl/run.ts:106` is reached only through `project.startRun`, which now calls `assertProjectAccess` first; its tenant predicate remains the backstop. `src/server/crawl/retention.ts` is only ever invoked from `run.ts:675` with a `tenantId` taken from an already-verified project, never from user input. Note both in the phase's commit message.

#### 3. Extend the route's isolation test

**File**: `src/server/api/tenant-isolation.test.ts`

**Intent**: The route is invisible to the `appRouter` reflection, so its coverage is hand-written and must grow by hand.

**Contract**: Add a case driving `GET` as a Client-viewer requesting a snapshot from a project they are not assigned to, asserting 404; and one asserting the same viewer still gets 200 with `content-type: image/png` for their own project's snapshot. Follows the existing pattern at `:450-498`, which calls the handler rather than restating its query.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`
- Integration tests pass, including both new route cases: `npm run test:integration`
- Deliberate-break check: removing the project term from the route makes the viewer-refusal case fail

#### Manual Verification:

- As the seeded Owner, the visual panel still renders side-by-side and difference images for a run with a baseline

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 4: Invite issue and acceptance

### Overview

Build the flow that creates non-Owner accounts: an Owner-only mutation returning a single-use link, and an ungated page that redeems it by setting the first password ever written by the running application.

### Changes Required:

#### 1. Invite token helpers

**File**: `src/server/auth/invite.ts` (new)

**Intent**: Generate and digest invite tokens using the idioms already in the codebase, so nothing new is introduced.

**Contract**: `createInviteToken(): { token, tokenHash }` using `randomBytes(32).toString("hex")` for the token and `createHash("sha256")` hex for the digest; `hashInviteToken(token): string` for lookup. Also exports the expiry window as a named constant. No timing-safe comparison is needed: lookup is an indexed equality on a digest of a 256-bit secret, and a miss reveals nothing a near-miss could exploit.

#### 2. Invite router

**File**: `src/server/api/routers/invite.ts` (new), registered in `src/server/api/root.ts`

**Intent**: Issue, list and revoke invites, all Owner-only.

**Contract**: Three procedures on `ownerProcedure` —
- `issue({ email, role, projectId? })`: validates that `viewer` carries a `projectId` and that the project belongs to the tenant; normalises the email with the same `trim().toLowerCase()` used at `scripts/seed-owner.ts:55` and `src/server/auth/config.ts:70`; refuses when a user with that email already exists; stores the row; **returns the raw token exactly once**.
- `list()`: pending invites for the tenant, never including `tokenHash`.
- `revoke({ inviteId })`: deletes one pending invite, tenant-scoped.

`issue` returns the token, not a URL — the caller builds the absolute link from the browser's own origin, which is why no base-URL env var is needed.

#### 3. Members and invites read model

**File**: `src/server/api/routers/invite.ts`

**Intent**: An Owner must be able to see who has access to what, which FR-005 implies and the members page needs.

**Contract**: `members()` on `ownerProcedure` returning each user in the tenant with their role and assigned project ids. `assign({ userId, projectId, assigned })` on `ownerProcedure` adds or removes one assignment row, refusing when the user is an Owner (Owners have implicit access and must not accumulate rows that imply otherwise) and when either id is outside the tenant.

#### 4. Invite acceptance page

**File**: `src/app/invite/[token]/page.tsx` (new)

**Intent**: The one ungated surface this slice adds. It must sit outside `src/app/(app)/` because the invitee has no session, and therefore inherits no gate — the same position the snapshot route is in.

**Contract**: A server component following the established page idiom: `searchParams: Promise<{ error?: string }>` awaited; an inline `"use server"` action; on failure `redirect` back with `?error=1`; one fixed-text `role="alert"` banner. The page resolves the invite by token hash and renders the form only when the invite exists and has not expired; otherwise it renders a single generic "This invite link is not valid" state that does not distinguish expired from consumed from never-existed. A visitor who already has a session is redirected to `/projects` rather than shown the form, mirroring the sign-in page's guard.

#### 5. Acceptance action

**File**: `src/app/invite/[token]/page.tsx`

**Intent**: Redeem the invite: create the account, grant what the invite names, consume the invite, and sign the user in.

**Contract**: Validates the password with zod at a 12-character minimum. In **one transaction**: insert the user with the normalised email, `hashPassword(password)`, the invite's `tenantId` and `role`; insert a `projectAssignments` row when the invite names a project; delete the invite row. Then calls `signIn("credentials", { … redirectTo: "/projects" })`, re-throwing the redirect and converting `AuthError` to `?error=1` exactly as `src/app/signin/page.tsx:25-32` does.

The transaction boundary is load-bearing: a crash between user creation and invite deletion would leave a consumed link that still reads as pending.

#### 6. Invite tests

**Files**: `src/server/auth/invite.test.ts` (new, unit), `src/server/api/routers/invite.test.ts` (new, integration)

**Intent**: Pin the token contract and the lifecycle rules.

**Contract**: Unit — a generated token and its stored hash differ; the same token always digests identically; the hash is 64 hex characters. Integration — issue returns a token that resolves; a second acceptance of the same token fails; an expired invite fails; a revoked invite fails; a viewer invite without a `projectId` is refused at issue; an invite for an existing email is refused at issue; acceptance produces a user whose role and assignment match the invite; and a non-Owner calling any invite procedure is refused. Naming must end in `.test.ts` under `src/server/api/**` so the integration config picks it up.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`
- Unit tests pass, including the token contract: `npm run test:unit`
- Integration tests pass, including the invite lifecycle: `npm run test:integration`
- The isolation completeness guard passes with all four invite procedures classified
- Deliberate-break check: removing the invite deletion from the accept transaction fails the single-use case

#### Manual Verification:

- Issuing an invite as the Owner produces a link that, opened in a private window, shows the password form
- Accepting the invite signs the new user in and lands them on the projects list
- Re-opening the same link after acceptance shows the generic invalid-invite state, not an error page

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 5: Members page and role-conditional UI

### Overview

Give the Owner a place to invite, assign and revoke, and stop showing every other role controls it cannot use. This adds the first navigation element the application has ever had.

### Changes Required:

#### 1. Members page

**File**: `src/app/(app)/team/page.tsx` (new)

**Intent**: The Owner's answer to "who has access to what", plus the invite and revoke controls.

**Contract**: A server component inside the `(app)` group, so it inherits the session and tenant gates. It refuses non-Owners with `notFound()`, matching the uniform 404 policy. Renders the member list with per-project assignment toggles, the pending invite list with revoke, and an invite form taking email, role, and — when the role is viewer — a project. Inline `"use server"` actions calling the Phase 4 procedures, `?error=1` on failure, one `role="alert"` banner.

Being under `(app)`, this page is automatically enrolled in `e2e/journeys/partial-account.spec.ts` and must render the no-workspace notice for an orphan account without a 5xx — which it inherits from the layout, provided the page does no database work before the layout's guard runs.

#### 2. Surfacing the invite link

**File**: `src/app/(app)/team/invite-link.tsx` (new, client component)

**Intent**: The raw token is returned exactly once. The Owner needs to copy it before it is gone.

**Contract**: A small client component that receives the token, composes the absolute URL from `window.location.origin`, displays it, and offers a copy control. It must make plain that the link is shown only once. No token is ever re-fetchable.

#### 3. Navigation to the members page

**File**: `src/app/(app)/projects/page.tsx`

**Intent**: An entry point for the members page, visible only to Owners.

**Contract**: A link added to the existing header block (`:28-49`), which already renders the signed-in email and sign-out. Placed here rather than in `(app)/layout.tsx` so the layout keeps its single responsibility as the gate; role comes from the page's own session-derived data.

#### 4. Role-conditional controls

**Files**: `src/app/(app)/projects/page.tsx`, `src/app/(app)/projects/[id]/page.tsx`, `src/app/(app)/projects/[id]/run-panel.tsx`, `src/app/(app)/projects/[id]/visual-panel.tsx`

**Intent**: Hide the four mutation controls from roles that cannot use them, so the UI stops offering actions the server will refuse.

**Contract**: The role reaches the client panels as a prop threaded from the server page — no new query and no client-side session read. "New project" and "Create your first project" render for Owners only; the empty state copy for a non-Owner says they have no projects assigned rather than inviting them to create one. "Run a check" renders when `canRunChecks(role)`. Baseline pinning and mask editing render for Owners only. **Hiding is presentation, not enforcement** — every one of these is already refused server-side by Phase 2, and the tests must assert the server refusal, not the hidden button.

#### 5. End-to-end journey

**File**: `e2e/journeys/invite-and-access.spec.ts` (new)

**Intent**: Prove the whole slice as a user experiences it, in one pass.

**Contract**: As the seeded Owner, invite a Client-viewer to one of two projects and capture the link. In a fresh browser context, accept the invite and set a password. Assert the viewer lands on the projects list showing exactly one project; that navigating directly to the other project's URL yields the not-found page; that no run-triggering or baseline control is present; and that a direct request to a snapshot URL from the other project returns 404. Use a timestamp-suffixed email so re-runs and parallel runs cannot collide.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`
- Unit tests pass: `npm run test:unit`
- Integration tests pass: `npm run test:integration`
- End-to-end tests pass, including the new journey and the auto-enrolled `/team` route in `partial-account.spec.ts`: `npm run test:e2e`
- Full suite green: `npm run test:all`

#### Manual Verification:

- As an Owner: invite a Team-member, assign them one of two projects, and confirm the members list reflects it
- As that Team-member: only the assigned project is listed, "Run a check" is present, and baseline and mask controls are not
- As a Client-viewer: only their project is listed, no write control is present anywhere, and the other project's URL is not found
- Revoking a pending invite makes its link stop working

**Implementation Note**: This is the final phase. Confirm the full manual matrix before closing the change.

---

## Testing Strategy

### Unit Tests

- Invite token generation and digest contract (`src/server/auth/invite.test.ts`)
- Role predicates — `isOwner`, `canRunChecks`, `canConfigureProject` — across all three roles
- Default-role resolution for a row whose `role` was never set

### Integration Tests

- The within-tenant authorization matrix: three roles × two projects × every project- and run-scoped procedure (`src/server/api/within-tenant-access.test.ts`)
- Invite lifecycle: issue, accept, expire, revoke, double-accept, duplicate email, viewer-without-project
- Snapshot route: viewer refused another project's bytes, allowed their own
- The generated cross-tenant suite, extended with the new procedures and the Owner-only case kind

### Manual Testing Steps

1. Sign in as the seeded Owner; confirm nothing about the existing experience has changed.
2. Invite a Team-member; copy the link; accept it in a private window; set a password.
3. As the Team-member, confirm only assigned projects appear and only `Run a check` is offered.
4. As the Owner, assign a second project; confirm it appears for the Team-member on reload — proving per-request resolution, not a stale token.
5. Invite a Client-viewer to one project; accept; confirm one project, no write controls, and 404 at a sibling project's URL.
6. Copy a snapshot image URL from the Owner's session; request it as the Client-viewer; confirm 404.
7. Revoke a pending invite; confirm the link no longer works.

## Performance Considerations

The second per-request query applies only to non-Owners; an Owner's request cost is unchanged. The assignment lookup is a single indexed read on `(userId)` returning at most the tenant's project count — single digits for the sizing this product targets (3–10 projects). `assertProjectAccess` adds one indexed read per procedure call for non-Owners, and for Owners collapses into the project-existence check that four procedures were missing anyway.

## Migration Notes

The schema is push-based with no migrations directory; both test harnesses apply it with `drizzle-kit push --force`. The only column added to a populated table is `users.role`, which carries a database-level default so existing rows resolve as `owner` without a backfill. The two new tables start empty. Nothing in this slice is destructive and no data is rewritten.

## References

- Research: `context/changes/roles-invites-and-client-access/research.md`
- Predecessor F-01: `context/archive/2026-08-21-tenant-scoped-owner-signin/plan.md`
- Auth behaviours to match: `context/archive/2026-08-25-auth-and-abuse-behaviours/plan.md`
- Isolation test pattern: `src/server/api/tenant-isolation.test.ts:183-434`
- Page + server action idiom: `src/app/signin/page.tsx:6-33`
- Email normalisation invariant: `scripts/seed-owner.ts:50-55`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema and per-request resolution

#### Automated

- [x] 1.1 Schema applies cleanly to a populated database: `npm run db:push` — f8d06ac
- [x] 1.2 Type checking passes: `npm run typecheck` — f8d06ac
- [x] 1.3 Linting and formatting pass: `npm run check` — f8d06ac
- [x] 1.4 Unit tests pass: `npm run test:unit` — f8d06ac
- [x] 1.5 Integration tests pass unchanged: `npm run test:integration` — f8d06ac
- [x] 1.6 A new unit test asserts every existing user row resolves as `owner` when `role` is unset — f8d06ac

#### Manual

- [ ] 1.7 Signing in as the seeded owner still reaches the projects list with every project visible
- [ ] 1.8 `npm run db:studio` shows the three new/changed structures with the expected columns and constraints

### Phase 2: tRPC enforcement

#### Automated

- [x] 2.1 Type checking passes: `npm run typecheck` — e3f370a
- [x] 2.2 Linting passes: `npm run check` — e3f370a
- [x] 2.3 Unit tests pass: `npm run test:unit` — e3f370a
- [x] 2.4 Integration tests pass, including the new matrix: `npm run test:integration` — e3f370a
- [x] 2.5 The isolation completeness guard passes with every new procedure classified — e3f370a
- [x] 2.6 Deliberate-break check: removing one `assertProjectAccess` call fails the within-tenant matrix by name — e3f370a

#### Manual

- [ ] 2.7 Signing in as the seeded Owner shows every project and every control exactly as before this phase

### Phase 3: The enforcement point outside tRPC

#### Automated

- [x] 3.1 Type checking passes: `npm run typecheck` — 5ae2808
- [x] 3.2 Linting passes: `npm run check` — 5ae2808
- [x] 3.3 Integration tests pass, including both new route cases: `npm run test:integration` — 5ae2808
- [x] 3.4 Deliberate-break check: removing the project term from the route makes the viewer-refusal case fail — 5ae2808

#### Manual

- [ ] 3.5 As the seeded Owner, the visual panel still renders side-by-side and difference images for a run with a baseline

### Phase 4: Invite issue and acceptance

#### Automated

- [x] 4.1 Type checking passes: `npm run typecheck` — 1af470a
- [x] 4.2 Linting passes: `npm run check` — 1af470a
- [x] 4.3 Unit tests pass, including the token contract: `npm run test:unit` — 1af470a
- [x] 4.4 Integration tests pass, including the invite lifecycle: `npm run test:integration` — 1af470a
- [x] 4.5 The isolation completeness guard passes with all four invite procedures classified — 1af470a
- [x] 4.6 Deliberate-break check: removing the invite deletion from the accept transaction fails the single-use case — 1af470a

#### Manual

- [ ] 4.7 Issuing an invite as the Owner produces a link that, opened in a private window, shows the password form
- [ ] 4.8 Accepting the invite signs the new user in and lands them on the projects list
- [ ] 4.9 Re-opening the same link after acceptance shows the generic invalid-invite state, not an error page

### Phase 5: Members page and role-conditional UI

#### Automated

- [x] 5.1 Type checking passes: `npm run typecheck`
- [x] 5.2 Linting passes: `npm run check`
- [x] 5.3 Unit tests pass: `npm run test:unit`
- [x] 5.4 Integration tests pass: `npm run test:integration`
- [x] 5.5 End-to-end tests pass, including the new journey and the auto-enrolled `/team` route: `npm run test:e2e`
- [x] 5.6 Full suite green: `npm run test:all`

#### Manual

- [ ] 5.7 As an Owner: invite a Team-member, assign them one of two projects, and confirm the members list reflects it
- [ ] 5.8 As that Team-member: only the assigned project is listed, "Run a check" is present, baseline and mask controls are not
- [ ] 5.9 As a Client-viewer: only their project is listed, no write control is present, and the other project's URL is not found
- [ ] 5.10 Revoking a pending invite makes its link stop working
