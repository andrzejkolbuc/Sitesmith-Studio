import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { hashPassword } from "../src/server/auth/password";
import {
	findings,
	pages,
	projects,
	runs,
	tenants,
	users,
} from "../src/server/db/schema";

/**
 * Brings up a known world before any browser opens.
 *
 * Runs once per `playwright test` invocation: creates the end-to-end database if
 * absent, applies the current schema, clears every domain table, and seeds one
 * owner whose credentials the journeys use.
 *
 * The guard on the database name is the important part. These journeys truncate
 * tables, and the same guard in the integration suite has already caught one
 * real misconfiguration where the setup step still saw the development
 * database. Repeating it here keeps the destructive operation and its safety
 * check in the same file.
 */

export const E2E_OWNER = {
	tenant: "E2E Agency",
	email: "e2e-owner@sitesmith.test",
	password: "e2e-password-not-a-secret",
} as const;

export default async function globalSetup() {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("DATABASE_URL is not set for the end-to-end run.");
	}

	const url = new URL(databaseUrl);
	const databaseName = url.pathname.slice(1);

	if (!databaseName.endsWith("-e2e")) {
		throw new Error(
			`Refusing to run: end-to-end database "${databaseName}" does not end in "-e2e". These tests truncate tables.`,
		);
	}

	// CREATE DATABASE cannot run inside the target database.
	const adminUrl = new URL(databaseUrl);
	adminUrl.pathname = "/postgres";
	const admin = postgres(adminUrl.toString(), { max: 1 });

	try {
		const existing = await admin`
			SELECT 1 FROM pg_database WHERE datname = ${databaseName}
		`;
		if (existing.length === 0) {
			// Identifier cannot be parameterised; the name is derived from our own
			// config and validated above, never from user input.
			await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
		}
	} finally {
		await admin.end();
	}

	/**
	 * Apply the schema through Node rather than npx: since Node 20, spawning a
	 * `.cmd` shim without a shell fails on Windows with EINVAL.
	 */
	const drizzleKit = resolve(process.cwd(), "node_modules/drizzle-kit/bin.cjs");
	if (!existsSync(drizzleKit)) {
		throw new Error(`drizzle-kit binary not found at ${drizzleKit}`);
	}
	execFileSync(process.execPath, [drizzleKit, "push", "--force"], {
		stdio: "pipe",
		env: process.env,
	});

	const connection = postgres(databaseUrl, { max: 1 });
	const db = drizzle(connection, {
		schema: { findings, pages, projects, runs, tenants, users },
	});

	try {
		// Order matters: findings and pages reference runs, runs reference projects.
		await db.delete(findings);
		await db.delete(pages);
		await db.delete(runs);
		await db.delete(projects);
		await db.delete(users);
		await db.delete(tenants);

		const [tenant] = await db
			.insert(tenants)
			.values({ name: E2E_OWNER.tenant })
			.returning();
		if (!tenant) throw new Error("could not create the end-to-end tenant");

		await db.insert(users).values({
			email: E2E_OWNER.email,
			tenantId: tenant.id,
			passwordHash: await hashPassword(E2E_OWNER.password),
		});

		// Prove the seeded account is reachable the way sign-in will look for it.
		const seeded = await db.query.users.findFirst({
			where: eq(users.email, E2E_OWNER.email),
		});
		if (!seeded?.passwordHash) {
			throw new Error("seeded owner is missing a password hash");
		}
	} finally {
		await connection.end();
	}
}
