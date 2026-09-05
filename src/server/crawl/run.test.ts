import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCaller } from "~/server/api/root";
import * as schema from "~/server/db/schema";
import {
	findings,
	pageObservations,
	pages,
	projects,
	runs,
	tenants,
	users,
} from "~/server/db/schema";
import { type Fixture, startFixtureSite } from "../../../test/fixtures/site";
import { resetDatabase } from "../../../test/reset";
import { FINDING_TYPES } from "./findings";
import { RUN_STATUS, runToCompletion, startRun, sweepStaleRuns } from "./run";

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
			maxRenders: 0,
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
			maxRenders: 0,
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
			maxRenders: 0,
		});

		const stored = await db.query.findings.findMany({
			where: eq(findings.runId, runId),
		});

		expect(stored.length).toBeGreaterThan(0);
		expect(stored.some((f) => f.pageId !== null)).toBe(true);
	});

	/**
	 * What a later run needs in order to be allowed to compare itself to this one.
	 *
	 * Asserted on the row rather than on the crawl result, because the point of
	 * this phase is that the answer survives the run — it was computed and thrown
	 * away before, and a comparison that cannot tell a truncated crawl from a
	 * complete one reports our own missing data as pages the client fixed.
	 */
	it("records what makes the run comparable", async () => {
		const { tenant, project } = await seedProject("mu");

		const { runId } = await runToCompletion(db, {
			tenantId: tenant.id,
			projectId: project.id,
			maxRenders: 0,
		});

		const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });

		expect(run?.crawlComplete).toBe(true);
		expect(run?.reachedPageLimit).toBe(false);
		expect(run?.scope).toEqual({
			includePaths: [],
			excludePaths: ["/private", "/flaky"],
			locales: ["en", "de", "fr"],
		});
	});

	/**
	 * The recorded rule set has to be the set the code actually has, not a list
	 * that drifted from it. Asserted against `FINDING_TYPES` itself rather than
	 * against a literal, so a rule added without the column following fails here
	 * — the failure this column exists to prevent is a silent one, where a type
	 * nobody was checking yet reads on the trend as a site with no problem.
	 */
	it("records the rule set that produced the run", async () => {
		const { tenant, project } = await seedProject("xi");

		const { runId } = await runToCompletion(db, {
			tenantId: tenant.id,
			projectId: project.id,
			maxRenders: 0,
		});

		const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });

		expect(run?.ruleSet).toEqual([...Object.values(FINDING_TYPES)].sort());
	});

	/**
	 * The render pass, wired end to end.
	 *
	 * The only case in this file that renders anything. Every other run test
	 * passes `maxRenders: 0`, because a browser costs seconds per page and twenty
	 * cases about crawling, comparison and tenancy would each pay for one while
	 * proving nothing this does not.
	 *
	 * What it fixes is the wiring: the sample is chosen from the crawl, the
	 * observations reach the table, and the run records what the pass covered so
	 * a reader can be told how much of the site the numbers describe.
	 */
	it("stores what the browser saw for the pages it sampled", async () => {
		const { tenant, project } = await seedProject("omicron");

		const { runId } = await runToCompletion(db, {
			tenantId: tenant.id,
			projectId: project.id,
			maxRenders: 2,
		});

		const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
		const observed = await db.query.pageObservations.findMany({
			where: eq(pageObservations.runId, runId),
		});

		expect(run?.renderSummary?.cap).toBe(2);
		expect(run?.renderSummary?.complete).toBe(true);
		expect(observed.length).toBeGreaterThan(0);
		expect(observed.length).toBeLessThanOrEqual(2);
		expect(run?.renderSummary?.chosen).toBe(observed.length);

		/** Every stored row belongs to a page this run actually recorded. */
		const pageIds = new Set(
			(
				await db.query.pages.findMany({
					where: eq(pages.runId, runId),
					columns: { id: true },
				})
			).map((page) => page.id),
		);
		expect(observed.every((o) => pageIds.has(o.pageId))).toBe(true);
	}, 60_000);

	/**
	 * A run that renders nothing is an ordinary run, not a broken one. The column
	 * says the pass covered nothing rather than going null, because null means
	 * *not recorded* and this run recorded an answer.
	 */
	it("records a render pass that was asked for nothing", async () => {
		const { tenant, project } = await seedProject("pi");

		const { runId } = await runToCompletion(db, {
			tenantId: tenant.id,
			projectId: project.id,
			maxRenders: 0,
		});

		const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });

		expect(run?.renderSummary).toEqual({
			chosen: 0,
			measured: 0,
			cap: 0,
			complete: true,
		});
		expect(run?.status).toBe(RUN_STATUS.DONE);
	});

	/**
	 * The case the snapshot exists for. A project narrowed after its first run is
	 * the situation that produced this column: the same site, crawled under two
	 * different instructions, where every page outside the new scope would
	 * otherwise read as a problem that had been fixed.
	 */
	it("snapshots a narrowed scope rather than the empty default", async () => {
		const { tenant, project } = await seedProject("nu");

		await db
			.update(projects)
			.set({ includePaths: ["/handbook"] })
			.where(eq(projects.id, project.id));

		const { runId } = await runToCompletion(db, {
			tenantId: tenant.id,
			projectId: project.id,
			maxRenders: 0,
		});

		const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });

		expect(run?.scope?.includePaths).toEqual(["/handbook"]);
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
			maxRenders: 0,
		});

		const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });

		expect(run?.status).toBe(RUN_STATUS.FAILED);
		expect(run?.error).toMatch(/consecutive failures/i);
	});

	/**
	 * The negative half of the column, proven on a real abort rather than on a
	 * constructed row. A boolean tested only in its true state is a boolean whose
	 * false branch nothing has ever exercised — and false is the branch that stops
	 * a comparison from running.
	 */
	it("marks an aborted run as not comparable", async () => {
		const { tenant, project } = await seedProject("xi");

		await db
			.update(projects)
			.set({ startUrl: `${site.baseUrl}/flaky-hub`, excludePaths: [] })
			.where(eq(projects.id, project.id));

		const { runId } = await runToCompletion(db, {
			tenantId: tenant.id,
			projectId: project.id,
			maxRenders: 0,
		});

		const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });

		expect(run?.crawlComplete).toBe(false);
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
			maxRenders: 0,
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

describe("crawl scope chosen at creation", () => {
	/**
	 * Slower than its neighbours on purpose, and given room to be.
	 *
	 * Every other test here seeds a project row directly with no request delay.
	 * This one goes through `project.create`, so it inherits the real politeness
	 * defaults — two at a time, 500ms apart — which is the point: it proves the
	 * row the creation form produces behaves correctly, pacing included. It also
	 * means the wall-clock cost grows with the fixture, and it was already at
	 * 5017ms against a 5000ms limit before this slice added pages to the site.
	 */
	it("never requests a path the project excluded", {
		timeout: 30_000,
	}, async () => {
		/**
		 * The chain this covers is the one that breaks: the crawler's own exclusion
		 * is unit-tested, and the stored column is read correctly, but nothing
		 * proved that a scope entered when the project was created survives the
		 * trip into a run. It is worth proving because of what it protects — the
		 * paths an operator excludes are the ones that do work when fetched, and
		 * the requirement is explicit that causing a client incident is worse than
		 * the regression being hunted.
		 */
		const { tenant, owner } = await seedProject("scoped");

		const project = await callerFor(owner.id, tenant.id).project.create({
			name: "scoped by the operator",
			startUrl: site.baseUrl,
			locales: ["en", "de"],
			excludePaths: ["/private"],
			includePaths: [],
		});

		expect(project.excludePaths).toEqual(["/private"]);

		await runToCompletion(db, {
			tenantId: tenant.id,
			projectId: project.id,
			maxRenders: 0,
		});

		/**
		 * Asserted against what the server was actually asked for, not against what
		 * was stored afterwards. A page that was fetched and then discarded would
		 * still have hit the client's site, which is the thing being prevented.
		 */
		const forbidden = site.requests.filter((path) =>
			path.startsWith("/private"),
		);
		expect(forbidden).toEqual([]);

		// And the run still did its job, rather than passing by crawling nothing.
		const crawled = await db.query.pages.findMany();
		expect(crawled.length).toBeGreaterThan(1);
	});
});

describe("progress while a run is in flight", () => {
	/**
	 * Reported from the interface: a check shows "Crawling", the duration ticks,
	 * and "Pages crawled" sits at zero until the whole thing finishes.
	 *
	 * The ticking is what makes it convincing — the duration is computed against
	 * the current time on every poll, so the panel looks alive while the numbers
	 * beside it are frozen. A run of two thousand pages would show nothing moving
	 * for minutes and give an operator no way to tell it apart from a hang.
	 */
	it("raises the page count as the crawl proceeds, not only at the end", async () => {
		const { tenant, owner } = await seedProject("progress");

		/**
		 * Paced slowly enough to observe. Every other test here runs with no delay,
		 * which finishes before anything could poll it.
		 */
		const project = await callerFor(owner.id, tenant.id).project.create({
			name: "paced",
			startUrl: site.baseUrl,
			locales: ["en"],
			includePaths: [],
			excludePaths: ["/private", "/flaky"],
		});
		await db
			.update(projects)
			.set({ requestDelayMs: 250, maxConcurrency: 1 })
			.where(eq(projects.id, project.id));

		const { runId } = await startRun(db, {
			tenantId: tenant.id,
			projectId: project.id,
			maxRenders: 0,
		});

		/**
		 * Poll the way the interface does, recording what it would have shown — then
		 * keep polling until the run is genuinely finished.
		 *
		 * The waiting is not politeness. `startRun` returns immediately and crawls
		 * in the background, so a test that stops watching leaves inserts in flight;
		 * the next test truncates the database underneath them and the failures land
		 * somewhere else entirely, as foreign keys on a tenant that no longer exists.
		 */
		const TERMINAL: string[] = [
			RUN_STATUS.DONE,
			RUN_STATUS.FAILED,
			RUN_STATUS.INTERRUPTED,
		];

		let seenWhileRunning = 0;
		let finished = false;

		for (let i = 0; i < 400; i++) {
			await new Promise((r) => setTimeout(r, 50));
			const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
			if (!run) continue;
			if (run.status === RUN_STATUS.RUNNING) {
				seenWhileRunning = Math.max(seenWhileRunning, run.pagesCrawled);
			}
			if (TERMINAL.includes(run.status)) {
				finished = true;
				break;
			}
		}

		// Loudly, rather than by corrupting whatever runs next.
		expect(finished, "the run never reached a terminal status").toBe(true);
		expect(seenWhileRunning).toBeGreaterThan(0);
	}, 60_000);
});
