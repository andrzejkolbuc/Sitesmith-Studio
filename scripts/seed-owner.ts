/**
 * Creates a tenant and an Owner account inside it.
 *
 * The product is invite-only and has no registration route, so this is how the
 * first account comes into being. Run it with:
 *
 *   npm run db:seed-owner -- --tenant "Acme Digital" --email you@example.com --password "…"
 *
 * Values may also come from SEED_TENANT / SEED_EMAIL / SEED_PASSWORD; arguments win.
 *
 * Two implementation notes worth knowing before editing:
 *
 * 1. It opens its own database connection instead of importing `~/server/db`.
 *    That module resolves `~/env`, a TypeScript path alias, and plain Node does
 *    not read tsconfig paths — importing it would fail outside the bundler.
 *
 * 2. It hashes through the same helper the sign-in path uses. A second hashing
 *    implementation here would produce accounts that exist but cannot
 *    authenticate, which is a miserable failure to debug.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { hashPassword } from "../src/server/auth/password.ts";
import { projects, tenants, users } from "../src/server/db/schema.ts";

const schema = { projects, tenants, users };

function readOption(flag: string, envKey: string): string | undefined {
	const index = process.argv.indexOf(`--${flag}`);
	if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
	return process.env[envKey];
}

function fail(message: string): never {
	console.error(`seed-owner: ${message}`);
	process.exit(1);
}

const tenantName = readOption("tenant", "SEED_TENANT");
const rawEmail = readOption("email", "SEED_EMAIL");
const password = readOption("password", "SEED_PASSWORD");

if (!tenantName) fail("missing --tenant (or SEED_TENANT)");
if (!rawEmail) fail("missing --email (or SEED_EMAIL)");
if (!password) fail("missing --password (or SEED_PASSWORD)");

/**
 * Normalised exactly as the sign-in path normalises it. If these two ever
 * diverge, the seeded address stops matching the one a user types and the
 * account becomes unreachable.
 */
const email = rawEmail.trim().toLowerCase();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail("DATABASE_URL is not set — run with --env-file=.env");

const connection = postgres(databaseUrl, { max: 1 });
const db = drizzle(connection, { schema });

try {
	// Reuse a tenant of the same name so re-running does not accumulate duplicates.
	const existingTenant = await db.query.tenants.findFirst({
		where: eq(tenants.name, tenantName),
	});

	const tenant =
		existingTenant ??
		(await db.insert(tenants).values({ name: tenantName }).returning())[0];

	if (!tenant) fail("could not create or find the tenant");

	const passwordHash = await hashPassword(password);

	const existingUser = await db.query.users.findFirst({
		where: eq(users.email, email),
	});

	if (existingUser) {
		// Idempotent on email: reset the password and re-attach rather than
		// violating the unique constraint on a second run.
		await db
			.update(users)
			.set({ passwordHash, tenantId: tenant.id })
			.where(eq(users.id, existingUser.id));

		console.log(
			`seed-owner: updated ${email} (tenant "${tenant.name}", ${tenant.id})`,
		);
	} else {
		await db.insert(users).values({ email, passwordHash, tenantId: tenant.id });

		console.log(
			`seed-owner: created ${email} (tenant "${tenant.name}", ${tenant.id})`,
		);
	}
} finally {
	await connection.end();
}
