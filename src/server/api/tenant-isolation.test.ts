import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appRouter, createCaller } from "~/server/api/root";
import {
	findings,
	pages,
	projects,
	runs,
	tenants,
	users,
} from "~/server/db/schema";
import { resetDatabase } from "../../../test/reset";

/**
 * Tenant isolation, asserted against the router rather than against a list of
 * procedures someone remembered to add.
 *
 * The risk this covers is not that today's queries leak — `project.test.ts`
 * already pins those. It is the router written next month: thirteen roadmap
 * slices remain, each adding read paths, and a single missing `tenantScope` in
 * one of them is the whole failure. So the cases below are generated from
 * `appRouter` itself, and the last test refuses to pass while any procedure is
 * unclassified. Adding a procedure therefore breaks this file until its
 * isolation behaviour has been stated.
 *
 * The assertion is deliberately blunt: whatever a procedure returns to the
 * wrong tenant, none of the other tenant's identifiers may appear anywhere in
 * it. That holds for shapes this test knows nothing about, which is the point —
 * a future procedure returning some new nested payload is still covered.
 */

const databaseUrl = process.env.DATABASE_URL ?? "";

// The same guard as every other file here that truncates. See project.test.ts
// for why it is repeated rather than centralised.
if (!new URL(databaseUrl).pathname.endsWith("-test")) {
	throw new Error(
		`Refusing to run: DATABASE_URL does not point at a "-test" database. These tests truncate tables.`,
	);
}

const connection = postgres(databaseUrl, { max: 1 });
const db = drizzle(connection, {
	schema: { findings, pages, projects, runs, tenants, users },
});

function callerFor(userId: string, tenantId: string) {
	return createCaller({
		db,
		session: { user: { id: userId }, expires: "" },
		tenantId,
		headers: new Headers(),
	} as unknown as Parameters<typeof createCaller>[0]);
}

/** A tenant with one of everything, so every read path has something to leak. */
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
			locales: ["en", "de"],
		})
		.returning();
	if (!project) throw new Error("project insert returned nothing");

	const [run] = await db
		.insert(runs)
		.values({
			tenantId: tenant.id,
			projectId: project.id,
			status: "done",
			pagesCrawled: 1,
			findingsCount: 1,
		})
		.returning();
	if (!run) throw new Error("run insert returned nothing");

	const [page] = await db
		.insert(pages)
		.values({
			tenantId: tenant.id,
			runId: run.id,
			url: `https://${label}.isolation.test/de`,
			httpStatus: 200,
			locale: "de",
		})
		.returning();
	if (!page) throw new Error("page insert returned nothing");

	const [finding] = await db
		.insert(findings)
		.values({
			tenantId: tenant.id,
			runId: run.id,
			type: "missing_locale",
			pageId: page.id,
			detail: { groupKey: `https://${label}.isolation.test/`, missing: "fr" },
		})
		.returning();
	if (!finding) throw new Error("finding insert returned nothing");

	return { tenant, owner, project, run, page, finding };
}

type Seed = Awaited<ReturnType<typeof seedTenant>>;

/**
 * How each procedure is exercised with another tenant's identifiers.
 *
 * `foreign-id` procedures accept an identifier the caller could have obtained
 * from anywhere — a shared link, a log line, a guess — which is exactly the
 * shape of the attack. `no-tenant-input` procedures take no such identifier and
 * are covered by their own tests below; they are listed here anyway so that the
 * completeness check at the end has an entry for every procedure.
 */
type Case =
	| { kind: "foreign-id"; input: (victim: Seed) => unknown }
	| { kind: "no-tenant-input"; why: string };

const CASES: Record<string, Case> = {
	"project.list": {
		kind: "no-tenant-input",
		why: "takes no identifier; scoping is asserted by the list test below",
	},
	"project.create": {
		kind: "no-tenant-input",
		why: "writes rather than reads; the stamped tenant is asserted below",
	},
	"project.byId": {
		kind: "foreign-id",
		input: (victim) => ({ projectId: victim.project.id }),
	},
	"project.startRun": {
		kind: "foreign-id",
		input: (victim) => ({ projectId: victim.project.id }),
	},
	"project.latestRun": {
		kind: "foreign-id",
		input: (victim) => ({ projectId: victim.project.id }),
	},
	"project.runStatus": {
		kind: "foreign-id",
		input: (victim) => ({ runId: victim.run.id }),
	},
	"project.findings": {
		kind: "foreign-id",
		input: (victim) => ({ runId: victim.run.id }),
	},
	"project.runPages": {
		kind: "foreign-id",
		input: (victim) => ({ runId: victim.run.id }),
	},
	"project.runs": {
		kind: "foreign-id",
		input: (victim) => ({ projectId: victim.project.id }),
	},
	"project.comparison": {
		kind: "foreign-id",
		input: (victim) => ({ runId: victim.run.id }),
	},
	"project.runObservations": {
		kind: "foreign-id",
		input: (victim) => ({ runId: victim.run.id }),
	},
	"project.trend": {
		kind: "foreign-id",
		input: (victim) => ({ projectId: victim.project.id }),
	},
};

/** Walks `caller.project.byId` from the string "project.byId". */
function invoke(
	caller: ReturnType<typeof callerFor>,
	path: string,
	input: unknown,
): Promise<unknown> {
	const fn = path
		.split(".")
		.reduce<unknown>(
			(node, key) => (node as Record<string, unknown>)?.[key],
			caller,
		);

	if (typeof fn !== "function") {
		throw new Error(`${path} is not callable on the caller`);
	}
	return (fn as (arg: unknown) => Promise<unknown>)(input);
}

/** Every string that would identify the victim tenant if it surfaced. */
function fingerprints(victim: Seed): Array<[label: string, value: string]> {
	return [
		["tenant id", victim.tenant.id],
		["project id", victim.project.id],
		["project name", victim.project.name],
		["start url", victim.project.startUrl],
		["run id", victim.run.id],
		["page id", victim.page.id],
		["page url", victim.page.url],
		["finding id", victim.finding.id],
		["owner email", victim.owner.email ?? ""],
	];
}

beforeEach(async () => {
	await resetDatabase(connection);
});

afterAll(async () => {
	/**
	 * Left clean for whoever runs next. These files share one database and run
	 * sequentially, and a leftover run row would make the next file's `delete
	 * projects` fail on a foreign key rather than on anything it did wrong.
	 */
	await resetDatabase(connection);
	await connection.end();
});

describe("a caller holding another tenant's identifier", () => {
	const foreignIdCases = Object.entries(CASES).flatMap(([path, entry]) =>
		entry.kind === "foreign-id" ? [[path, entry] as const] : [],
	);

	for (const [path, entry] of foreignIdCases) {
		it(`${path} reveals nothing about the other tenant`, async () => {
			const victim = await seedTenant("victim");
			const intruder = await seedTenant("intruder");

			const caller = callerFor(intruder.owner.id, intruder.tenant.id);

			/**
			 * A refusal and an empty answer are both acceptable outcomes; the
			 * procedures differ in which they give, and pinning that per procedure
			 * would make this file break on harmless changes. What must never happen
			 * is the victim's data coming back, so a throw is folded into the value
			 * and searched alongside a successful return — an error message that
			 * quoted the row would leak just as effectively.
			 */
			let outcome: unknown;
			try {
				outcome = await invoke(caller, path, entry.input(victim));
			} catch (caught) {
				outcome = {
					refused: caught instanceof Error ? caught.message : String(caught),
				};
			}

			const serialised = JSON.stringify(outcome ?? null);

			for (const [label, value] of fingerprints(victim)) {
				if (!value) continue;
				expect(
					serialised.includes(value),
					`${path} leaked the other tenant's ${label}`,
				).toBe(false);
			}
		});
	}

	it("cannot start a run on another tenant's project", async () => {
		const victim = await seedTenant("victim");
		const intruder = await seedTenant("intruder");

		await expect(
			callerFor(intruder.owner.id, intruder.tenant.id).project.startRun({
				projectId: victim.project.id,
			}),
		).rejects.toThrow();

		/**
		 * Refusing is not enough on its own — a write that happened before the
		 * refusal would still be a write. No run may exist against the victim's
		 * project beyond the one seeded with it.
		 */
		const victimRuns = await db.query.runs.findMany({
			where: (run, { eq }) => eq(run.projectId, victim.project.id),
		});
		expect(victimRuns).toHaveLength(1);
		expect(victimRuns[0]?.id).toBe(victim.run.id);
	});
});

describe("procedures that take no tenant-owned identifier", () => {
	it("list returns only the caller's own projects", async () => {
		const victim = await seedTenant("victim");
		const intruder = await seedTenant("intruder");

		const seen = await callerFor(
			intruder.owner.id,
			intruder.tenant.id,
		).project.list();

		expect(seen.map((p) => p.name)).toEqual([intruder.project.name]);
		expect(seen.some((p) => p.tenantId === victim.tenant.id)).toBe(false);
	});

	it("create stamps the caller's tenant, not one supplied by the caller", async () => {
		const victim = await seedTenant("victim");
		const intruder = await seedTenant("intruder");

		/**
		 * The extra key is the test. It is not in the input schema, so it should be
		 * ignored rather than honoured — a procedure that spread its input into the
		 * insert would take it, and the row would land in the victim's tenant.
		 */
		const created = await callerFor(
			intruder.owner.id,
			intruder.tenant.id,
		).project.create({
			name: "planted",
			startUrl: "https://planted.isolation.test/",
			locales: ["en"],
			tenantId: victim.tenant.id,
		} as Parameters<ReturnType<typeof callerFor>["project"]["create"]>[0] & {
			tenantId: string;
		});

		expect(created.tenantId).toBe(intruder.tenant.id);
		expect(created.tenantId).not.toBe(victim.tenant.id);
	});
});

describe("the classification above", () => {
	/**
	 * The guard that makes this file worth more than the sum of its cases.
	 *
	 * Every procedure on the router must be classified. A new one — on a new
	 * router, added by someone who has never read this file — arrives
	 * unclassified and fails here, naming itself. That converts "remember to test
	 * isolation" from a habit into a build error, which is the only form of it
	 * that survives thirteen more slices.
	 */
	it("accounts for every procedure the router exposes", () => {
		const exposed = Object.keys(
			(
				appRouter as unknown as {
					_def: { procedures: Record<string, unknown> };
				}
			)._def.procedures,
		).sort();

		const classified = Object.keys(CASES).sort();

		expect(
			classified,
			"a procedure is missing from CASES in this file: classify it as 'foreign-id' if it accepts an identifier a caller could obtain elsewhere, or 'no-tenant-input' with a reason if it does not",
		).toEqual(exposed);
	});
});
