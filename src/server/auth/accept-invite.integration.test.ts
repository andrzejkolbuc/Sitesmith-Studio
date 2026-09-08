import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
	invites,
	projectAssignments,
	projects,
	tenants,
	users,
} from "~/server/db/schema";
import { resetDatabase } from "../../../test/reset";
import { acceptInvite } from "./accept-invite";
import { createInviteToken, inviteExpiry } from "./invite";
import { verifyPassword } from "./password";

/**
 * Redeeming an invite.
 *
 * The single-use property is the one worth the most care. It is enforced by the
 * row being deleted inside the same transaction that creates the account, which
 * means the interesting failure is not "the check is wrong" but "the two writes
 * came apart" — so the assertions below look at what is left in the database
 * afterwards, not only at what the function returned.
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

const PASSWORD = "a-perfectly-fine-password";

async function seed() {
	const [tenant] = await db
		.insert(tenants)
		.values({ name: "Accept Agency" })
		.returning();
	if (!tenant) throw new Error("tenant insert returned nothing");

	const [owner] = await db
		.insert(users)
		.values({ email: "owner@accept.test", tenantId: tenant.id })
		.returning();
	if (!owner) throw new Error("owner insert returned nothing");

	const [project] = await db
		.insert(projects)
		.values({
			tenantId: tenant.id,
			name: "accept client site",
			startUrl: "https://accept.test/",
		})
		.returning();
	if (!project) throw new Error("project insert returned nothing");

	return { tenant, owner, project };
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

async function issue({
	role = "viewer" as const,
	projectId,
	expiresAt,
}: {
	role?: "member" | "viewer";
	projectId?: string | null;
	expiresAt?: Date;
} = {}) {
	const { token, tokenHash } = createInviteToken();

	const [invite] = await db
		.insert(invites)
		.values({
			tenantId: fixture.tenant.id,
			email: "invitee@accept.test",
			role,
			projectId: projectId === undefined ? fixture.project.id : projectId,
			tokenHash,
			expiresAt: expiresAt ?? inviteExpiry(),
			invitedByUserId: fixture.owner.id,
		})
		.returning({ id: invites.id });
	if (!invite) throw new Error("invite insert returned nothing");

	return { token, id: invite.id };
}

// The db type the module expects is the app's, which this test's connection
// stands in for; the schema subset is the same shape the function touches.
const target = db as unknown as Parameters<typeof acceptInvite>[0];

describe("accepting", () => {
	it("creates an account carrying the invite's role and project", async () => {
		const { token } = await issue({ role: "viewer" });

		const accepted = await acceptInvite(target, { token, password: PASSWORD });

		expect(accepted).toEqual({ email: "invitee@accept.test" });

		const created = await db.query.users.findFirst({
			where: eq(users.email, "invitee@accept.test"),
		});
		expect(created?.role).toBe("viewer");
		expect(created?.tenantId).toBe(fixture.tenant.id);

		const assignments = await db.query.projectAssignments.findMany();
		expect(assignments).toEqual([
			expect.objectContaining({
				userId: created?.id,
				projectId: fixture.project.id,
			}),
		]);
	});

	it("sets a password sign-in can actually verify", async () => {
		const { token } = await issue();
		await acceptInvite(target, { token, password: PASSWORD });

		const created = await db.query.users.findFirst({
			where: eq(users.email, "invitee@accept.test"),
		});

		expect(await verifyPassword(PASSWORD, created?.passwordHash ?? "")).toBe(
			true,
		);
	});

	it("assigns nothing when the invite names no project", async () => {
		const { token } = await issue({ role: "member", projectId: null });
		await acceptInvite(target, { token, password: PASSWORD });

		expect(await db.query.projectAssignments.findMany()).toEqual([]);
	});
});

describe("refusing", () => {
	/**
	 * The single-use property, asserted from both sides: the second call is
	 * refused, and the invite row is gone rather than merely flagged.
	 */
	it("works exactly once", async () => {
		const { token } = await issue();

		const first = await acceptInvite(target, { token, password: PASSWORD });
		const second = await acceptInvite(target, { token, password: PASSWORD });

		expect(first).not.toBeNull();
		expect(second).toBeNull();
		expect(await db.query.invites.findMany()).toEqual([]);
		expect(await db.query.users.findMany()).toHaveLength(2);
	});

	it("refuses an expired invite and leaves no account", async () => {
		const { token } = await issue({
			expiresAt: new Date(Date.now() - 1000),
		});

		expect(
			await acceptInvite(target, { token, password: PASSWORD }),
		).toBeNull();
		expect(await db.query.users.findMany()).toHaveLength(1);
	});

	it("refuses a revoked invite", async () => {
		const { token, id } = await issue();
		await db.delete(invites).where(eq(invites.id, id));

		expect(
			await acceptInvite(target, { token, password: PASSWORD }),
		).toBeNull();
	});

	it("refuses a token that never existed", async () => {
		await issue();

		expect(
			await acceptInvite(target, { token: "not-a-token", password: PASSWORD }),
		).toBeNull();
	});

	/**
	 * Refused before the invite is even looked up, so a short password cannot be
	 * used to probe which tokens are live.
	 */
	it("refuses a password below the minimum and spends nothing", async () => {
		const { token } = await issue();

		expect(await acceptInvite(target, { token, password: "short" })).toBeNull();
		expect(await db.query.invites.findMany()).toHaveLength(1);
	});
});
