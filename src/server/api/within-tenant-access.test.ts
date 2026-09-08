import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createCaller } from "~/server/api/root";
import type { UserRole } from "~/server/auth/roles";
import {
	projectAssignments,
	projects,
	runs,
	tenants,
	users,
} from "~/server/db/schema";
import { resetDatabase } from "../../../test/reset";

/**
 * Restriction *inside* one tenant.
 *
 * `tenant-isolation.test.ts` asserts that one agency cannot reach another's
 * data, and until roles existed that was the whole of authorization — everyone
 * inside a tenant could reach everything in it, so there was nothing else to
 * assert. This file covers the dimension that assertion cannot see: an account
 * that is legitimately in the tenant, holding an identifier that legitimately
 * belongs to it, and still having no business reading it.
 *
 * Two properties are worth stating about how this is written.
 *
 * **The refusal shape is asserted, not just the absence of data.** A Team-member
 * pointed at an unassigned project must get the same answer as one pointed at a
 * project that was never created — `NOT_FOUND`, never `FORBIDDEN`. The
 * difference is not cosmetic: a Client-viewer who can tell "exists but not
 * yours" from "does not exist" can enumerate the agency's client list one
 * identifier at a time, which is the thing the product promises they cannot do.
 *
 * **Capability and reachability are separated.** A viewer denied `startRun` on
 * their *own* project is a capability refusal and answers `FORBIDDEN`, because
 * concealing a project they can already see would protect nothing. The same
 * viewer denied `startRun` on someone else's project must answer `NOT_FOUND`.
 * Both are asserted, because getting the order wrong inside the procedure is
 * exactly how a 403 ends up confirming a project's existence.
 */

const databaseUrl = process.env.DATABASE_URL ?? "";

if (!new URL(databaseUrl).pathname.endsWith("-test")) {
	throw new Error(
		`Refusing to run: DATABASE_URL does not point at a "-test" database. These tests truncate tables.`,
	);
}

const connection = postgres(databaseUrl, { max: 1 });
const db = drizzle(connection, {
	schema: { projectAssignments, projects, runs, tenants, users },
});

function callerFor(
	userId: string,
	tenantId: string,
	role: UserRole,
	assignedProjectIds: string[] | null,
) {
	return createCaller({
		db,
		session: { user: { id: userId }, expires: "" },
		tenantId,
		role,
		assignedProjectIds,
		headers: new Headers(),
	} as unknown as Parameters<typeof createCaller>[0]);
}

/**
 * One agency, two client sites, three people.
 *
 * Two projects rather than one is the whole point: with a single project there
 * is no difference between "assigned" and "unrestricted", and every assertion
 * below would pass against a build that ignored assignments entirely.
 */
async function seedTenant() {
	const [tenant] = await db
		.insert(tenants)
		.values({ name: "Within Agency" })
		.returning();
	if (!tenant) throw new Error("tenant insert returned nothing");

	const insertUser = async (label: string, role: UserRole) => {
		const [user] = await db
			.insert(users)
			.values({
				email: `${label}@within.test`,
				tenantId: tenant.id,
				role,
			})
			.returning();
		if (!user) throw new Error(`${label} insert returned nothing`);
		return user;
	};

	const insertProject = async (label: string) => {
		const [project] = await db
			.insert(projects)
			.values({
				tenantId: tenant.id,
				name: `${label} client site`,
				startUrl: `https://${label}.within.test/`,
			})
			.returning();
		if (!project) throw new Error(`${label} project insert returned nothing`);

		/**
		 * Left at the `queued` default, which counts as active. That is deliberate
		 * and load-bearing for the `startRun` case below — see the comment there.
		 */
		const [run] = await db
			.insert(runs)
			.values({ tenantId: tenant.id, projectId: project.id })
			.returning();
		if (!run) throw new Error(`${label} run insert returned nothing`);

		return { project, run };
	};

	const owner = await insertUser("owner", "owner");
	const member = await insertUser("member", "member");
	const viewer = await insertUser("viewer", "viewer");

	const alpha = await insertProject("alpha");
	const beta = await insertProject("beta");

	await db.insert(projectAssignments).values([
		{ tenantId: tenant.id, userId: member.id, projectId: alpha.project.id },
		{ tenantId: tenant.id, userId: viewer.id, projectId: beta.project.id },
	]);

	return { tenant, owner, member, viewer, alpha, beta };
}

type Seed = Awaited<ReturnType<typeof seedTenant>>;

let seed: Seed;

beforeEach(async () => {
	await resetDatabase(connection);
	seed = await seedTenant();
});

afterAll(async () => {
	await connection.end();
});

const callers = () => ({
	owner: callerFor(seed.owner.id, seed.tenant.id, "owner", null),
	member: callerFor(seed.member.id, seed.tenant.id, "member", [
		seed.alpha.project.id,
	]),
	viewer: callerFor(seed.viewer.id, seed.tenant.id, "viewer", [
		seed.beta.project.id,
	]),
});

async function codeOf(call: Promise<unknown>): Promise<string> {
	try {
		await call;
		return "ok";
	} catch (caught) {
		const code = (caught as { code?: string }).code;
		return code ?? "unknown";
	}
}

describe("the project list", () => {
	it("shows each role exactly what it may reach", async () => {
		const { owner, member, viewer } = callers();

		const names = async (caller: ReturnType<typeof callerFor>) =>
			(await caller.project.list()).map((p) => p.name).sort();

		expect({
			owner: await names(owner),
			member: await names(member),
			viewer: await names(viewer),
		}).toEqual({
			owner: ["alpha client site", "beta client site"],
			member: ["alpha client site"],
			viewer: ["beta client site"],
		});
	});

	/**
	 * The silent failure this guards. `inArray(column, [])` is not reliably an
	 * empty result, and a build where it degrades to no filter at all would show
	 * an unassigned member the whole tenant while every other assertion in this
	 * file still passed.
	 */
	it("shows nothing to a member assigned to nothing", async () => {
		const stranded = callerFor(seed.member.id, seed.tenant.id, "member", []);

		await expect(stranded.project.list()).resolves.toEqual([]);
	});
});

describe("reads of an unreachable project", () => {
	/**
	 * Every procedure that takes a project or run identifier, pointed by the
	 * member at the project they were not assigned. Enumerated as a table so a
	 * procedure added later without an access check shows up as a missing row
	 * rather than as silence.
	 */
	const unreachable = (s: Seed) => ({
		"project.byId": { projectId: s.beta.project.id },
		"project.latestRun": { projectId: s.beta.project.id },
		"project.runs": { projectId: s.beta.project.id },
		"project.trend": { projectId: s.beta.project.id },
		"project.runStatus": { runId: s.beta.run.id },
		"project.findings": { runId: s.beta.run.id },
		"project.comparison": { runId: s.beta.run.id },
		"project.runObservations": { runId: s.beta.run.id },
		"project.runSnapshots": { runId: s.beta.run.id },
		"project.runPages": { runId: s.beta.run.id },
	});

	it("refuses all of them as not-found, never as forbidden", async () => {
		const { member } = callers();
		const cases = unreachable(seed);

		const results: Record<string, string> = {};
		for (const [path, input] of Object.entries(cases)) {
			const [, procedure] = path.split(".") as [string, string];
			const call = (
				member.project as unknown as Record<
					string,
					(arg: unknown) => Promise<unknown>
				>
			)[procedure];
			if (!call) throw new Error(`no such procedure: ${path}`);
			results[path] = await codeOf(call(input));
		}

		const expected = Object.fromEntries(
			Object.keys(cases).map((path) => [path, "NOT_FOUND"]),
		);

		expect(results).toEqual(expected);
	});

	/**
	 * The same identifiers, read by the person who *is* assigned to them. Without
	 * this the test above would pass against a build that refused everything.
	 */
	it("allows the same reads for the caller assigned to that project", async () => {
		const { viewer } = callers();

		await expect(
			viewer.project.byId({ projectId: seed.beta.project.id }),
		).resolves.toMatchObject({ name: "beta client site" });
		await expect(
			viewer.project.runStatus({ runId: seed.beta.run.id }),
		).resolves.toMatchObject({ id: seed.beta.run.id });
		await expect(
			viewer.project.runs({ projectId: seed.beta.project.id }),
		).resolves.toHaveLength(1);
	});
});

describe("writes", () => {
	it("refuses project creation to anyone but the owner", async () => {
		const { member, viewer } = callers();
		const input = { name: "sneaky", startUrl: "https://sneaky.test/" };

		expect({
			member: await codeOf(member.project.create(input)),
			viewer: await codeOf(viewer.project.create(input)),
		}).toEqual({ member: "FORBIDDEN", viewer: "FORBIDDEN" });
	});

	it("refuses project configuration to anyone but the owner", async () => {
		const { member, viewer } = callers();

		expect({
			memberMasks: await codeOf(
				member.project.setMasks({
					projectId: seed.alpha.project.id,
					selectors: [".ad"],
				}),
			),
			viewerMasks: await codeOf(
				viewer.project.setMasks({
					projectId: seed.beta.project.id,
					selectors: [".ad"],
				}),
			),
			memberBaseline: await codeOf(
				member.project.pinBaseline({
					projectId: seed.alpha.project.id,
					runId: seed.alpha.run.id,
				}),
			),
		}).toEqual({
			memberMasks: "FORBIDDEN",
			viewerMasks: "FORBIDDEN",
			memberBaseline: "FORBIDDEN",
		});
	});

	/**
	 * The capability-versus-reachability distinction, asserted as one object so a
	 * build that collapses the two fails with both halves visible.
	 *
	 * `memberOnAssigned` expects `CONFLICT`, and that is the assertion, not a
	 * concession. Each seeded project already has an active run, so a caller who
	 * clears both authorization gates lands on the pre-existing "one run at a
	 * time" guard. Reaching that guard is therefore proof the member was allowed
	 * — and it stops short of actually launching a crawl, which in this suite
	 * would mean a real fetch against a domain that does not resolve, writing run
	 * rows back into a database the next test has already truncated.
	 */
	it("lets an assigned member run a check and refuses a viewer", async () => {
		const { member, viewer } = callers();

		expect({
			memberOnAssigned: await codeOf(
				member.project.startRun({ projectId: seed.alpha.project.id }),
			),
			memberOnUnassigned: await codeOf(
				member.project.startRun({ projectId: seed.beta.project.id }),
			),
			viewerOnOwn: await codeOf(
				viewer.project.startRun({ projectId: seed.beta.project.id }),
			),
			viewerOnOther: await codeOf(
				viewer.project.startRun({ projectId: seed.alpha.project.id }),
			),
		}).toEqual({
			memberOnAssigned: "CONFLICT",
			memberOnUnassigned: "NOT_FOUND",
			viewerOnOwn: "FORBIDDEN",
			viewerOnOther: "NOT_FOUND",
		});
	});

	/**
	 * A refusal must leave nothing behind. `startRun` writes a row before it does
	 * any crawling, so a check applied after the write would look identical from
	 * the caller's side and still have created the run.
	 */
	it("writes no run when a check is refused", async () => {
		const { viewer } = callers();

		await codeOf(viewer.project.startRun({ projectId: seed.beta.project.id }));

		const rows = await db.query.runs.findMany();
		expect(rows).toHaveLength(2);
	});
});
