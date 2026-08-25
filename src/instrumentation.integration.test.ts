import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { RUN_STATUS } from "~/server/crawl/run";
import { projects, runs, tenants } from "~/server/db/schema";
import { resetDatabase } from "../test/reset";
import { register } from "./instrumentation";

/**
 * What a restart does to a run that was still going.
 *
 * Crawls execute in the web process, so a crash, a deploy or a laptop lid
 * closing leaves a row saying `running` that nothing is running. Left alone it
 * is indistinguishable from a slow crawl — the interface polls forever, the
 * project cannot start another check because one is "already active", and the
 * operator has no way to tell a stuck run from a patient one.
 *
 * `run.test.ts` already covers the sweep's own logic. What it cannot cover is
 * whether anything calls it, which is the half that actually fails: a sweep that
 * works perfectly and is never reached leaves every symptom above in place. So
 * this exercises `register` — the real entry point, with its real runtime guard
 * and its real database import — rather than the function it delegates to.
 *
 * The one link still unproven is that Next.js invokes `register` on boot, which
 * is the framework's contract rather than ours.
 */

const databaseUrl = process.env.DATABASE_URL ?? "";

if (!new URL(databaseUrl).pathname.endsWith("-test")) {
	throw new Error(
		`Refusing to run: DATABASE_URL does not point at a "-test" database. These tests truncate tables.`,
	);
}

const connection = postgres(databaseUrl, { max: 1 });
const db = drizzle(connection, { schema: { projects, runs, tenants } });

const originalRuntime = process.env.NEXT_RUNTIME;

async function seedRunWithStatus(status: string) {
	const [tenant] = await db
		.insert(tenants)
		.values({ name: "Restart Agency" })
		.returning();
	if (!tenant) throw new Error("tenant insert returned nothing");

	const [project] = await db
		.insert(projects)
		.values({
			tenantId: tenant.id,
			name: "client site",
			startUrl: "https://restart.test/",
		})
		.returning();
	if (!project) throw new Error("project insert returned nothing");

	const [run] = await db
		.insert(runs)
		.values({ tenantId: tenant.id, projectId: project.id, status })
		.returning();
	if (!run) throw new Error("run insert returned nothing");

	return run;
}

beforeEach(async () => {
	await resetDatabase(connection);
	process.env.NEXT_RUNTIME = "nodejs";
});

afterEach(() => {
	if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
	else process.env.NEXT_RUNTIME = originalRuntime;
});

afterAll(async () => {
	await resetDatabase(connection);
	await connection.end();
});

describe("startup", () => {
	it("closes a run that was still going when the process died", async () => {
		const stranded = await seedRunWithStatus(RUN_STATUS.RUNNING);

		await register();

		const after = await db.query.runs.findFirst();
		expect(after?.id).toBe(stranded.id);
		expect(after?.status).toBe(RUN_STATUS.INTERRUPTED);

		/**
		 * A finish time matters as much as the status. The interface computes
		 * duration from these two, and a closed run without one renders as a check
		 * that has been going for however long ago it started.
		 */
		expect(after?.finishedAt).toBeInstanceOf(Date);
	});

	it("closes a run that never got past queued", async () => {
		/**
		 * The narrower window, and the more confusing one: the row exists because
		 * `startRun` writes it before crawling begins, so a process dying in that
		 * gap leaves a check that never started and never will.
		 */
		await seedRunWithStatus(RUN_STATUS.QUEUED);

		await register();

		const after = await db.query.runs.findFirst();
		expect(after?.status).toBe(RUN_STATUS.INTERRUPTED);
	});

	it("says what happened, in terms an operator can act on", async () => {
		await seedRunWithStatus(RUN_STATUS.RUNNING);

		await register();

		const after = await db.query.runs.findFirst();

		/**
		 * The distinction the message has to carry: the check did not find a
		 * problem with the site and did not fail against it — the tool stopped. An
		 * operator who cannot tell those apart will go looking at the client's
		 * server for a fault that is ours.
		 */
		expect(after?.error).toMatch(/restarted/i);
		expect(after?.error?.length).toBeGreaterThan(20);
	});

	it("leaves a finished run untouched on the next restart", async () => {
		/**
		 * Restarts are ordinary — every deploy is one. A sweep that touched
		 * completed runs would rewrite history a little on each one, and the
		 * finished times an operator reads would drift away from when the check
		 * actually ran.
		 */
		const done = await seedRunWithStatus(RUN_STATUS.DONE);

		await register();
		await register();

		const after = await db.query.runs.findFirst();
		expect(after?.status).toBe(RUN_STATUS.DONE);
		expect(after?.error).toBeNull();
		expect(after?.finishedAt).toEqual(done.finishedAt);
	});

	it("does nothing outside the node runtime", async () => {
		/**
		 * The guard exists because this file is evaluated in the edge runtime too,
		 * where importing the Postgres driver fails outright. Asserted through
		 * behaviour rather than by inspecting the import: the run stays open, which
		 * is only possible if the module was never loaded.
		 */
		process.env.NEXT_RUNTIME = "edge";
		await seedRunWithStatus(RUN_STATUS.RUNNING);

		await register();

		const after = await db.query.runs.findFirst();
		expect(after?.status).toBe(RUN_STATUS.RUNNING);
	});
});
