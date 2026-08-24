import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

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
	 * Apply the schema. drizzle-kit reads DATABASE_URL from the environment, which
	 * already points at the test database by the time this runs.
	 *
	 * Runs the binary through Node rather than through `npx`: since Node 20,
	 * spawning a `.cmd` shim without a shell fails on Windows with EINVAL, and
	 * enabling a shell to work around it would mean quoting arguments correctly on
	 * two platforms.
	 */
	const drizzleKit = resolve(process.cwd(), "node_modules/drizzle-kit/bin.cjs");
	if (!existsSync(drizzleKit)) {
		throw new Error(`drizzle-kit binary not found at ${drizzleKit}`);
	}

	execFileSync(process.execPath, [drizzleKit, "push", "--force"], {
		stdio: "pipe",
		env: process.env,
	});
}
