import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
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
import { resetDatabase } from "../test/reset";

/** Resolved from this file so the harness does not depend on the working directory. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

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

/**
 * An account that authenticates but belongs to no workspace.
 *
 * Reachable by design rather than by accident: `users.tenantId` is nullable so
 * the Auth.js adapter can create rows, and the invite flow on the roadmap will
 * create more states like it. Seeded here so the journeys can sign in as a
 * partial identity without building one through the interface, which there is
 * currently no way to do.
 */
export const E2E_ORPHAN = {
	email: "e2e-orphan@sitesmith.test",
	password: "e2e-orphan-not-a-secret",
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

	// Applying the schema emits a truncation NOTICE for every foreign-key name
	// over Postgres' 63-character limit. In a test run that is pure noise.
	const connection = postgres(databaseUrl, { max: 1, onnotice: () => {} });
	const db = drizzle(connection, {
		schema: { findings, pages, projects, runs, tenants, users },
	});

	try {
		/**
		 * Apply the schema from the committed migrations in `drizzle/`, reusing the
		 * connection opened for seeding rather than spawning a binary.
		 *
		 * The same migrator the container entrypoint runs, so these journeys exercise
		 * the schema a deployment gets.
		 */
		await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

		await resetDatabase(connection);

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

		// Deliberately no tenantId: this is the partial state, not a broken seed.
		await db.insert(users).values({
			email: E2E_ORPHAN.email,
			passwordHash: await hashPassword(E2E_ORPHAN.password),
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
