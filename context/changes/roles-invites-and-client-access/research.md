---
date: 2026-09-08T13:10:04+02:00
researcher: Andrzej Kolbuc
git_commit: ca1614f622410287a0ab121351897f5d25ba35e1
branch: master
repository: Sitesmith-Studio
topic: "Roles, invites and client access (S-10) — authorization model and route gating"
tags: [research, codebase, auth, tenancy, authorization, roles, access-control, s-10]
status: complete
last_updated: 2026-09-08
last_updated_by: Andrzej Kolbuc
---

# Research: Roles, invites and client access (S-10)

**Date**: 2026-09-08T13:10:04+02:00
**Researcher**: Andrzej Kolbuc
**Git Commit**: `ca1614f622410287a0ab121351897f5d25ba35e1`
**Branch**: `master`
**Repository**: Sitesmith-Studio (no git remote configured — references below are local paths, not permalinks)

## Research Question

What exists in the codebase today that S-10 (`roles-invites-and-client-access`) must extend, specifically covering (a) the authorization model and (b) route gating and UI, with an active audit of whether the NFR-2 isolation guarantee currently holds?

Scope was set deliberately: **authorization model** and **route gating / UI** were selected as the research dimensions; **invite mechanics** (token issuance, delivery, acceptance) was excluded and remains for planning. The isolation guarantee was treated as an audit, not a map.

## Summary

**The product has exactly one authorization axis today: tenant.** A user is bound to a tenant by a single nullable column, `users.tenantId` (`src/server/db/schema.ts:84`). There is no role column anywhere, no user-to-project join table, and no code path that asks "may this user see *this project*" — only "does this row belong to the caller's tenant". Everything inside a tenant is fully visible and fully mutable by every user in it.

**S-10 therefore introduces project-level authorization rather than extending it.** This is the most important finding, and it reframes the slice: the roadmap describes S-10 as completing the account model F-01 opened, but F-01 built a one-dimensional model and S-10 adds a second dimension that has no slot in any of the 20 existing query sites.

**The isolation guarantee holds today.** An active audit of all 11 non-test database access sites found **zero gaps** — no IDOR, no post-fetch JavaScript ownership check, no scoping from a client-supplied value, no filter on the unscoped side of a join, and uniform existence concealment (a foreign id and a nonexistent id are indistinguishable on every surface). The snapshot byte route, the prime suspect because it inherits no tRPC middleware, calls `auth()` itself and resolves tenancy from the session (`src/app/api/snapshots/[snapshotId]/route.ts:53-61`).

**Three structural facts shape the work:**

1. **The tRPC surface is centralised; everything else is not.** One context resolver, one builder (`tenantProcedure`), one predicate helper (`tenantScope`), 15 procedures composing it identically. But four *other* hand-written spellings of the tenant check live outside tRPC and inherit nothing — the snapshot route, the crawl engine, retention, and the route-group layout.
2. **Two test harnesses will force S-10 to declare itself.** The tenant-isolation suite reflects over `appRouter` and fails while any procedure is unclassified (`src/server/api/tenant-isolation.test.ts:419`); the partial-account E2E spec derives gated routes from the filesystem, so any new page under `(app)/` is auto-enrolled (`e2e/journeys/partial-account.spec.ts:34-59`).
3. **There is no UI shell to hang role-conditional chrome on.** `(app)/layout.tsx` returns bare `{children}` (`src/app/(app)/layout.tsx:57`).

**Open Question 7 is half-answered, and the answered half was never written down.** F-01 decided, implemented and tested "unauthenticated visitor at a gated route → redirect to sign-in", but neither the PRD nor the roadmap records the resolution. The genuinely undecided half — what an *authenticated but unauthorised* user sees — has no recorded decision anywhere, and it is exactly the case S-10 creates.

## Detailed Findings

### 1. The authorization model as it stands

#### Schema

Tenant-stamped domain tables: `projects`, `runs`, `pages`, `pageObservations`, `pageSnapshots`, `findings` — each carries `tenantId varchar(255) notNull references(tenants.id)` plus a `*_tenant_id_idx` index. Only `projects.id` and `runs.projectId` (`src/server/db/schema.ts:268`) carry a project identifier; everything below `runs` reaches a project transitively through `runId`.

- **No `role` column exists on any table.**
- **No user-to-project edge exists.** `usersRelations` (`schema.ts:89-95`) has `accounts` and `tenant` only; `projectsRelations` (`schema.ts:240-246`) has `tenant` and `runs` only.
- `users.tenantId` is **nullable by design**, with an explicit instruction not to "fix" it (`schema.ts:74-83`) — the Auth.js adapter's `createUser` knows nothing about tenants.
- `users.passwordHash` is **nullable, and the comment says why**: "a user invited but who has not yet set a password has none" (`schema.ts:68-73`). This is an invite seam written into the schema before invites exist.
- `verificationTokens` (`schema.ts:757-765`) exists, is unused, and has a composite PK `(identifier, token)` — the natural home for invite tokens if reused rather than replaced.
- No migrations directory; Drizzle is push-based (`db:push`). Adding a `NOT NULL` column to a populated table repeats a trap already documented at `schema.ts:210-215` — a `$defaultFn` default leaves existing rows violating the constraint, so a database-level `.default()` was used instead.

#### Session

Strategy is **JWT**, not database (`src/server/auth/config.ts:111`) — forced by credentials sign-in. The token carries only `token.id` (`config.ts:113-116`); the session is `{ user: { id, name, email, image }, expires }` and nothing more. **No tenant identifier ever enters the session.**

That is a deliberate decision with a written rationale (`src/server/api/trpc.ts:38-48`, `config.ts:103-110`): a claim baked into an unrevocable JWT "would therefore stay wrong until expiry, widening the revocation gap". The tenant is re-read from the database on every request instead.

The one literal role seam in the codebase is a commented-out line inside the `declare module "next-auth"` block: `// role: UserRole;` (`config.ts:27`).

#### tRPC layer

Exactly three procedure builders:

| Builder | Line | Enforces | Adds to `ctx` |
|---|---|---|---|
| `publicProcedure` | `trpc.ts:139` | timing only | — |
| `protectedProcedure` | `trpc.ts:149-161` | `UNAUTHORIZED` if no session user | non-nullable `session` |
| `tenantProcedure` | `trpc.ts:180-194` | the above, then `FORBIDDEN` if no `ctx.tenantId` | non-nullable `tenantId` |

`publicProcedure` and `protectedProcedure` are used by **zero routers** — `protectedProcedure` exists solely as `tenantProcedure`'s base. All 15 procedures in `project.ts` are on `tenantProcedure`.

The single predicate helper is `tenantScope` (`trpc.ts:217-220`), which takes the **table**, not a column — a deliberate fix from F-01's implementation review, so that passing a column, or a table without a tenant column, fails to compile. This signature is the natural pattern for any project-scoping helper S-10 adds.

#### The 15 procedures and their predicates

All on `tenantProcedure`; all tenant-equality only. The four **mutations** are the complete set of role-gatable write operations in the application:

- `create` (`project.ts:65`) — stamps `tenantId: ctx.tenantId`; input schema has no `tenantId` field
- `startRun` (`project.ts:102`) — delegates the check to `src/server/crawl/run.ts:105-108`
- `pinBaseline` (`project.ts:133`) — the sharpest case: two foreign ids pointed at each other, both independently re-scoped, run additionally pinned to project
- `setMasks` (`project.ts:205`)

**There is no delete procedure at all.** "Owner can delete projects" is entirely net-new surface and will be the first procedure needing an Owner-only builder.

Four reads filter by `projectId`/`runId` **without** verifying the project exists for the tenant, returning empty rather than `NOT_FOUND`: `latestRun` (`:240`), `runs` (`:292`), `trend` (`:393`), `runPages` (`:583`). Safe today because the rows themselves carry `tenantId`; but project-level authorization means these four need an explicit project check they do not currently have.

`list` (`project.ts:45`) returns every project in the tenant. It is the one procedure whose **result set changes shape for all three roles**.

### 2. Isolation audit — the guarantee holds

Verdict: **no confirmed gaps, no unclear cases.** Every surface re-establishes tenancy from the session, and no failure scenario of the form "user A in tenant T1 calls X with parameter P belonging to T2" could be constructed.

Specific mistake classes probed and found absent:

- **Classic IDOR** — every one of the 15 procedures and all 5 snapshot-route queries pair the client id with a tenant predicate inside the same `and(...)`.
- **Filter on the unscoped side of a join** — the expected failure. Absent: `runObservations` (`project.ts:484`), `runSnapshots` (`project.ts:523-547`) and the snapshot baseline join (`route.ts:113-128`) all join `pages` unscoped but filter on the scoped side.
- **Post-fetch JS ownership check** — absent. The predicate is always in the query, so a foreign row is never materialised in server memory.
- **Scoping from a client-supplied value** — absent. `tenantId` has exactly two origins, both server-derived: `trpc.ts:49-57` and `route.ts:57-61`.
- **Existence disclosure** — uniform. Foreign id and nonexistent id are indistinguishable everywhere.

One unscoped `where` exists — `route.ts:92-95`, fetching a page's URL by `snapshot.pageId`. It is **not** reachable: `snapshot.pageId` comes from a row already proven to be the caller's, the FK is `notNull`, and every write stamps `tenantId` from a verified project (`run.ts:225, 395, 539, 564`). The value is only used to match a baseline inside a query already pinned to `user.tenantId`. Rated SAFE rather than hedged.

`sweepStaleRuns` (`run.ts:691`) is deliberately cross-tenant, takes no user input, is called only from `src/instrumentation.ts:19` at process boot, and returns a count. No row content crosses a boundary.

**The caveat that matters for S-10:** this clean result is a statement about a one-role world. Every predicate audited answers *which tenant*. The moment a Client-viewer is restricted to a subset of their own tenant's projects, none of these 20 query sites has a slot for the second predicate — see §4(L) for the concrete instance.

### 3. Route gating and the UI surface

#### There is no middleware

`find` across the tree (excluding `node_modules`) returns no `middleware.*`. This is deliberate and documented at `src/app/(app)/layout.tsx:30-32`: "the auth configuration pulls in the Postgres driver through the database adapter, which does not run in the edge runtime Next uses for middleware by default."

**Consequence: every gate is per-surface.** A page inside `src/app/(app)/` inherits the session and tenant checks structurally. A page outside it inherits nothing. **A route handler inherits nothing regardless of location** — `/api/snapshots/[snapshotId]` is the existing proof, having had to write its own session lookup, tenant lookup, and scoped query.

#### The one gate

`src/app/(app)/layout.tsx:39-40` is `const session = await auth(); if (!session?.user) redirect("/signin");`

`redirect()` is called with a bare path — **no `callbackUrl`, no `?from=`**. The intended destination is discarded; after signing in the user lands on `/projects` unconditionally (`src/app/signin/page.tsx:23`).

The second condition re-reads `tenantId` from the database rather than trusting the session (`layout.tsx:48-55`) and renders `NoTenantNotice` — a rendered page, not a redirect. This was added by F-01's implementation review as Fix A.

#### What a visitor sees today, by case

| Case | Visitor sees |
|---|---|
| Unauthenticated, gated route | Redirect to `/signin`; no message, no memory of destination |
| Authenticated, no tenant | "This account has no workspace" + Sign out (`layout.tsx:60-89`) |
| Authenticated + tenant, project id from another tenant | Next's **default** 404 page |
| Authenticated + tenant, project id that does not exist | Next's default 404 page — byte-identical |
| Unauthenticated, snapshot image URL | `404` / `"Not found"` plain text |
| Authenticated, another tenant's snapshot | `404` / `"Not found"` — identical |

There is **no `not-found.tsx`, `error.tsx`, `loading.tsx`, `forbidden.tsx` or `unauthorized.tsx` anywhere in `src/`**, so 404 renders Next's built-in page, styled nothing like the product.

#### 404-vs-403 is a written policy, not an accident

Three places state it explicitly: `src/app/(app)/projects/[id]/page.tsx:25-26` ("indistinguishable from one that does not exist — which is the intended answer, not a limitation"), `src/app/api/snapshots/[snapshotId]/route.ts:26-28` ("Telling a caller that a row exists is itself a leak"), and `src/server/api/trpc.ts:177-178`.

`FORBIDDEN` appears exactly once in the application (`trpc.ts:182-185`) and means something else entirely: authenticated but tenant-less. In the browser it is never seen, because the layout intercepts first.

#### The shell

`(app)/layout.tsx` renders **no shell on the success path** — line 57 is `return <>{children}</>;`. No nav, no tenant display, no user menu, no sign-out. Sign-out appears twice as inline server actions (`layout.tsx:73-85`, `projects/page.tsx:36-48`); user email is shown once (`projects/page.tsx:23-25`); tenant name is **never displayed anywhere** despite `tenants.name` existing.

#### Every UI-triggered mutation

The complete list of controls that must become role-conditional:

| Action | UI | Procedure |
|---|---|---|
| Create project | `projects/page.tsx:29-34`, `:65-70`, `new/page.tsx:177-182` | `project.create` |
| Trigger a run | `run-panel.tsx:328-335` (`disabled` at `:330` encodes only run-state) | `project.startRun` |
| Pin baseline | `visual-panel.tsx:104-111`, `:183-190` | `project.pinBaseline` |
| Edit masks | `visual-panel.tsx:296-305` | `project.setMasks` |
| Delete project | **does not exist** | **does not exist** |

None of the read queries in `run-panel.tsx` (`:178, :202, :228, :233, :245`), `trend-grid.tsx:55`, `performance-table.tsx:44` or `visual-panel.tsx:40` renders an error state for a refusal. `run-panel.tsx:304-310` handles `startRun` errors only.

#### Sign-in

The form does **not** post to `/api/auth/...`; it submits to an inline server action (`src/app/signin/page.tsx:16-33`) calling `signIn("credentials", { redirectTo: "/projects" })`. Every failure surfaces one generic banner — "Those details did not match an account" (`signin/page.tsx:52-57`) — deliberately, so sign-in cannot be used for account enumeration. The footer states: "Accounts are created by invitation. There is no sign-up." (`signin/page.tsx:95-97`).

`e2e/global-setup.ts:44-47` confirms accounts are seeded directly into the database because "there is currently no way to [build one] through the interface."

### 4. Enforcement points outside tRPC — the four that inherit nothing

This is where the centralised story breaks down, and where S-10's second predicate has to be repeated by hand:

1. **Snapshot byte route** — `route.ts:57-61` resolves the tenant independently, then four inline `eq(x.tenantId, user.tenantId)` predicates at `:75, :100, :107, :124`. Its own comment says it "re-establishes ownership itself rather than inheriting it: the id in the URL is not a permission."
2. **Crawl engine** — `src/server/crawl/run.ts:98, :106, :165`. `startRun` at `:106` is the actual authorization check behind `project.startRun`; if a Team-member's right to run a check is per-project, **that predicate is where it has to hold**, not in the router.
3. **Retention** — `src/server/crawl/retention.ts:83, :89, :105`.
4. **Route-group layout** — `src/app/(app)/layout.tsx:48-55`, a third independent copy of "resolve tenant from userId" (the others being `trpc.ts:49-57` and `route.ts:57-61`).

**(L) The concrete future leak.** The snapshot route scopes on tenant only (`route.ts:72-77`). A Client-viewer scoped to one project would still be able to fetch **any snapshot in the tenant** — i.e. screenshots of other clients' sites. This is not a gap today (only Owners exist) but becomes one the moment Client-viewer ships. The ownership chain already walks snapshot → page → run → project, so the project id is in hand at `route.ts:99` — it is simply not compared against anything but the tenant.

### 5. What the tests will force

- **`src/server/api/tenant-isolation.test.ts:419`** — reflects over `Object.keys(appRouter._def.procedures)` and asserts it deep-equals the classified set. **Every new S-10 procedure fails the suite by name until classified.** The `Case` union (`:179-181`) has only `foreign-id` and `no-tenant-input`; a role dimension likely needs a third kind.
- **`tenant-isolation.test.ts:318-324`** — explicitly declines to pin *which* refusal shape each procedure gives ("a refusal and an empty answer are both acceptable"). **S-10 has latitude here without breaking this file.**
- **`e2e/journeys/partial-account.spec.ts:34-59`** — derives gated routes by walking `src/app/(app)/` on the filesystem. Any page S-10 adds is auto-enrolled and must render the no-workspace notice for an orphan account **without a 5xx** (`:88-121`).
- **`partial-account.spec.ts:135-155`** — the only automated assertion of unauthenticated gated-route behaviour. Pins the redirect target and nothing else.
- **`src/server/api/routers/project.test.ts:105-122`** — a tenant-less caller gets `FORBIDDEN`, not an empty list, because empty "would be indistinguishable from a tenant that legitimately has no projects". Precedent for the refusal shape roles introduce.
- **`src/server/auth/authorize.integration.test.ts:177`** — an account with `passwordHash === null` returns the same indistinguishable `null`, framed explicitly as the invite-created-but-no-password-yet state. **An invite flow must not create a new distinguishable answer here.**
- `test/reset.ts` reads the table list from the schema, so S-10's new tables need no test-reset wiring.

## Code References

- `src/server/db/schema.ts:84` — `users.tenantId`, the entire user↔tenant binding, nullable by design
- `src/server/db/schema.ts:68-73` — `users.passwordHash` nullable, "a user invited but who has not yet set a password has none"
- `src/server/db/schema.ts:757-765` — `verificationTokens`, present and unused
- `src/server/auth/config.ts:27` — `// role: UserRole;`, the one literal role seam
- `src/server/auth/config.ts:103-110` — JWT strategy, sessions unrevocable, suggested token-version mitigation
- `src/server/api/trpc.ts:49-57` — the per-request tenant lookup; where a role would be resolved
- `src/server/api/trpc.ts:180-194` — `tenantProcedure`, the only builder-level refusal
- `src/server/api/trpc.ts:217-220` — `tenantScope`, the single predicate helper, table-not-column
- `src/server/api/routers/project.ts:45` — `list`, the one procedure whose result set changes for all three roles
- `src/server/api/routers/project.ts:65,102,133,205` — the four mutations, the complete role-gatable write set
- `src/app/(app)/layout.tsx:39-40` — the entire browser auth gate
- `src/app/(app)/layout.tsx:57` — `return <>{children}</>;`, the absent shell
- `src/app/(app)/projects/[id]/page.tsx:24-28` — the `catch` that collapses every failure into `notFound()`
- `src/app/api/snapshots/[snapshotId]/route.ts:72-77` — tenant-only scoping on image bytes
- `src/server/crawl/run.ts:105-108` — the real authorization check behind `startRun`
- `src/server/api/tenant-isolation.test.ts:419` — the completeness tripwire
- `e2e/journeys/partial-account.spec.ts:34-59` — filesystem-derived gated route enrolment

## Architecture Insights

**Scoping is inherited by construction, and that is the design's whole thesis.** F-01 chose `tenantProcedure` + a pre-scoped helper over Postgres row-level security precisely because "scoping is inherited by construction; RLS is stronger but needs hand-maintained SQL on a push-based workflow". The recorded risk is that "the procedure boundary is a convention, not a guarantee — `ctx.db` remains reachable". Every new S-10 router is a fresh instance of that risk.

**Freshness beats convenience, deliberately.** The tenant is re-read from the database on every request rather than carried in the JWT, because an unrevocable token claim "would stay wrong until expiry". A role read the same way inherits the same freshness — which matters directly, because removing a Team-member from a project or demoting a role is exactly the case a stale token gets wrong. **The existing precedent points at the context resolver, not the `jwt`/`session` callbacks, as the place a role belongs.**

**Concealment is the default answer, and it was reasoned for cross-tenant leakage.** All three written statements of the 404-not-403 policy argue about hiding one tenant's data from another. S-10's two new gate shapes — a Client-viewer at a sibling project, a Team-member at an unassigned project — sit *inside* a tenant the caller legitimately belongs to. **None of the three policy notes anticipated that case**, and the reasoning behind them ("telling a caller that a row exists is itself a leak") does not obviously transfer: the existence of sibling projects inside one's own agency is not necessarily a secret. This is a genuine new decision, not an application of an existing one.

**Asymmetry in the F-01 join-table ruling.** F-01 ruled out a join table for user↔**tenant**, on the grounds that it "rebuilds the multi-agency capability the PRD explicitly cut when it dropped the admin role". It said nothing about user↔**project**, which FR-005 ("assign a Team-member to specific projects") requires and which is a genuine many-to-many. The ruling constrains one edge and leaves the other open — worth stating plainly in planning so the constraint is not over-applied.

**The Client-viewer sits awkwardly against `tenantProcedure`.** A Client-viewer belongs to a single project, but `tenantProcedure` refuses any caller without a `tenantId`, and the layout shows such an account the "no workspace" notice. Either a Client-viewer carries the agency's `tenantId` (and is then restricted *within* it by a second predicate), or the builder and the layout both need a new path. This is the design fork with the widest blast radius.

## Historical Context (from prior changes)

Binding decisions from `context/archive/2026-08-21-tenant-scoped-owner-signin/` (F-01 — no `research.md`; it predates the research step):

- **"A user belongs to exactly one tenant"** as a column, not a join table — `plan.md:91-95`
- **`users.tenantId` stays nullable**, invariant enforced in the resolver — `plan.md:98-103`
- **Tenant resolved per request, never carried in the token** — `plan.md:76-81`
- **Gated routes guarded by the route-group layout, not middleware** — `plan.md:349-352`
- **Unauthenticated at a gated route → redirect to sign-in**; gated = everything except home and sign-in — `plan.md:327-337`, described there as resolving PRD Open Question 7
- **Explicitly deferred to S-10**: "**Roles.** No `role` column, no Team-member, no Client-viewer. That is roadmap item S-10." / "**Invites.** No invite tokens, no invite acceptance, no email. Also S-10." — `plan.md:55-56`
- **Open blind spot from F-01's review**: "Does not protect non-page callers (route handlers, server actions) that reach `project.list` outside the layout." — `reviews/impl-review.md:48-49`

From `context/archive/2026-08-25-auth-and-abuse-behaviours/`:

- The tenant-isolation suite is **generated from `appRouter` with a completeness gate**; mutation-proven that adding a procedure fails the suite by name — `plan.md:21-26`
- Gated routes are **read off the filesystem**: "The fixed case is not the risk; the next page written by someone who never saw the original failure is." — `plan.md:28-32`
- **S-10 is named as the source of future risk**: "S-10 introduces invites and more partial states." — `change.md:22-24`, echoed at `context/foundation/test-plan.md:43` and, as a testing obligation, at `test-plan.md:58`: "That the one fixed case is the only partial state. **Invites will create more.**"
- **Rate limiting and lockout are absent** and are not mentioned in any change or the test plan
- Known limit left as found: **`startRun` refuses a foreign project with a plain `Error`**, surfacing as `INTERNAL_SERVER_ERROR` rather than `NOT_FOUND` — `plan.md:124-127`

From `context/foundation/test-plan.md`:

- **R3** response requires proof that "a caller holding another tenant's identifier is refused by every read path, **including ones added later**"; anti-pattern named as "testing only the procedures that exist today" (`test-plan.md:56`)
- **R5** requires that a partial account "is told what is wrong and offered a way out, **on every gated surface**", with the class being "identity present but incomplete" (`test-plan.md:58`)
- **There is no rollout phase reserved for S-10** — the plan expects S-10's coverage to fall out of the existing generated R3/R5 harnesses (`test-plan.md:70-73`)

## Related Research

- `context/archive/2026-08-21-tenant-scoped-owner-signin/plan.md` — the direct predecessor; its "Implementation Approach" section is the reasoning this slice builds on
- `context/archive/2026-08-25-auth-and-abuse-behaviours/plan.md` — the auth/enumeration behaviours S-10's new sign-in paths must match
- `context/foundation/test-plan.md` — R3, R5 and R7 responses, all of which name S-10 as future risk
- `context/changes/visual-regression-baselines/HANDOFF.md:166-171` — identifies S-10 as a next unblocked slice

## Open Questions

1. **What does an authenticated-but-unauthorised user see?** No document addresses this. F-01's answer to PRD Open Question 7 covers *unauthenticated* only. The two new shapes — Client-viewer at a sibling project, Team-member at an unassigned project — sit inside a tenant the caller legitimately belongs to, which the existing 404-not-403 policy did not reason about. **Owner: user. Blocks: the refusal shape of every read path S-10 touches.**
2. **Does a Client-viewer carry a `tenantId`?** `tenantProcedure` refuses a caller without one (`trpc.ts:181-186`) and the layout shows them the "no workspace" notice. The answer determines whether S-10 extends the existing builder or forks it. **Widest blast radius of any open item.**
3. **How is an invite delivered?** F-01 said "no email"; the PRD's cost reduction removed "public registration, email verification, and bot or spam signup handling" from scope but says nothing about invite delivery. No mail transport is selected anywhere, F-02 is unbuilt, and roadmap Open Question 8 ("which host, concretely?") is still open. A copyable invite link avoids the dependency entirely; email does not. **Owner: user.**
4. **Where does role live — a column on `users`, or a membership table?** FR-005 requires a genuine many-to-many for user↔project. F-01's join-table ruling constrained user↔tenant only. Whether role is a property of the user or of the membership is undecided and changes the schema shape.
5. **Should PRD Open Question 7's answer be written back?** The behaviour is decided, implemented and tested, but both `prd.md:536-538` and `roadmap.md:369` still record it as open. A documentation fix, not a decision — but it should not be re-litigated during planning as though it were open.
6. **Does S-10 fix `startRun`'s error code?** Currently `INTERNAL_SERVER_ERROR` for a foreign project, "left as found" by the auth-and-abuse change. S-10 is the natural place this becomes a role-check status-code question, but it is a behaviour change and should be a deliberate inclusion, not a drive-by.
7. **Does role revocation need to be immediate?** Sessions are unrevocable JWTs. Re-reading role per request (as tenant is) gives immediacy; caching it in the token does not. The existing precedent favours re-reading, at the cost of a wider per-request query.
