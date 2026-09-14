import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Resolved from this file so the harness does not depend on the working directory. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * Creates the test database if it does not exist, then applies the current schema
 * to it.
 *
 * Runs once per `vitest` invocation, before any test file. Deliberately reuses the
 * dev Postgres container against a separate database name — a second container
 * would be more isolation than this project needs and one more thing to keep
 * running.
 */
export default async function setup() {
	const testUrl = process.env.DATABASE_URL;
	if (!testUrl) throw new Error("DATABASE_URL is not set for the test run");

	const url = new URL(testUrl);
	const databaseName = url.pathname.slice(1);

	if (!databaseName.endsWith("-test")) {
		// Guard against a misconfigured env pointing the suite at the dev database,
		// which the tests would then truncate.
		throw new Error(
			`Refusing to run: test database name "${databaseName}" does not end in "-test".`,
		);
	}

	// Connect to the maintenance database to issue CREATE DATABASE.
	const adminUrl = new URL(testUrl);
	adminUrl.pathname = "/postgres";
	const admin = postgres(adminUrl.toString(), { max: 1 });

	try {
		const existing = await admin`
			SELECT 1 FROM pg_database WHERE datname = ${databaseName}
		`;
		if (existing.length === 0) {
			// Identifiers cannot be parameterised; the name is derived from our own
			// config and validated above, not from user input.
			await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
		}
	} finally {
		await admin.end();
	}

	/**
	 * Apply the schema from the committed migrations in `drizzle/`.
	 *
	 * The same migrator the container entrypoint runs, so the schema these tests
	 * validate is the schema a deployment gets. Previously this spawned the
	 * drizzle-kit binary, which worked here but could never work in a production
	 * image — drizzle-kit is a devDependency.
	 */
	// Applying the schema emits a truncation NOTICE for every foreign-key name
	// over Postgres' 63-character limit. In a test run that is pure noise.
	const connection = postgres(testUrl, { max: 1, onnotice: () => {} });
	try {
		await migrate(drizzle(connection), { migrationsFolder: MIGRATIONS_FOLDER });
	} finally {
		await connection.end();
	}
}
