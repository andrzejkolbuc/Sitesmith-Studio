import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCaller } from "~/server/api/root";
import * as schema from "~/server/db/schema";
import { projects, tenants, users } from "~/server/db/schema";
import { type Fixture, startFixtureSite } from "../../../test/fixtures/site";
import { resetDatabase } from "../../../test/reset";
import { runToCompletion } from "./run";

/**
 * Which runs are allowed onto the trend, over real crawls and a real database.
 *
 * The unit tests fix the grid's shape over rows somebody typed. This file fixes
 * the half that decides what the grid is even allowed to say: a series drawn
 * through runs that were not produced under the same conditions is a line whose
 * movement describes our configuration rather than the client's site, and the
 * shape of a line is the claim.
 *
 * The load-bearing cases are the exclusions. An unchanged site producing flat
 * rows is the property; a re-scoped or truncated run quietly joining the series
 * is the failure that would make the whole section untrustworthy.
 */

const databaseUrl = process.env.DATABASE_URL ?? "";

if (!new URL(databaseUrl).pathname.endsWith("-test")) {
	throw new Error(
		`Refusing to run: DATABASE_URL does not point at a "-test" database.`,
	);
}

const connection = postgres(databaseUrl, { max: 1 });
const db = drizzle(connection, { schema });

let site: Fixture;

beforeAll(async () => {
	site = await startFixtureSite();
});

afterAll(async () => {
	await site.close();
	await connection.end();
});

beforeEach(async () => {
	await resetDatabase(connection);
	site.reset();
});

async function seedProject(label: string) {
	const [tenant] = await db
		.insert(tenants)
		.values({ name: `${label} Agency` })
		.returning();
	if (!tenant) throw new Error("tenant insert returned nothing");

	const [owner] = await db
		.insert(users)
		.values({ email: `${label}@trend.test`, tenantId: tenant.id })
		.returning();
	if (!owner) throw new Error("user insert returned nothing");

	const [project] = await db
		.insert(projects)
		.values({
			tenantId: tenant.id,
			name: `${label} site`,
			startUrl: site.baseUrl,
			/**
			 * `/flaky` is left in scope, unlike the other suites' fixtures, so the
			 * abort case below can be produced by pointing the crawl at the failing
			 * hub alone. Changing the exclusions instead would change the recorded
			 * scope, and the run would then drop out for the wrong reason — the
			 * test would pass while proving nothing about truncation. Nothing on
			 * the ordinary site links to `/flaky`, so the other cases are unaffected.
			 */
			excludePaths: ["/private"],
			locales: ["en", "de", "fr"],
			maxConcurrency: 4,
			requestDelayMs: 0,
		})
		.returning();
	if (!project) throw new Error("project insert returned nothing");

	return { tenant, owner, project };
}

function callerFor(userId: string, tenantId: string) {
	return createCaller({
		db,
		session: { user: { id: userId }, expires: "" },
		tenantId,
		headers: new Headers(),
	} as unknown as Parameters<typeof createCaller>[0]);
}

const crawl = async (tenantId: string, projectId: string) =>
	(await runToCompletion(db, { tenantId, projectId })).runId;

describe("which runs the trend will plot", () => {
	/**
	 * The property the section is judged on. Nothing about the site changed, so
	 * every row must be flat — a grid that invents movement here would invent it
	 * everywhere.
	 */
	it("plots two unchanged runs as flat rows", async () => {
		const { tenant, owner, project } = await seedProject("steady");

		const first = await crawl(tenant.id, project.id);
		const second = await crawl(tenant.id, project.id);

		const trend = await callerFor(owner.id, tenant.id).project.trend({
			projectId: project.id,
		});

		expect(trend.runs.map((run) => run.id)).toEqual([first, second]);

		const byRun = new Map<string, Map<string, number>>();
		for (const row of trend.counts) {
			const bucket = byRun.get(row.runId) ?? new Map<string, number>();
			bucket.set(row.type, row.count);
			byRun.set(row.runId, bucket);
		}

		const before = byRun.get(first) ?? new Map();
		const after = byRun.get(second) ?? new Map();

		expect(after.size).toBeGreaterThan(0);
		expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
		for (const [type, value] of after) {
			expect(before.get(type), `${type} moved on an unchanged site`).toBe(
				value,
			);
		}
	});

	/**
	 * The incident the guard was written for, asked as a trend question: a project
	 * narrowed between runs looked at a different site. Plotted, the pages it was
	 * told not to visit would read as a cliff of problems that had been fixed.
	 */
	it("drops a run that ran under a different scope", async () => {
		const { tenant, owner, project } = await seedProject("narrowed");

		await crawl(tenant.id, project.id);

		await db
			.update(projects)
			.set({ includePaths: ["/handbook"] })
			.where(eq(projects.id, project.id));

		const narrowed = await crawl(tenant.id, project.id);

		const trend = await callerFor(owner.id, tenant.id).project.trend({
			projectId: project.id,
		});

		/**
		 * The narrowed run is the newest and is sound on its own terms, so it is
		 * the reference and the earlier run is the one that cannot join it. Which
		 * of the two drops out is not the point; that they are never drawn on one
		 * axis is.
		 */
		expect(trend.runs.map((run) => run.id)).toEqual([narrowed]);
	});

	/**
	 * A truncated crawl supports no comparison in either direction, so it is not a
	 * point on a line either. The runs either side of it still are: an interrupted
	 * crawl must drop out of the series, not erase the series.
	 */
	it("drops an aborted run and keeps the sound ones", async () => {
		const { tenant, owner, project } = await seedProject("aborted");

		const first = await crawl(tenant.id, project.id);
		const second = await crawl(tenant.id, project.id);

		/**
		 * The entry URL moves to the always-failing hub so the burst triggers. The
		 * scope snapshot does not record the entry URL, so this run is recorded
		 * with exactly the reference's scope and can only drop out for the reason
		 * under test.
		 */
		await db
			.update(projects)
			.set({ startUrl: `${site.baseUrl}/flaky-hub` })
			.where(eq(projects.id, project.id));

		const aborted = await crawl(tenant.id, project.id);

		const abortedRun = await db.query.runs.findFirst({
			where: eq(schema.runs.id, aborted),
		});
		expect(abortedRun?.crawlComplete).toBe(false);

		await db
			.update(projects)
			.set({ startUrl: site.baseUrl })
			.where(eq(projects.id, project.id));

		const trend = await callerFor(owner.id, tenant.id).project.trend({
			projectId: project.id,
		});

		expect(trend.runs.map((run) => run.id)).toEqual([first, second]);
	});

	/**
	 * A project whose runs all predate this recording has no series at all. It
	 * returns nothing rather than plotting runs whose conditions were never
	 * observed — the emptiness is the view's to explain.
	 */
	it("plots nothing when no run recorded its conditions", async () => {
		const { tenant, owner, project } = await seedProject("legacy");

		const only = await crawl(tenant.id, project.id);

		await db
			.update(schema.runs)
			.set({ ruleSet: null, crawlComplete: null, scope: null })
			.where(eq(schema.runs.id, only));

		const trend = await callerFor(owner.id, tenant.id).project.trend({
			projectId: project.id,
		});

		expect(trend.runs).toEqual([]);
		expect(trend.counts).toEqual([]);
	});
});
