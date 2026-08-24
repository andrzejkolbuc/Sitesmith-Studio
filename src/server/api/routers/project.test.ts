import { TRPCError } from "@trpc/server";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createCaller } from "~/server/api/root";
import { projects, tenants, users } from "~/server/db/schema";

/**
 * The test this whole change exists to make possible.
 *
 * It asserts the isolation property at the procedure boundary, which is where the
 * guarantee actually lives — `createCaller` rather than HTTP, because the
 * transport is not what could leak.
 *
 * If someone later writes a router on `protectedProcedure` instead of
 * `tenantProcedure`, or drops the `tenantScope` from a `where` clause, this is
 * what should go red.
 */

const databaseUrl = process.env.DATABASE_URL ?? "";

/**
 * Assert the target database before opening a connection to it.
 *
 * `test/global-setup.ts` performs the same check, and it has already earned its
 * keep once — during implementation it caught a config in which the setup step
 * still saw the development database. The check is repeated here because this is
 * the file that actually truncates tables: anything that runs these tests without
 * that global setup (a different config, an IDE runner, a future project split)
 * would otherwise empty whatever database it happened to be pointed at.
 *
 * A destructive operation and its guard should live together.
 */
if (!new URL(databaseUrl).pathname.endsWith("-test")) {
	throw new Error(
		`Refusing to run: DATABASE_URL does not point at a "-test" database. These tests truncate tables.`,
	);
}

const connection = postgres(databaseUrl, { max: 1 });
const db = drizzle(connection, { schema: { projects, tenants, users } });

/** Builds a context the same shape the real request path builds. */
function callerFor(userId: string | null, tenantId: string | null) {
	return createCaller({
		db,
		session: userId ? { user: { id: userId }, expires: "" } : null,
		tenantId,
		headers: new Headers(),
	} as unknown as Parameters<typeof createCaller>[0]);
}

async function seedTenant(label: string) {
	const [tenant] = await db
		.insert(tenants)
		.values({ name: `${label} Agency` })
		.returning();
	if (!tenant) throw new Error("tenant insert returned nothing");

	const [owner] = await db
		.insert(users)
		.values({ email: `${label}@isolation.test`, tenantId: tenant.id })
		.returning();
	if (!owner) throw new Error("user insert returned nothing");

	const [project] = await db
		.insert(projects)
		.values({ tenantId: tenant.id, name: `${label} client site` })
		.returning();
	if (!project) throw new Error("project insert returned nothing");

	return { tenant, owner, project };
}

beforeEach(async () => {
	// Order matters: projects and users both reference tenants.
	await db.delete(projects);
	await db.delete(users);
	await db.delete(tenants);
});

afterAll(async () => {
	await connection.end();
});

describe("project.list tenant isolation", () => {
	it("returns only the caller's own tenant's projects", async () => {
		const a = await seedTenant("alpha");
		const b = await seedTenant("beta");

		const asA = await callerFor(a.owner.id, a.tenant.id).project.list();
		const asB = await callerFor(b.owner.id, b.tenant.id).project.list();

		expect(asA.map((p) => p.name)).toEqual([a.project.name]);
		expect(asB.map((p) => p.name)).toEqual([b.project.name]);

		// Stated as its own assertion so a failure reads as a leak, not a count
		// mismatch.
		expect(asA.some((p) => p.tenantId === b.tenant.id)).toBe(false);
		expect(asB.some((p) => p.tenantId === a.tenant.id)).toBe(false);
	});

	it("refuses a caller whose account has no tenant", async () => {
		await seedTenant("gamma");

		const [orphan] = await db
			.insert(users)
			.values({ email: "orphan@isolation.test" })
			.returning();
		if (!orphan) throw new Error("user insert returned nothing");

		/**
		 * Refusal rather than an empty list is the point. An empty list would be
		 * indistinguishable from a tenant that legitimately has no projects, so a
		 * misconfigured account would look healthy.
		 */
		await expect(
			callerFor(orphan.id, null).project.list(),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("refuses an unauthenticated caller", async () => {
		await seedTenant("delta");

		await expect(callerFor(null, null).project.list()).rejects.toBeInstanceOf(
			TRPCError,
		);
	});
});
