import { TRPCError } from "@trpc/server";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createCaller } from "~/server/api/root";
import { RUN_STATUS } from "~/server/crawl/run";
import { projects, runs, tenants, users } from "~/server/db/schema";
import { resetDatabase } from "../../../../test/reset";

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
const db = drizzle(connection, { schema: { projects, runs, tenants, users } });

/** Builds a context the same shape the real request path builds. */
function callerFor(userId: string | null, tenantId: string | null) {
	return createCaller({
		db,
		session: userId ? { user: { id: userId }, expires: "" } : null,
		tenantId,
		/**
		 * Owner with unrestricted access — the shape `createTRPCContext` produces
		 * for the accounts these cases seed, which carry the column default.
		 */
		role: "owner",
		assignedProjectIds: null,
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
		.values({
			tenantId: tenant.id,
			name: `${label} client site`,
			startUrl: `https://${label}.isolation.test/`,
		})
		.returning();
	if (!project) throw new Error("project insert returned nothing");

	return { tenant, owner, project };
}

beforeEach(async () => {
	await resetDatabase(connection);
});

afterAll(async () => {
	/**
	 * Left clean for whoever runs next, as `tenant-isolation.test.ts` does and
	 * for the reason it gives: these files share one database and run
	 * sequentially, and the run rows the archive cases seed would otherwise make
	 * the next file's project truncation fail on a foreign key.
	 */
	await resetDatabase(connection);
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

/**
 * Deleting a project, which this product does by hiding rather than by removing.
 *
 * The cases below are split along that seam deliberately. Everything a user can
 * observe must say the project is gone; the row underneath must still be there.
 * A test suite that only asserted the first half would pass against a real
 * `DELETE`, and the history hanging off the project would go with it.
 */
describe("project.archive", () => {
	it("removes the project from every surface that lists or resolves it", async () => {
		const { tenant, owner, project } = await seedTenant("epsilon");
		const caller = callerFor(owner.id, tenant.id);

		await expect(caller.project.list()).resolves.toHaveLength(1);

		await caller.project.archive({ projectId: project.id });

		expect(await caller.project.list()).toEqual([]);
		/**
		 * `NOT_FOUND` rather than a project marked deleted. The gate is
		 * `assertProjectAccess`, so this one assertion stands in for every
		 * procedure that resolves a project or a run — they all inherit it.
		 */
		await expect(
			caller.project.byId({ projectId: project.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	/**
	 * The property that makes this a soft delete, asserted against the table
	 * rather than through the API — the API is precisely what can no longer see
	 * it. Without this case the whole change could be a `DELETE` and every other
	 * test here would still pass.
	 */
	it("keeps the row, stamped with when it was deleted", async () => {
		const { tenant, owner, project } = await seedTenant("zeta");
		const before = Date.now();

		await callerFor(owner.id, tenant.id).project.archive({
			projectId: project.id,
		});

		const row = await db.query.projects.findFirst({
			where: (p, { eq }) => eq(p.id, project.id),
		});

		expect(row).toBeDefined();
		expect(row?.name).toBe(project.name);
		expect(row?.archivedAt).toBeInstanceOf(Date);
		expect(row?.archivedAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
	});

	it("leaves the tenant's other projects alone", async () => {
		const { tenant, owner, project } = await seedTenant("eta");

		const [survivor] = await db
			.insert(projects)
			.values({
				tenantId: tenant.id,
				name: "eta second site",
				startUrl: "https://eta-2.isolation.test/",
			})
			.returning();
		if (!survivor) throw new Error("project insert returned nothing");

		const caller = callerFor(owner.id, tenant.id);
		await caller.project.archive({ projectId: project.id });

		const remaining = await caller.project.list();
		expect(remaining.map((p) => p.id)).toEqual([survivor.id]);
	});

	it("refuses a second delete of the same project", async () => {
		const { tenant, owner, project } = await seedTenant("theta");
		const caller = callerFor(owner.id, tenant.id);

		await caller.project.archive({ projectId: project.id });

		await expect(
			caller.project.archive({ projectId: project.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	/**
	 * A crawl in flight owns the project. Both halves matter: the refusal, and
	 * the project still being live afterwards — a procedure that archived first
	 * and threw second would satisfy a test that only checked for the error.
	 */
	it("refuses while a check is running, and changes nothing", async () => {
		const { tenant, owner, project } = await seedTenant("iota");

		await db.insert(runs).values({
			tenantId: tenant.id,
			projectId: project.id,
			status: RUN_STATUS.RUNNING,
		});

		const caller = callerFor(owner.id, tenant.id);

		await expect(
			caller.project.archive({ projectId: project.id }),
		).rejects.toMatchObject({ code: "CONFLICT" });

		const row = await db.query.projects.findFirst({
			where: (p, { eq }) => eq(p.id, project.id),
		});
		expect(row?.archivedAt).toBeNull();
		await expect(caller.project.list()).resolves.toHaveLength(1);
	});

	/**
	 * The counterpart to the case above. Without it, a build that refused every
	 * delete outright would pass that one.
	 */
	it("allows the delete once the run has finished", async () => {
		const { tenant, owner, project } = await seedTenant("kappa");

		await db.insert(runs).values({
			tenantId: tenant.id,
			projectId: project.id,
			status: RUN_STATUS.DONE,
		});

		const caller = callerFor(owner.id, tenant.id);
		await expect(
			caller.project.archive({ projectId: project.id }),
		).resolves.toMatchObject({ id: project.id });
	});
});
