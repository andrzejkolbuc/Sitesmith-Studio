/**
 * YOU PROBABLY DON'T NEED TO EDIT THIS FILE, UNLESS:
 * 1. You want to modify request context (see Part 1).
 * 2. You want to create a new middleware or type of procedure (see Part 3).
 *
 * TL;DR - This is where all the tRPC server stuff is created and plugged in. The pieces you will
 * need to use are documented accordingly near the end.
 */

import { initTRPC, TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import superjson from "superjson";
import { ZodError } from "zod";

import { auth } from "~/server/auth";
import { isOwner } from "~/server/auth/roles";
import { db } from "~/server/db";
import { projectAssignments, projects, users } from "~/server/db/schema";

/**
 * 1. CONTEXT
 *
 * This section defines the "contexts" that are available in the backend API.
 *
 * These allow you to access things when processing a request, like the database, the session, etc.
 *
 * This helper generates the "internals" for a tRPC context. The API handler and RSC clients each
 * wrap this and provides the required context.
 *
 * @see https://trpc.io/docs/server/context
 */
export const createTRPCContext = async (opts: { headers: Headers }) => {
	const session = await auth();

	/**
	 * Resolve the caller's tenant once per request, so procedures don't each
	 * re-derive it.
	 *
	 * Read from the database rather than carried as a claim in the session token.
	 * Credentials sign-in forces JWT sessions, which cannot be revoked early — a
	 * tenant claim baked into a token would therefore stay wrong until expiry,
	 * widening the revocation gap instead of containing it. One indexed lookup is
	 * the cheaper mistake.
	 *
	 * Resolves to `null` for unauthenticated callers; `publicProcedure` must keep
	 * working, so absence is not an error here. `tenantProcedure` is where absence
	 * becomes a refusal.
	 */
	const userId = session?.user?.id;
	const account = userId
		? await db.query.users.findFirst({
				columns: { tenantId: true, role: true },
				where: eq(users.id, userId),
			})
		: undefined;

	const tenantId = account?.tenantId ?? null;
	const role = account?.role ?? null;

	/**
	 * Which projects this caller may reach — or `null` meaning "every project in
	 * the tenant", which is what an Owner gets.
	 *
	 * `null` is deliberately not the same as `[]`. An empty array is a real
	 * answer: a Team-member who has been assigned nothing sees nothing. Conflating
	 * the two would turn "assigned to no projects" into "unrestricted", which is
	 * the one mistake in this file that would be silent.
	 *
	 * Resolved here for the same reason the tenant is, and at the same cost: it
	 * cannot live in the session token, because sessions are unrevocable JWTs and
	 * un-assigning someone would not take effect until their token expired. An
	 * Owner still costs exactly one query — the branch below skips the second.
	 */
	const assignedProjectIds =
		userId && tenantId && !isOwner(role)
			? (
					await db.query.projectAssignments.findMany({
						columns: { projectId: true },
						where: and(
							eq(projectAssignments.userId, userId),
							eq(projectAssignments.tenantId, tenantId),
						),
					})
				).map((row) => row.projectId)
			: null;

	return {
		db,
		session,
		tenantId,
		role,
		assignedProjectIds,
		...opts,
	};
};

/**
 * 2. INITIALIZATION
 *
 * This is where the tRPC API is initialized, connecting the context and transformer. We also parse
 * ZodErrors so that you get typesafety on the frontend if your procedure fails due to validation
 * errors on the backend.
 */
const t = initTRPC.context<typeof createTRPCContext>().create({
	transformer: superjson,
	errorFormatter({ shape, error }) {
		return {
			...shape,
			data: {
				...shape.data,
				zodError:
					error.cause instanceof ZodError ? error.cause.flatten() : null,
			},
		};
	},
});

/**
 * Create a server-side caller.
 *
 * @see https://trpc.io/docs/server/server-side-calls
 */
export const createCallerFactory = t.createCallerFactory;

/**
 * 3. ROUTER & PROCEDURE (THE IMPORTANT BIT)
 *
 * These are the pieces you use to build your tRPC API. You should import these a lot in the
 * "/src/server/api/routers" directory.
 */

/**
 * This is how you create new routers and sub-routers in your tRPC API.
 *
 * @see https://trpc.io/docs/router
 */
export const createTRPCRouter = t.router;

/**
 * Middleware for timing procedure execution and adding an artificial delay in development.
 *
 * You can remove this if you don't like it, but it can help catch unwanted waterfalls by simulating
 * network latency that would occur in production but not in local development.
 */
const timingMiddleware = t.middleware(async ({ next, path }) => {
	const start = Date.now();

	if (t._config.isDev) {
		// artificial delay in dev
		const waitMs = Math.floor(Math.random() * 400) + 100;
		await new Promise((resolve) => setTimeout(resolve, waitMs));
	}

	const result = await next();

	const end = Date.now();
	console.log(`[TRPC] ${path} took ${end - start}ms to execute`);

	return result;
});

/**
 * Public (unauthenticated) procedure
 *
 * This is the base piece you use to build new queries and mutations on your tRPC API. It does not
 * guarantee that a user querying is authorized, but you can still access user session data if they
 * are logged in.
 */
export const publicProcedure = t.procedure.use(timingMiddleware);

/**
 * Protected (authenticated) procedure
 *
 * If you want a query or mutation to ONLY be accessible to logged in users, use this. It verifies
 * the session is valid and guarantees `ctx.session.user` is not null.
 *
 * @see https://trpc.io/docs/procedures
 */
export const protectedProcedure = t.procedure
	.use(timingMiddleware)
	.use(({ ctx, next }) => {
		if (!ctx.session?.user) {
			throw new TRPCError({ code: "UNAUTHORIZED" });
		}
		return next({
			ctx: {
				// infers the `session` as non-nullable
				session: { ...ctx.session, user: ctx.session.user },
			},
		});
	});

/**
 * Tenant-scoped procedure
 *
 * **Build every domain router on this, not on `protectedProcedure`.**
 *
 * `protectedProcedure` proves who the caller is. It does not prove which tenant's
 * data they may read, and `ctx.db` is unscoped — so a router built directly on it
 * can return another tenant's rows without anything looking wrong at the call site.
 * This procedure closes that gap: it refuses a caller with no tenant and narrows
 * `ctx.tenantId` to a non-nullable string for everything downstream.
 *
 * Pair it with {@link tenantScope} in the `where` clause. Scoping is then inherited
 * by construction rather than remembered per query.
 *
 * `FORBIDDEN` rather than `UNAUTHORIZED`: the caller is authenticated, they simply
 * belong to no tenant. Keeping the two distinct keeps the failures diagnosable.
 */
export const tenantProcedure = protectedProcedure.use(({ ctx, next }) => {
	if (!ctx.tenantId) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "This account is not attached to a tenant.",
		});
	}

	return next({
		ctx: {
			// infers `tenantId` as non-nullable
			tenantId: ctx.tenantId,
		},
	});
});

/**
 * Builds the tenant-equality condition for a scoped table.
 *
 * Compose it into a `where` clause rather than writing the comparison by hand:
 *
 * ```ts
 * ctx.db.query.projects.findMany({
 *   where: tenantScope(projects, ctx.tenantId),
 * })
 * ```
 *
 * It takes the **table**, not a column, and reads `tenantId` itself. That is the
 * load-bearing detail: a helper whose purpose is preventing a mistake should make
 * that mistake fail to compile, not merely be easy to avoid. Passing a column
 * would let `tenantScope(projects.name, …)` typecheck and silently match nothing,
 * and a table with no tenant column would slip through entirely. Neither is
 * expressible now.
 *
 * Beyond the type safety, scoping has one name and one place to change —
 * including if it ever moves down into row-level security in the database.
 */
export const tenantScope = <T extends { tenantId: PgColumn }>(
	table: T,
	tenantId: string,
) => eq(table.tenantId, tenantId);

/**
 * Owner-only procedure
 *
 * For anything that manages the tenant rather than uses it: creating projects,
 * configuring what a check does, and managing who else may sign in.
 *
 * `FORBIDDEN` rather than `NOT_FOUND`, which is the opposite of what
 * {@link assertProjectAccess} does, and the difference is deliberate. This
 * refusal is about the *caller's* own capability — they know their own role, so
 * concealing it protects nothing and only makes the failure harder to read.
 * `assertProjectAccess` refuses on behalf of a resource, where concealment is
 * the entire point.
 */
export const ownerProcedure = tenantProcedure.use(({ ctx, next }) => {
	if (!isOwner(ctx.role)) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "This action is available to the workspace owner.",
		});
	}

	return next();
});

/**
 * The second authorization dimension, asked once per procedure.
 *
 * Tenant scoping answers *which agency*; this answers *which project within it*,
 * and nothing in the tenant predicates has room for the second question. Rather
 * than thread another term through every query in the router, procedures call
 * this once — at the point they resolve a project or a run — and the existing
 * `tenantScope` carries the rest.
 *
 * Two conditions, refused identically:
 *
 * 1. **Not assigned.** An Owner has `assignedProjectIds === null` and skips
 *    this; everyone else must have the project in their list. Note that an empty
 *    list refuses everything, which is correct — assigned to nothing means
 *    reaching nothing.
 * 2. **Not in the tenant, or not there at all.**
 *
 * Both throw a bare `NOT_FOUND`. A project the caller may not see is
 * indistinguishable from one that does not exist, which is the answer the
 * product already gives across tenants and the one that matters most here: a
 * Client-viewer must not be able to learn that the agency has other clients.
 *
 * This also closes a gap that predates roles — `latestRun`, `runs`, `trend` and
 * `runPages` took a project or run id and never checked the project existed at
 * all, returning an empty result either way.
 */
export const assertProjectAccess = async (
	ctx: {
		db: typeof db;
		tenantId: string;
		assignedProjectIds: string[] | null;
	},
	projectId: string,
): Promise<void> => {
	if (
		ctx.assignedProjectIds !== null &&
		!ctx.assignedProjectIds.includes(projectId)
	) {
		throw new TRPCError({ code: "NOT_FOUND" });
	}

	const project = await ctx.db.query.projects.findFirst({
		columns: { id: true },
		where: and(tenantScope(projects, ctx.tenantId), eq(projects.id, projectId)),
	});

	if (!project) throw new TRPCError({ code: "NOT_FOUND" });
};
