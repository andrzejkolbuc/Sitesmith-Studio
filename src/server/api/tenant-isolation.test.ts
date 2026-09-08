import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "~/app/api/snapshots/[snapshotId]/route";
import { appRouter, createCaller } from "~/server/api/root";
import { auth } from "~/server/auth";
import { hashInviteToken } from "~/server/auth/invite";
import type { UserRole } from "~/server/auth/roles";
import {
	findings,
	invites,
	pageSnapshots,
	pages,
	projectAssignments,
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
	schema: {
		findings,
		invites,
		pages,
		pageSnapshots,
		projectAssignments,
		projects,
		runs,
		tenants,
		users,
	},
});

/**
 * Defaults to an Owner with unrestricted project access, which is what every
 * caller in this file is: the question here is cross-tenant leakage, and giving
 * the intruder the *most* authority their own tenant can grant is the sharpest
 * form of it. Within-tenant restriction is a different question, asserted in
 * `within-tenant-access.test.ts`.
 *
 * `assignedProjectIds: null` means unrestricted, not "assigned to nothing" —
 * see `createTRPCContext`.
 */
function callerFor(
	userId: string,
	tenantId: string,
	role: UserRole = "owner",
	assignedProjectIds: string[] | null = null,
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
 * The session the snapshot route reads, and nothing else.
 *
 * `~/server/auth` builds a NextAuth instance at import time, which needs a
 * request context this test has no way to produce. Stubbing it substitutes only
 * *who is calling* — the tenant lookup, the scoped query and the 404 are all
 * the handler's own code running against the real schema.
 */
vi.mock("~/server/auth", () => ({ auth: vi.fn() }));

/**
 * Narrowed to what the handler actually reads. NextAuth's own `auth` is
 * overloaded across four call shapes, and threading its return type through the
 * stub would say nothing about this test beyond how that overload is declared.
 */
const mockedAuth = vi.mocked(auth) as unknown as {
	mockResolvedValue: (session: { user: { id: string } } | null) => void;
};

function signedInAs(userId: string) {
	mockedAuth.mockResolvedValue({ user: { id: userId } });
}

function signedOut() {
	mockedAuth.mockResolvedValue(null);
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

	const [snapshot] = await db
		.insert(pageSnapshots)
		.values({
			tenantId: tenant.id,
			runId: run.id,
			pageId: page.id,
			image: Buffer.from(`png-${label}`),
			byteSize: 8,
			imageWidth: 1280,
			imageHeight: 900,
			viewportWidth: 1280,
			viewportHeight: 800,
			maskSelectors: [],
		})
		.returning();
	if (!snapshot) throw new Error("snapshot insert returned nothing");

	const [invite] = await db
		.insert(invites)
		.values({
			tenantId: tenant.id,
			email: `invitee-${label}@isolation.test`,
			role: "viewer",
			projectId: project.id,
			tokenHash: hashInviteToken(`token-${label}`),
			expiresAt: new Date(Date.now() + 60_000),
			invitedByUserId: owner.id,
		})
		.returning();
	if (!invite) throw new Error("invite insert returned nothing");

	return { tenant, owner, project, run, page, finding, snapshot, invite };
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
	/**
	 * Both identifiers are the victim's, which is the sharpest form of the attack
	 * this table exists for: a caller who has somehow learned another tenant's
	 * project and run must not be able to point one at the other.
	 */
	"project.pinBaseline": {
		kind: "foreign-id",
		input: (victim) => ({
			projectId: victim.project.id,
			runId: victim.run.id,
		}),
	},
	"project.setMasks": {
		kind: "foreign-id",
		input: (victim) => ({
			projectId: victim.project.id,
			selectors: [".intruder"],
		}),
	},
	"project.runSnapshots": {
		kind: "foreign-id",
		input: (victim) => ({ runId: victim.run.id }),
	},
	/**
	 * The invite router is Owner-only, and the intruder here *is* an Owner — of
	 * their own tenant. So these still exercise scope rather than role: the
	 * builder lets them through, and the tenant predicate is what has to refuse.
	 * Role refusal is asserted separately, in the invite router tests.
	 */
	"invite.issue": {
		kind: "foreign-id",
		input: (victim) => ({
			email: "intruder-invitee@isolation.test",
			role: "viewer" as const,
			projectId: victim.project.id,
		}),
	},
	"invite.revoke": {
		kind: "foreign-id",
		input: (victim) => ({ inviteId: victim.invite.id }),
	},
	"invite.assign": {
		kind: "foreign-id",
		input: (victim) => ({
			userId: victim.owner.id,
			projectId: victim.project.id,
			assigned: true,
		}),
	},
	"invite.list": {
		kind: "no-tenant-input",
		why: "takes no identifier; tenant scoping is asserted in the invite router tests",
	},
	"invite.members": {
		kind: "no-tenant-input",
		why: "takes no identifier; tenant scoping is asserted in the invite router tests",
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
		["invite id", victim.invite.id],
		["invitee email", victim.invite.email],
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

/**
 * The one surface that is not a tRPC procedure.
 *
 * `/api/snapshots/[snapshotId]` answers with bytes, so it cannot go through the
 * router and is invisible to the completeness check above. NFR-2 is a binary
 * commitment that holds on *every* surface a result can appear on, and a route
 * handler that inherited nothing is exactly where that commitment would quietly
 * stop holding — so it gets its own case rather than a code review.
 *
 * The handler resolves the session itself. Rather than mint one, this drives the
 * property the handler is built on: the snapshot row is reachable only through a
 * query scoped to the reader's own tenant, so a foreign id matches nothing.
 */
describe("the snapshot image route", () => {
	/**
	 * Driven through `GET` itself, not through a restatement of its query.
	 *
	 * The earlier version of this case asserted that a `pageSnapshots` lookup
	 * scoped to the intruder's tenant found nothing — which is a property of the
	 * query *the test* wrote, and would have kept passing if the handler had
	 * dropped its own tenant predicate. The commitment is about what the surface
	 * answers, so the surface is what gets asked.
	 *
	 * Only `auth()` is stubbed, and only to choose who is calling. The scoping
	 * under test still runs against the real schema, which is the distinction
	 * this file's opening note draws between a mock and a fixture.
	 */
	const request = (snapshotId: string, view?: string) =>
		GET(
			new Request(
				`http://localhost/api/snapshots/${snapshotId}${view ? `?view=${view}` : ""}`,
			),
			{ params: Promise.resolve({ snapshotId }) },
		);

	it("answers 404 for another tenant's snapshot", async () => {
		const victim = await seedTenant("route-victim");
		const intruder = await seedTenant("route-intruder");

		signedInAs(intruder.owner.id);
		const refused = await request(victim.snapshot.id);

		expect(refused.status).toBe(404);

		/**
		 * And the rightful owner does get the bytes, so the check above is
		 * refusing rather than simply never answering anything.
		 */
		signedInAs(victim.owner.id);
		const allowed = await request(victim.snapshot.id);

		expect(allowed.status).toBe(200);
		expect(allowed.headers.get("content-type")).toBe("image/png");
	});

	it("answers 404 to a caller with no session", async () => {
		const victim = await seedTenant("route-anon");

		signedOut();

		expect((await request(victim.snapshot.id)).status).toBe(404);
	});

	/**
	 * The same commitment one level down, and the reason this route needed
	 * changing at all when roles arrived.
	 *
	 * A Client-viewer is inside the tenant, so every tenant predicate on this
	 * route says yes to them. Without a project-level check they would be handed
	 * full-page screenshots of every other client the agency has — which is the
	 * isolation promise failing between two of the agency's own clients rather
	 * than between two agencies.
	 *
	 * Asserted in both directions in one test, because a route that refused
	 * everyone would satisfy the first half alone.
	 */
	it("answers 404 to a viewer not assigned to the snapshot's project", async () => {
		const agency = await seedTenant("route-roles");

		const [viewer] = await db
			.insert(users)
			.values({
				email: "route-viewer@isolation.test",
				tenantId: agency.tenant.id,
				role: "viewer",
			})
			.returning();
		if (!viewer) throw new Error("viewer insert returned nothing");

		signedInAs(viewer.id);
		const refused = await request(agency.snapshot.id);
		expect(refused.status).toBe(404);

		await db.insert(projectAssignments).values({
			tenantId: agency.tenant.id,
			userId: viewer.id,
			projectId: agency.project.id,
		});

		const allowed = await request(agency.snapshot.id);
		expect(allowed.status).toBe(200);
		expect(allowed.headers.get("content-type")).toBe("image/png");
	});
});
