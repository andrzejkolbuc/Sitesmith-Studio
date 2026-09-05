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
 * Two crawls of one site, over real HTTP and a real database.
 *
 * The unit tests fix the matcher over rows somebody typed. This file is the one
 * that proves the whole path: a crawl produces findings, a second crawl of a
 * site that did or did not change produces its own, and the comparison says
 * something true about the difference.
 *
 * The load-bearing case is the *negative* one — an unchanged site reporting
 * nothing as new and nothing as resolved. Every false-positive incident this
 * product has had was a rule confidently describing a change that had not
 * happened, and a comparison is a machine for making that mistake at scale.
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
	// Patches are per-test state; a leak would change what a later crawl sees.
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
		.values({ email: `${label}@comparison.test`, tenantId: tenant.id })
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
	(await runToCompletion(db, { tenantId, projectId, maxRenders: 0 })).runId;

describe("run comparison over two real crawls", () => {
	/**
	 * The property the slice is judged on. Nothing about the site changed, so the
	 * product must claim nothing about it changed.
	 */
	it("reports no change when the site did not change", async () => {
		const { tenant, owner, project } = await seedProject("steady");

		await crawl(tenant.id, project.id);
		const second = await crawl(tenant.id, project.id);

		const result = await callerFor(owner.id, tenant.id).project.comparison({
			runId: second,
		});

		expect(result.comparability).toEqual({ comparable: true });
		expect(result.findings.length).toBeGreaterThan(0);

		const moved = result.findings.filter((f) => f.status !== "still_present");
		expect(
			moved.map((f) => `${f.status} ${f.type} ${JSON.stringify(f.detail)}`),
		).toEqual([]);
	});

	/**
	 * `/blog/monolingual` on purpose: it is linked from the homepage and belongs
	 * to no hreflang family, so breaking it produces one plain `link_broken`.
	 *
	 * A page inside a family behaves differently and correctly — when the second
	 * member of a three-page family dies, `variant_diverged` stops applying (it
	 * needs two healthy declarers) and the two broken siblings are reported
	 * through `hreflang_target_failed` instead. That is the site being described
	 * differently because it *is* different, but it makes for a test about the
	 * variant rules rather than about comparison.
	 */
	it("reports a page that broke between runs as a new finding", async () => {
		const { tenant, owner, project } = await seedProject("broke");

		await crawl(tenant.id, project.id);

		// A page linked from the homepage stops resolving, as a deploy might do.
		site.patch({ "/blog/monolingual": null });

		const second = await crawl(tenant.id, project.id);

		const result = await callerFor(owner.id, tenant.id).project.comparison({
			runId: second,
		});

		expect(result.comparability).toEqual({ comparable: true });

		const added = result.findings.filter((f) => f.status === "new");
		expect(
			added.filter(
				(f) =>
					f.type === "link_broken" &&
					String(f.detail.target).endsWith("/blog/monolingual"),
			),
			`expected one new link_broken, got ${JSON.stringify(
				added.map((f) => [f.type, f.detail.target ?? f.detail.url]),
			)}`,
		).toHaveLength(1);

		/**
		 * The rest of the movement, asserted rather than tolerated.
		 *
		 * The sitemap reconciliation keys on its URL set, as `identity.ts` records
		 * for the corpus-level rules that have no smaller invariant. The dead page
		 * joins that set, so the old finding resolves and a new one is raised. It
		 * is the documented cost of set-valued identity, and pinning it here means
		 * a future change to that decision fails a test instead of passing quietly.
		 */
		const moved = result.findings.filter((f) => f.status !== "still_present");
		expect(moved.map((f) => `${f.status} ${f.type}`).sort()).toEqual([
			"new link_broken",
			"new sitemap_url_failed",
			"resolved sitemap_url_failed",
		]);
	});

	it("reports a page that was repaired between runs as resolved", async () => {
		const { tenant, owner, project } = await seedProject("repaired");

		site.patch({ "/blog/monolingual": null });
		await crawl(tenant.id, project.id);

		// Put it back, the way a fix lands.
		site.reset();
		const second = await crawl(tenant.id, project.id);

		const result = await callerFor(owner.id, tenant.id).project.comparison({
			runId: second,
		});

		expect(result.comparability).toEqual({ comparable: true });

		const resolved = result.findings.filter((f) => f.status === "resolved");
		expect(
			resolved.filter(
				(f) =>
					f.type === "link_broken" &&
					String(f.detail.target).endsWith("/blog/monolingual"),
			),
			`expected the dead link resolved, got ${JSON.stringify(
				resolved.map((f) => [f.type, f.detail.target ?? f.detail.url]),
			)}`,
		).toHaveLength(1);

		// The mirror image of the case above, sitemap churn included.
		const moved = result.findings.filter((f) => f.status !== "still_present");
		expect(moved.map((f) => `${f.status} ${f.type}`).sort()).toEqual([
			"new sitemap_url_failed",
			"resolved link_broken",
			"resolved sitemap_url_failed",
		]);
	});

	/**
	 * The incident that motivated the guard, reproduced: a project narrowed
	 * between two runs. Every page outside the new scope is absent from the second
	 * crawl, and without the guard each of their findings would report as fixed.
	 */
	it("refuses to compare across a scope change", async () => {
		const { tenant, owner, project } = await seedProject("narrowed");

		await crawl(tenant.id, project.id);

		await db
			.update(projects)
			.set({ includePaths: ["/handbook"] })
			.where(eq(projects.id, project.id));

		const second = await crawl(tenant.id, project.id);

		const result = await callerFor(owner.id, tenant.id).project.comparison({
			runId: second,
		});

		expect(result.comparability).toEqual({
			comparable: false,
			reason: "scope_changed",
		});
		// The run's own findings still render; only the annotation is withheld.
		expect(result.findings.every((f) => f.status === null)).toBe(true);
	});

	/**
	 * A first run is an ordinary state. It must render exactly as it did before
	 * comparison existed rather than erroring or showing a refusal.
	 */
	it("annotates nothing when a run has no predecessor", async () => {
		const { tenant, owner, project } = await seedProject("first");

		const only = await crawl(tenant.id, project.id);

		const result = await callerFor(owner.id, tenant.id).project.comparison({
			runId: only,
		});

		expect(result.previousRunId).toBeNull();
		expect(result.comparability).toBeNull();
		expect(result.findings.every((f) => f.status === null)).toBe(true);
	});

	it("lists the project's runs newest first", async () => {
		const { tenant, owner, project } = await seedProject("history");

		const first = await crawl(tenant.id, project.id);
		const second = await crawl(tenant.id, project.id);

		const listed = await callerFor(owner.id, tenant.id).project.runs({
			projectId: project.id,
		});

		expect(listed.map((r) => r.id)).toEqual([second, first]);
	});

	it("does not expose another tenant's history or comparison", async () => {
		const a = await seedProject("owner-a");
		const b = await seedProject("owner-b");

		const runId = await crawl(a.tenant.id, a.project.id);
		const intruder = callerFor(b.owner.id, b.tenant.id);

		await expect(intruder.project.comparison({ runId })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(await intruder.project.runs({ projectId: a.project.id })).toEqual(
			[],
		);
	});
});
