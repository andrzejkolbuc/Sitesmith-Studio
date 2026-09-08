import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { projectAssignments, tenants, users } from "~/server/db/schema";
import { resetDatabase } from "../../../test/reset";

/**
 * What happens to a user row that predates the role column.
 *
 * The column arrives on a populated table. Every account that existed before it
 * was an Owner — there was no other kind — so the migration is only correct if
 * those rows come out as `owner` without anybody running a backfill. The way
 * that is guaranteed is a database-level `.default()` rather than the
 * `$defaultFn` its neighbours use, and the difference between the two is
 * invisible in the schema file unless you already know to look.
 *
 * So this asserts the property, not the spelling: insert without naming the
 * column, the way an existing row effectively did, and read back an Owner. An
 * `$defaultFn` would leave the value unset at the database and fail here.
 *
 * This cannot be a unit test. A default is a fact about Postgres, and asserting
 * it against anything else would be asserting our own belief about Postgres.
 */

const databaseUrl = process.env.DATABASE_URL ?? "";

if (!new URL(databaseUrl).pathname.endsWith("-test")) {
	throw new Error(
		`Refusing to run: DATABASE_URL does not point at a "-test" database. These tests truncate tables.`,
	);
}

const connection = postgres(databaseUrl, { max: 1 });
const db = drizzle(connection, {
	schema: { projectAssignments, tenants, users },
});

afterEach(async () => {
	await resetDatabase(connection);
});

afterAll(async () => {
	await connection.end();
});

describe("users.role default", () => {
	it("resolves a row inserted without a role as owner", async () => {
		const [tenant] = await db
			.insert(tenants)
			.values({ name: "Legacy Agency" })
			.returning();
		if (!tenant) throw new Error("tenant insert returned nothing");

		const [inserted] = await db
			.insert(users)
			.values({
				email: "predates-the-column@sitesmith.test",
				tenantId: tenant.id,
			})
			.returning();

		expect(inserted?.role).toBe("owner");
	});

	it("keeps an explicitly named role", async () => {
		const [tenant] = await db
			.insert(tenants)
			.values({ name: "Explicit Agency" })
			.returning();
		if (!tenant) throw new Error("tenant insert returned nothing");

		const [inserted] = await db
			.insert(users)
			.values({
				email: "explicit@sitesmith.test",
				tenantId: tenant.id,
				role: "viewer",
			})
			.returning();

		expect(inserted?.role).toBe("viewer");
	});
});
