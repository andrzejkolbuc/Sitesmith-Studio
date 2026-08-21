# Tenant-scoped Records and Owner Sign-in Implementation Plan

## Overview

Make tenancy an enforced property of every data access path, and give an Owner a way to sign
in. This is roadmap item F-01, sequenced first because retrofitting tenant scoping onto
existing domain tables is a migration rather than an edit — and S-01 creates the first domain
tables.

## Current State Analysis

The application is a freshly scaffolded T3 app (Next 16, tRPC, Drizzle on Postgres, NextAuth
with credentials). Sign-in *logic* exists and is verified, but nothing else does.

- **Identity works; tenancy does not exist.** `protectedProcedure`
  (`src/server/api/trpc.ts:121`) guarantees `ctx.session.user` is present and stops there.
  `ctx.db` is the raw Drizzle client, so nothing structurally prevents an unscoped query.
- **The scaffold ships the exact bug this change prevents.** `postRouter.getLatest`
  (`src/server/api/routers/post.ts:26`) is a `findFirst` with no owner or tenant filter behind
  `protectedProcedure` — it returns any post belonging to anyone. It is also the only worked
  router example in the tree, so every future router will be pattern-matched against it.
- **No account can be created.** `users.passwordHash` is nullable and no code path writes it.
  Sign-in is implemented against a row that nothing produces.
- **Sessions are JWT, and revocation is already gone.** Credentials sign-in forces
  `session: { strategy: "jwt" }` (`src/server/auth/config.ts`), so deleting a row cannot end a
  session. This constrains where tenant identity may live.
- **Schema is Auth.js tables plus a scaffold demo.** `users`, `accounts`, `sessions`,
  `verificationTokens`, `posts`. No domain tables exist.
- **There is no test infrastructure.** No runner, no test database, no fixtures.

## Desired End State

An Owner can sign in and see the projects belonging to their tenant, and cannot see any other
tenant's projects — enforced at the procedure boundary rather than by per-query discipline, and
proven by an automated test that fails if a future router forgets.

Verify by: running the seed command to create two tenants, signing in as each, and observing
each sees only its own project; and by the cross-tenant integration test passing.

### Key Discoveries:

- `src/server/api/trpc.ts:121` — `protectedProcedure` is the extension point; the new
  tenant-aware procedure builds on it rather than replacing it.
- `src/server/api/routers/post.ts:26` — unscoped `findFirst` demonstrating the failure mode.
- `src/server/auth/config.ts` — `jwt` and `session` callbacks already thread `user.id` through;
  the tenant is deliberately *not* joining it (see Implementation Approach).
- `src/server/auth/password.ts` — `hashPassword` already exists and is runtime-verified; the
  seed command reuses it rather than introducing a second hashing path.
- `src/server/db/schema.ts` — `createTable` applies the `sitesmith-studio_` prefix; new tables
  must go through it or they will not be found by the existing Drizzle client.
- Drizzle is push-based (`db:push`, no migrations directory), so schema changes apply directly.

## What We're NOT Doing

- **Roles.** No `role` column, no Team-member, no Client-viewer. That is roadmap item S-10.
- **Invites.** No invite tokens, no invite acceptance, no email. Also S-10.
- **Public registration.** Deliberately absent; accounts are invite-only per the PRD.
- **Password reset, email verification, account settings.** Not required by any F-01 requirement.
- **Project creation or configuration.** The projects list is read-only here; creating and
  configuring projects is FR-006/FR-007 in S-01.
- **Row-level security in Postgres.** Considered and deferred — see Implementation Approach.
- **Session revocation.** Already lost to the JWT strategy; restoring it is out of scope.
- **Styling beyond legibility.** The sign-in form and project list use existing Tailwind
  conventions; visual design is not a goal of a foundation.

## Implementation Approach

Tenancy is enforced at the tRPC procedure boundary. A new `tenantProcedure` extends
`protectedProcedure`, resolves the caller's tenant from their user id on each request, and
exposes a query helper already constrained to that tenant. A router that uses it gets scoping
by construction; a router that reaches past it to `ctx.db` is doing something visibly unusual
and is caught in review.

Three decisions shape this and are worth stating explicitly, because each had a defensible
alternative:

**The tenant is resolved per request, not carried in the session token.** The token route is
free at request time and the `jwt` callback already exists — but credentials sign-in forced JWT
sessions, which means there is no way to revoke a token early. A tenant claim baked into a
token would therefore stay wrong until expiry, compounding the revocation gap rather than
containing it. One indexed lookup per request is the cheaper mistake at single-digit users.

**Enforcement is a procedure convention, not row-level security.** RLS would make cross-tenant
reads impossible rather than merely hard, which is the stronger answer to a binary commitment.
It was rejected for now on cost: it needs per-request session variables on a pooled connection,
and the push-based Drizzle workflow does not manage policies, so the SQL would be hand-
maintained. The procedure boundary plus the isolation test in Phase 5 is the proportionate
answer at this scale. If tenancy ever needs to survive an untrusted contributor rather than a
forgetful one, RLS is the upgrade path and this design does not block it.

**A user belongs to exactly one tenant.** A join table would let one person serve two agencies
without duplicate accounts — but that is the multi-agency capability the PRD explicitly cut when
it dropped the platform-admin role as "scope from a product I'm not building". A column keeps
every scoping check a single join-free comparison.

## Critical Implementation Details

**Nullable tenant column, enforced in code.** `users.tenantId` is nullable at the database level
even though the application treats it as required. The Auth.js Drizzle adapter's `createUser`
path knows nothing about tenants; a `NOT NULL` column would break the first federated provider
anyone adds, at the moment they add it. The tenant resolver instead treats a user with no tenant
as forbidden, so the invariant holds at the boundary where it matters. Do not "fix" the column
to `NOT NULL` without also handling adapter-created users.

**Deleting the demo router is load-bearing, not tidying.** `posts` and `postRouter` are removed
in Phase 2 rather than left alone, because `getLatest` is the only worked router example in the
tree and it models exactly the unscoped access this change exists to prevent. Leaving it means
the next router is written by copying it.

**Seed before UI.** Phase 3 (seed command) precedes Phase 4 (sign-in page) because there is
otherwise no account to sign in with, and the sign-in page cannot be manually verified.

## Phase 1: Tenant and project schema

### Overview

Introduce the tenant as a first-class row, attach users to it, and create a minimally-scoped
projects table for S-01 to build on.

### Changes Required:

#### 1. Tenant table and user attachment

**File**: `src/server/db/schema.ts`

**Intent**: Add a `tenants` table representing one agency, and attach each user to at most one
tenant. This is the row every other scoped table will point at.

**Contract**: New `tenants` table via the existing `createTable` helper (so it receives the
`sitesmith-studio_` prefix): id (uuid-defaulted varchar, matching the `users.id` convention),
name, createdAt. New `users.tenantId` column referencing `tenants.id` — **nullable**, for the
adapter reason in Critical Implementation Details — plus an index, since it is read on every
request.

#### 2. Projects table

**File**: `src/server/db/schema.ts`

**Intent**: Create the projects table now, scoped from birth, so S-01 adds columns to a correct
table instead of creating the first domain table itself.

**Contract**: New `projects` table: id, `tenantId` (not null, references `tenants.id`), name,
createdAt, updatedAt. Index on `tenantId`. Deliberately minimal — start URL, crawl scope and
language-variant configuration are FR-007/FR-008 and belong to S-01. Add Drizzle relations for
tenant→users and tenant→projects so scoped queries can traverse without manual joins.

### Success Criteria:

#### Automated Verification:

- Schema pushes cleanly: `npm run db:push`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`

#### Manual Verification:

- `tenants` and `projects` tables exist in the database with the `sitesmith-studio_` prefix
- `users.tenantId` exists, is nullable, and has an index
- `projects.tenantId` is NOT NULL and carries a foreign key to `tenants.id`

**Implementation Note**: After completing this phase and all automated verification passes,
pause here for manual confirmation from the human that the manual testing was successful before
proceeding to the next phase.

---

## Phase 2: Tenant-scoped access layer

### Overview

Make scoping the default path through the API, and remove the example that models the opposite.

### Changes Required:

#### 1. Tenant resolution in the request context

**File**: `src/server/api/trpc.ts`

**Intent**: Resolve the caller's tenant once per request so procedures do not each re-derive it.

**Contract**: Extend `createTRPCContext` to look up the signed-in user's `tenantId` by user id
and expose it on the context. Unauthenticated requests resolve to no tenant rather than
throwing — `publicProcedure` must keep working.

#### 2. tenantProcedure and the scoped query helper

**File**: `src/server/api/trpc.ts`

**Intent**: Provide the single procedure every domain router will build on, so tenant filtering
is inherited rather than remembered.

**Contract**: `tenantProcedure` extends `protectedProcedure` with a middleware that rejects a
caller whose tenant is absent (`FORBIDDEN`, distinct from `protectedProcedure`'s `UNAUTHORIZED`
so the two failures stay diagnosable) and narrows the context type so `ctx.tenantId` is
non-nullable downstream. Alongside it, expose a helper that returns a tenant-equality condition
for a given table's `tenantId` column, so routers compose it into `where` clauses rather than
writing the comparison by hand.

#### 3. Remove the scaffold demo router

**Files**: `src/server/api/routers/post.ts`, `src/server/api/root.ts`,
`src/server/db/schema.ts`, `src/app/_components/post.tsx`, `src/app/page.tsx`

**Intent**: Delete the demo `post` router, its table, and the component rendering it. It is the
only worked router example in the tree and it performs exactly the unscoped read this change
exists to make hard.

**Contract**: `postRouter` removed from `appRouter`; `posts` table and its relations removed
from the schema; the demo component deleted and its usage removed from the home page. The home
page keeps rendering — reduce it to a minimal landing that links to sign-in.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`
- Build succeeds: `npm run build`
- Schema pushes cleanly after the posts table is dropped: `npm run db:push`
- No reference to `postRouter` or `posts` remains: `grep -r "postRouter\|posts" src/`

#### Manual Verification:

- Home page renders without errors after the demo component is removed
- A procedure built on `tenantProcedure` refuses a session whose user has no tenant

**Implementation Note**: After completing this phase and all automated verification passes,
pause here for manual confirmation from the human that the manual testing was successful before
proceeding to the next phase.

---

## Phase 3: Owner seed command

### Overview

Create the first account. Until this exists, sign-in cannot be exercised at all.

### Changes Required:

#### 1. Seed script

**File**: `scripts/seed-owner.ts` (new)

**Intent**: Create a tenant and an Owner user inside it, hashing the password with the existing
helper so there is exactly one hashing path in the codebase.

**Contract**: Reads tenant name, owner email and password from arguments or environment.
Normalises the email the same way sign-in does (trim, lowercase) — a mismatch here produces an
account that exists but can never authenticate, which is a confusing failure to debug. Creates
tenant then user in that order, sets `passwordHash` via `hashPassword`, and is idempotent on
email: re-running with an existing address updates the password rather than violating the unique
constraint.

#### 2. Script wiring

**File**: `package.json`

**Intent**: Make the seed runnable without remembering a loader invocation.

**Contract**: Add a `db:seed-owner` script. The project has no TypeScript runner in
`devDependencies` — either add one or write the script so `node` can execute it directly. Prefer
whichever keeps the dependency count lower.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`
- Seed runs without error against the local database
- Re-running the seed with the same email does not error

#### Manual Verification:

- A `tenants` row and a `users` row exist, linked, with a non-null `passwordHash`
- Running the seed twice leaves exactly one user for that email

**Implementation Note**: After completing this phase and all automated verification passes,
pause here for manual confirmation from the human that the manual testing was successful before
proceeding to the next phase.

---

## Phase 4: Sign-in and project list

### Overview

The first user-visible surface: sign in, land on a list of your tenant's projects, and be
redirected there from anywhere gated.

### Changes Required:

#### 1. Sign-in page

**File**: `src/app/signin/page.tsx` (new)

**Intent**: Give the Owner a form to authenticate with, wired to the existing credentials
provider.

**Contract**: Email and password fields posting through NextAuth's credentials sign-in. On
failure it renders one non-specific message — the authorize callback deliberately makes an
unknown address and a wrong password indistinguishable, and the UI must not undo that by
distinguishing them. On success it redirects to the projects list.

#### 2. Projects list page

**File**: `src/app/projects/page.tsx` (new)

**Intent**: Prove end-to-end that a signed-in Owner reads their own tenant's data and nothing
else.

**Contract**: Server component reading through a new `project.list` procedure built on
`tenantProcedure`. Renders project names, and an empty state explaining that projects are
created later — the list is legitimately empty until S-01.

#### 3. Projects router

**File**: `src/server/api/routers/project.ts` (new), `src/server/api/root.ts`

**Intent**: The first real domain router, and the reference example future routers copy —
replacing the demo router deleted in Phase 2.

**Contract**: `projectRouter` with a single `list` query on `tenantProcedure`, filtered by the
tenant condition helper. Registered on `appRouter`. Read-only; creation is S-01.

#### 4. Gated-route behaviour

**File**: `src/middleware.ts` (new) or per-page guard

**Intent**: Decide what an unauthenticated visitor sees at a gated route — PRD Open Question 7,
which the roadmap assigned to this change.

**Contract**: An unauthenticated request to a gated route redirects to the sign-in page rather
than rendering a 403 or a not-found. Rationale: an invite-only product has no public surface to
protect the existence of, and a redirect is the least confusing outcome for a client contact
following a stale link. Gated routes are everything except the home page and the sign-in page.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`
- Build succeeds: `npm run build`

#### Manual Verification:

- Signing in with the seeded Owner's credentials succeeds and lands on the projects list
- Signing in with a wrong password shows one generic failure message, not a specific one
- Visiting the projects list while signed out redirects to sign-in
- After signing in, the projects list shows only that tenant's projects

**Implementation Note**: After completing this phase and all automated verification passes,
pause here for manual confirmation from the human that the manual testing was successful before
proceeding to the next phase.

---

## Phase 5: Cross-tenant isolation test

### Overview

Turn the isolation commitment from a review responsibility into an automated one. This phase
introduces the project's first test infrastructure.

### Changes Required:

#### 1. Test runner and database strategy

**Files**: `vitest.config.ts` (new), `package.json`

**Intent**: Establish how tests run and where they get a database, so later slices inherit a
working setup instead of inventing one.

**Contract**: Add a test runner and a `test` script. Integration tests need a real Postgres —
reuse the existing dev container against a separate database name rather than introducing new
infrastructure. Tests must reset the tables they touch between runs so ordering cannot make a
passing suite lie.

#### 2. Cross-tenant isolation test

**File**: `src/server/api/routers/project.test.ts` (new)

**Intent**: Assert the property this entire change exists to guarantee, in a form that fails
automatically if a future router forgets to scope.

**Contract**: Seed two tenants, each with one project. Build a tRPC caller for tenant A's owner
and assert `project.list` returns only tenant A's project. Build a caller for tenant B and assert
the same in reverse. Also assert that a session whose user has no tenant is rejected with
`FORBIDDEN`. Use `createCaller` (already exported from `src/server/api/root.ts`) with a
fabricated session rather than driving HTTP — the boundary under test is the procedure, not the
transport.

### Success Criteria:

#### Automated Verification:

- Test suite runs: `npm run test`
- Cross-tenant isolation test passes
- Tenantless-session test passes
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run check`

#### Manual Verification:

- Deliberately breaking the scoping in `project.list` makes the isolation test fail — confirming
  the test actually guards the boundary rather than passing vacuously
- Test run leaves the development database usable

**Implementation Note**: After completing this phase and all automated verification passes,
pause here for manual confirmation from the human that the manual testing was successful. This
is the final phase.

---

## Testing Strategy

### Unit Tests:

- Not the focus of this change. The one pure function worth covering, password hashing, is
  already runtime-verified and unchanged here.

### Integration Tests:

- Cross-tenant read isolation through `project.list` — the load-bearing test.
- A session whose user has no tenant is rejected with `FORBIDDEN`, not silently given an empty
  list. An empty list would be indistinguishable from a legitimately empty tenant.

### Manual Testing Steps:

1. Run `npm run db:push`, then seed two tenants with different owners.
2. Sign in as the first owner; confirm the projects list shows only that tenant's project.
3. Sign out, sign in as the second owner; confirm the same in reverse.
4. While signed out, visit the projects list directly; confirm the redirect to sign-in.
5. Sign in with a correct email and wrong password; confirm the error message does not reveal
   that the address exists.
6. Temporarily remove the tenant filter from `project.list` and confirm the isolation test fails.

## Performance Considerations

One additional indexed lookup per authenticated request, to resolve the tenant. Negligible at the
PRD's stated scale of single-digit users, and the index added in Phase 1 keeps it constant-time.
If request volume ever makes this measurable, the alternative already considered — a tenant claim
in the session token — becomes worth revisiting, but only alongside a solution to the revocation
gap it would widen.

## Migration Notes

Drizzle is push-based with no migrations directory, so schema changes apply directly via
`npm run db:push`. Two changes are destructive and worth doing knowingly:

- Dropping the `posts` table removes the scaffold demo data. Nothing depends on it.
- `users.tenantId` is added nullable, so existing rows are unaffected. The seeded Owner is the
  only user, and the seed sets it.

There is no production deployment yet, so no rollback plan beyond re-running `db:push` against a
corrected schema.

## References

- Roadmap item: `context/foundation/roadmap.md` § F-01
- Product requirements: `context/foundation/prd.md` — FR-002, FR-006, FR-009, NFR-2, Access Control
- Stack decisions: `context/foundation/tech-stack.md`
- Existing procedure pattern: `src/server/api/trpc.ts:111-133`
- Anti-pattern being removed: `src/server/api/routers/post.ts:26`
- Password hashing helper reused by the seed: `src/server/auth/password.ts`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Tenant and project schema

#### Automated

- [ ] 1.1 Schema pushes cleanly: `npm run db:push`
- [ ] 1.2 Type checking passes: `npm run typecheck`
- [ ] 1.3 Linting passes: `npm run check`

#### Manual

- [ ] 1.4 `tenants` and `projects` tables exist with the `sitesmith-studio_` prefix
- [ ] 1.5 `users.tenantId` exists, is nullable, and has an index
- [ ] 1.6 `projects.tenantId` is NOT NULL with a foreign key to `tenants.id`

### Phase 2: Tenant-scoped access layer

#### Automated

- [ ] 2.1 Type checking passes: `npm run typecheck`
- [ ] 2.2 Linting passes: `npm run check`
- [ ] 2.3 Build succeeds: `npm run build`
- [ ] 2.4 Schema pushes cleanly after the posts table is dropped: `npm run db:push`
- [ ] 2.5 No reference to `postRouter` or `posts` remains in `src/`

#### Manual

- [ ] 2.6 Home page renders without errors after the demo component is removed
- [ ] 2.7 A `tenantProcedure` refuses a session whose user has no tenant

### Phase 3: Owner seed command

#### Automated

- [ ] 3.1 Type checking passes: `npm run typecheck`
- [ ] 3.2 Linting passes: `npm run check`
- [ ] 3.3 Seed runs without error against the local database
- [ ] 3.4 Re-running the seed with the same email does not error

#### Manual

- [ ] 3.5 A `tenants` row and a linked `users` row exist with a non-null `passwordHash`
- [ ] 3.6 Running the seed twice leaves exactly one user for that email

### Phase 4: Sign-in and project list

#### Automated

- [ ] 4.1 Type checking passes: `npm run typecheck`
- [ ] 4.2 Linting passes: `npm run check`
- [ ] 4.3 Build succeeds: `npm run build`

#### Manual

- [ ] 4.4 Signing in with the seeded Owner succeeds and lands on the projects list
- [ ] 4.5 A wrong password shows one generic failure message, not a specific one
- [ ] 4.6 Visiting the projects list while signed out redirects to sign-in
- [ ] 4.7 The projects list shows only the signed-in tenant's projects

### Phase 5: Cross-tenant isolation test

#### Automated

- [ ] 5.1 Test suite runs: `npm run test`
- [ ] 5.2 Cross-tenant isolation test passes
- [ ] 5.3 Tenantless-session test passes
- [ ] 5.4 Type checking passes: `npm run typecheck`
- [ ] 5.5 Linting passes: `npm run check`

#### Manual

- [ ] 5.6 Deliberately breaking the scoping in `project.list` makes the isolation test fail
- [ ] 5.7 Test run leaves the development database usable
