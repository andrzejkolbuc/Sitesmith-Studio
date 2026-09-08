import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createCaller } from "~/server/api/root";
import { hashInviteToken } from "~/server/auth/invite";
import type { UserRole } from "~/server/auth/roles";
import {
	invites,
	projectAssignments,
	projects,
	tenants,
	users,
} from "~/server/db/schema";
import { resetDatabase } from "../../../../test/reset";

/**
 * The invite lifecycle, minus redemption.
 *
 * What is asserted here is everything the router owns — who may issue, what it
 * refuses, and that a revoked invite leaves nothing usable behind. Redemption
 * is `acceptInvite`, and it has its own file.
 */

const databaseUrl = process.env.DATABASE_URL ?? "";

if (!new URL(databaseUrl).pathname.endsWith("-test")) {
	throw new Error(
		`Refusing to run: DATABASE_URL does not point at a "-test" database. These tests truncate tables.`,
	);
}

const connection = postgres(databaseUrl, { max: 1 });
const db = drizzle(connection, {
	schema: { invites, projectAssignments, projects, tenants, users },
});

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

async function seed() {
	const [tenant] = await db
		.insert(tenants)
		.values({ name: "Invite Agency" })
		.returning();
	if (!tenant) throw new Error("tenant insert returned nothing");

	const [owner] = await db
		.insert(users)
		.values({ email: "owner@invite.test", tenantId: tenant.id, role: "owner" })
		.returning();
	if (!owner) throw new Error("owner insert returned nothing");

	const [member] = await db
		.insert(users)
		.values({
			email: "member@invite.test",
			tenantId: tenant.id,
			role: "member",
		})
		.returning();
	if (!member) throw new Error("member insert returned nothing");

	const [project] = await db
		.insert(projects)
		.values({
			tenantId: tenant.id,
			name: "invite client site",
			startUrl: "https://invite.test/",
		})
		.returning();
	if (!project) throw new Error("project insert returned nothing");

	return { tenant, owner, member, project };
}

type Seed = Awaited<ReturnType<typeof seed>>;

let fixture: Seed;

beforeEach(async () => {
	await resetDatabase(connection);
	fixture = await seed();
});

afterAll(async () => {
	await connection.end();
});

const asOwner = () => callerFor(fixture.owner.id, fixture.tenant.id);
const asMember = () =>
	callerFor(fixture.member.id, fixture.tenant.id, "member", []);

async function codeOf(call: Promise<unknown>): Promise<string> {
	try {
		await call;
		return "ok";
	} catch (caught) {
		return (caught as { code?: string }).code ?? "unknown";
	}
}

describe("issuing", () => {
	it("returns a token that resolves to the stored row, and stores only its digest", async () => {
		const issued = await asOwner().invite.issue({
			email: "Client@Invite.Test",
			role: "viewer",
			projectId: fixture.project.id,
		});

		const stored = await db.query.invites.findFirst({
			where: eq(invites.id, issued.id),
		});

		expect(stored?.tokenHash).toBe(hashInviteToken(issued.token));
		/** The raw token must not have been written anywhere on the row. */
		expect(JSON.stringify(stored)).not.toContain(issued.token);
	});

	/**
	 * The seed script and the credentials provider both normalise this way. An
	 * invite that stored the address as typed would create an account sign-in
	 * could never find.
	 */
	it("normalises the address the way sign-in will look it up", async () => {
		const issued = await asOwner().invite.issue({
			email: "  MixedCase@Invite.Test  ",
			role: "member",
		});

		expect(issued.email).toBe("mixedcase@invite.test");
	});

	it("refuses a viewer invite with no project", async () => {
		expect(
			await codeOf(
				asOwner().invite.issue({ email: "v@invite.test", role: "viewer" }),
			),
		).toBe("BAD_REQUEST");
	});

	it("refuses an address that already has an account", async () => {
		expect(
			await codeOf(
				asOwner().invite.issue({ email: "member@invite.test", role: "member" }),
			),
		).toBe("CONFLICT");
	});

	it("refuses a project outside the tenant", async () => {
		const [otherTenant] = await db
			.insert(tenants)
			.values({ name: "Other Agency" })
			.returning();
		if (!otherTenant) throw new Error("tenant insert returned nothing");

		const [otherProject] = await db
			.insert(projects)
			.values({
				tenantId: otherTenant.id,
				name: "other site",
				startUrl: "https://other.test/",
			})
			.returning();
		if (!otherProject) throw new Error("project insert returned nothing");

		expect(
			await codeOf(
				asOwner().invite.issue({
					email: "v@invite.test",
					role: "viewer",
					projectId: otherProject.id,
				}),
			),
		).toBe("NOT_FOUND");
	});
});

describe("listing and revoking", () => {
	it("lists pending invites without their digest", async () => {
		await asOwner().invite.issue({ email: "a@invite.test", role: "member" });

		const listed = await asOwner().invite.list();

		expect(listed).toHaveLength(1);
		expect(JSON.stringify(listed)).not.toContain("tokenHash");
	});

	it("leaves nothing usable behind when revoked", async () => {
		const issued = await asOwner().invite.issue({
			email: "b@invite.test",
			role: "member",
		});

		await asOwner().invite.revoke({ inviteId: issued.id });

		const remaining = await db.query.invites.findFirst({
			where: eq(invites.tokenHash, hashInviteToken(issued.token)),
		});

		expect(remaining).toBeUndefined();
		expect(await asOwner().invite.list()).toEqual([]);
	});

	it("refuses to revoke an invite from another tenant", async () => {
		const [otherTenant] = await db
			.insert(tenants)
			.values({ name: "Other Agency" })
			.returning();
		if (!otherTenant) throw new Error("tenant insert returned nothing");

		const [otherOwner] = await db
			.insert(users)
			.values({ email: "other@invite.test", tenantId: otherTenant.id })
			.returning();
		if (!otherOwner) throw new Error("user insert returned nothing");

		const issued = await asOwner().invite.issue({
			email: "c@invite.test",
			role: "member",
		});

		const intruder = callerFor(otherOwner.id, otherTenant.id);

		expect(await codeOf(intruder.invite.revoke({ inviteId: issued.id }))).toBe(
			"NOT_FOUND",
		);
	});
});

describe("members and assignment", () => {
	it("reports each person with the projects they reach", async () => {
		await asOwner().invite.assign({
			userId: fixture.member.id,
			projectId: fixture.project.id,
			assigned: true,
		});

		const members = await asOwner().invite.members();

		expect(
			members.map((m) => ({
				email: m.email,
				role: m.role,
				projectIds: m.projectIds,
			})),
		).toEqual([
			{
				email: "member@invite.test",
				role: "member",
				projectIds: [fixture.project.id],
			},
			{ email: "owner@invite.test", role: "owner", projectIds: [] },
		]);
	});

	it("is reversible, and repeating it does not duplicate the row", async () => {
		const assign = (assigned: boolean) =>
			asOwner().invite.assign({
				userId: fixture.member.id,
				projectId: fixture.project.id,
				assigned,
			});

		await assign(true);
		await assign(true);

		const rows = await db.query.projectAssignments.findMany();
		expect(rows).toHaveLength(1);

		await assign(false);
		expect(await db.query.projectAssignments.findMany()).toEqual([]);
	});

	/**
	 * An Owner reaches everything by role. Rows would be a second answer to the
	 * same question, and the two would eventually disagree.
	 */
	it("refuses to assign a project to an owner", async () => {
		expect(
			await codeOf(
				asOwner().invite.assign({
					userId: fixture.owner.id,
					projectId: fixture.project.id,
					assigned: true,
				}),
			),
		).toBe("BAD_REQUEST");
	});
});

describe("who may manage people", () => {
	it("refuses every invite procedure to a non-owner", async () => {
		const member = asMember();

		expect({
			issue: await codeOf(
				member.invite.issue({ email: "x@invite.test", role: "member" }),
			),
			list: await codeOf(member.invite.list()),
			revoke: await codeOf(member.invite.revoke({ inviteId: "whatever" })),
			members: await codeOf(member.invite.members()),
			assign: await codeOf(
				member.invite.assign({
					userId: fixture.member.id,
					projectId: fixture.project.id,
					assigned: true,
				}),
			),
		}).toEqual({
			issue: "FORBIDDEN",
			list: "FORBIDDEN",
			revoke: "FORBIDDEN",
			members: "FORBIDDEN",
			assign: "FORBIDDEN",
		});
	});
});
