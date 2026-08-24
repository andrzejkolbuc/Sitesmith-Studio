/**
 * YOU PROBABLY DON'T NEED TO EDIT THIS FILE, UNLESS:
 * 1. You want to modify request context (see Part 1).
 * 2. You want to create a new middleware or type of procedure (see Part 3).
 *
 * TL;DR - This is where all the tRPC server stuff is created and plugged in. The pieces you will
 * need to use are documented accordingly near the end.
 */

import { initTRPC, TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import superjson from "superjson";
import { ZodError } from "zod";

import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { users } from "~/server/db/schema";

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
	const tenantId = userId
		? ((
				await db.query.users.findFirst({
					columns: { tenantId: true },
					where: eq(users.id, userId),
				})
			)?.tenantId ?? null)
		: null;

	return {
		db,
		session,
		tenantId,
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
 *   where: tenantScope(projects.tenantId, ctx.tenantId),
 * })
 * ```
 *
 * It is a thin wrapper over `eq` on purpose. The value is that scoping has one
 * name and one place to change — including if this ever moves down into
 * row-level security in the database.
 */
export const tenantScope = (column: PgColumn, tenantId: string) =>
	eq(column, tenantId);
