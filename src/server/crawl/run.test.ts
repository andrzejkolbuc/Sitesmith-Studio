import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCaller } from "~/server/api/root";
import * as schema from "~/server/db/schema";
import {
	findings,
	pages,
	projects,
	runs,
	tenants,
	users,
} from "~/server/db/schema";
import { type Fixture, startFixtureSite } from "../../../test/fixtures/site";
import { resetDatabase } from "../../../test/reset";
import { RUN_STATUS, runToCompletion, sweepStaleRuns } from "./run";

const databaseUrl = process.env.DATABASE_URL ?? "";

// Same guard as the isolation suite: these tests truncate tables.
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
});

async function seedProject(label: string) {
	const [tenant] = await db
		.insert(tenants)
		.values({ name: `${label} Agency` })
		.returning();
	if (!tenant) throw new Error("tenant insert returned nothing");

	const [owner] = await db
		.insert(users)
		.values({ email: `${label}@run.test`, tenantId: tenant.id })
		.returning();
	if (!owner) throw new Error("user insert returned nothing");

	const [project] = await db
		.insert(projects)
		.values({
			tenantId: tenant.id,
			name: `${label} site`,
			startUrl: site.baseUrl,
			excludePaths: ["/private", "/flaky"],
			locales: ["en", "de", "fr"],
			maxConcurrency: 2,
			requestDelayMs: 0,
		})
		.returning();
	if (!project) throw new Error("project insert returned nothing");

	return { tenant, owner, project };
}

function callerFor(userId: string | null, tenantId: string | null) {
	return createCaller({
		db,
		session: userId ? { user: { id: userId }, expires: "" } : null,
		tenantId,
		headers: new Headers(),
	} as unknown as Parameters<typeof createCaller>[0]);
}

describe("run lifecycle", () => {
	it("completes a run and records what it found", async () => {
		const { tenant, project } = await seedProject("alpha");

		const { runId } = await runToCompletion(db, {
			tenantId: tenant.id,
			projectId: project.id,
		});

		const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });

		expect(run?.status).toBe(RUN_STATUS.DONE);
		expect(run?.startedAt).not.toBeNull();
		expect(run?.finishedAt).not.toBeNull();
		expect(run?.pagesCrawled).toBeGreaterThan(0);
		expect(run?.findingsCount).toBeGreaterThan(0);
	});

	it("persists pages with their locale and variant group", async () => {
		const { tenant, project } = await seedProject("beta");

		const { runId } = await runToCompletion(db, {
			tenantId: tenant.id,
			projectId: project.id,
		});

		const stored = await db.query.pages.findMany({
			where: eq(pages.runId, runId),
		});

		expect(stored.length).toBeGreaterThan(0);
		// Grouping runs after the crawl, so every page should carry a key.
		expect(stored.every((p) => p.variantGroupKey !== null)).toBe(true);

		const german = stored.find((p) => p.url.endsWith("/de/preise"));
		expect(german?.locale).toBe("de");
	});

	it("links findings to the page they are about", async () => {
		const { tenant, project } = await seedProject("gamma");

		const { runId } = await runToCompletion(db, {
			tenantId: tenant.id,
			projectId: project.id,
		});

		const stored = await db.query.findings.findMany({
			where: eq(findings.runId, runId),
		});

		expect(stored.length).toBeGreaterThan(0);
		expect(stored.some((f) => f.pageId !== null)).toBe(true);
	});

	it("records the abort reason when a crawl stops early", async () => {
		const { tenant, project } = await seedProject("delta");

		// Point the project at the always-failing hub and let the burst trigger.
		await db
			.update(projects)
			.set({ startUrl: `${site.baseUrl}/flaky-hub`, excludePaths: [] })
			.where(eq(projects.id, project.id));

		const { runId } = await runToCompletion(db, {
			tenantId: tenant.id,
			projectId: project.id,
		});

		const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });

		expect(run?.status).toBe(RUN_STATUS.FAILED);
		expect(run?.error).toMatch(/consecutive failures/i);
	});
});

describe("stale-run sweep", () => {
	it("closes runs a previous process left open", async () => {
		const { tenant, project } = await seedProject("epsilon");

		await db.insert(runs).values([
			{
				tenantId: tenant.id,
				projectId: project.id,
				status: RUN_STATUS.RUNNING,
			},
			{ tenantId: tenant.id, projectId: project.id, status: RUN_STATUS.QUEUED },
		]);

		const closed = await sweepStaleRuns(db);
		expect(closed).toBe(2);

		const all = await db.query.runs.findMany();
		expect(all.every((r) => r.status === RUN_STATUS.INTERRUPTED)).toBe(true);
		expect(all.every((r) => r.error !== null)).toBe(true);
	});

	it("leaves finished runs alone", async () => {
		const { tenant, project } = await seedProject("zeta");

		await db.insert(runs).values({
			tenantId: tenant.id,
			projectId: project.id,
			status: RUN_STATUS.DONE,
		});

		expect(await sweepStaleRuns(db)).toBe(0);
	});
});

describe("run procedures", () => {
	it("refuses a second run while one is active", async () => {
		const { tenant, owner, project } = await seedProject("eta");

		await db.insert(runs).values({
			tenantId: tenant.id,
			projectId: project.id,
			status: RUN_STATUS.RUNNING,
		});

		await expect(
			callerFor(owner.id, tenant.id).project.startRun({
				projectId: project.id,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	/**
	 * The isolation guarantee, restated for every surface this phase added. An id
	 * is not a permission: a caller holding another tenant's run id must still be
	 * refused.
	 */
	it("does not expose another tenant's run, pages or findings", async () => {
		const a = await seedProject("theta");
		const b = await seedProject("iota");

		const { runId } = await runToCompletion(db, {
			tenantId: a.tenant.id,
			projectId: a.project.id,
		});

		const intruder = callerFor(b.owner.id, b.tenant.id);

		await expect(intruder.project.runStatus({ runId })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(intruder.project.findings({ runId })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			intruder.project.byId({ projectId: a.project.id }),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(await intruder.project.runPages({ runId })).toEqual([]);
		expect(
			await intruder.project.latestRun({ projectId: a.project.id }),
		).toBeNull();
	});

	it("creates a project and reads it back", async () => {
		const { tenant, owner } = await seedProject("kappa");

		const created = await callerFor(owner.id, tenant.id).project.create({
			name: "New client",
			startUrl: "https://new-client.example/",
			locales: ["EN", "de"],
		});

		expect(created.name).toBe("New client");
		// Locales are normalised on the way in.
		expect(created.locales).toEqual(["en", "de"]);
	});

	it("rejects a start URL that is not a URL", async () => {
		const { tenant, owner } = await seedProject("lambda");

		await expect(
			callerFor(owner.id, tenant.id).project.create({
				name: "Bad",
				startUrl: "not-a-url",
				locales: [],
			}),
		).rejects.toThrow();
	});
});
