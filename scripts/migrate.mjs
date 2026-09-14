/**
 * Apply the committed migrations in `drizzle/` to whatever DATABASE_URL points at.
 *
 * Used from four places that have nothing else in common: a developer shell via
 * `npm run db:migrate`, the integration and end-to-end harnesses, and the
 * container entrypoint. That last one is why this file exists at all — schema
 * used to reach a database only through `drizzle-kit push`, and drizzle-kit is a
 * devDependency a production install drops. `drizzle-orm` is a runtime
 * dependency, so its migrator is the one mechanism available everywhere.
 *
 * Reads DATABASE_URL from the environment directly and deliberately imports
 * neither `~/env` nor `~/server/db`. Both of those validate AUTH_SECRET as well,
 * so a migration step handed only a database URL would fail on a missing auth
 * secret — and the error would point at an env module rather than at the cause.
 *
 * `.mjs` rather than `.ts` so it runs under any Node without relying on
 * unflagged type stripping; the container entrypoint must not depend on that.
 */

import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Resolved from this file, not from cwd, so the caller's directory is irrelevant. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * Several of our foreign-key names exceed Postgres' 63-character identifier
 * limit, so applying the schema emits a truncation NOTICE per constraint. It is
 * deterministic, harmless, and says nothing an operator can act on. Every other
 * notice is still printed — some of those do mean something.
 */
function onnotice(notice) {
	if (notice.code === "42622") return;
	console.warn(notice.message);
}

const url = process.env.DATABASE_URL;
if (!url) {
	console.error("migrate: DATABASE_URL is not set.");
	console.error("    Expected it in .env, or in the environment.");
	process.exit(1);
}

/**
 * One connection, and closed explicitly.
 *
 * Without `end()` the process keeps an open socket and never exits, which in a
 * container means the entrypoint hangs and the server is never reached.
 */
const sql = postgres(url, { max: 1, onnotice });

try {
	await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
	console.log("migrate: schema is up to date.");
} catch (caught) {
	console.error("migrate: failed to apply migrations.");
	console.error(caught);
	process.exitCode = 1;
} finally {
	await sql.end();
}
