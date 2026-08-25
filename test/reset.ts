import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import type postgres from "postgres";

import * as schema from "~/server/db/schema";

/**
 * Empties every table, for tests that need a known starting point.
 *
 * This replaces the ordered `db.delete(...)` sequence that four separate files
 * were each maintaining by hand. That pattern breaks in two ways, and both had
 * already happened: a file listing fewer tables than another leaves rows that
 * make the next file's delete fail on a foreign key, and a table added later is
 * simply forgotten everywhere at once.
 *
 * `TRUNCATE ... CASCADE` removes the ordering question entirely, and the table
 * list is read from the schema rather than written down, so a new table is
 * covered the moment it is defined.
 */
export async function resetDatabase(sql: postgres.Sql): Promise<void> {
	/**
	 * The guard lives with the destructive statement rather than only in the
	 * callers. It has already earned its keep once in this project, catching a
	 * configuration where the setup step still saw the development database —
	 * and the callers are exactly what a future refactor might replace.
	 */
	const database = sql.options.database;
	if (!database.endsWith("-test") && !database.endsWith("-e2e")) {
		throw new Error(
			`Refusing to truncate "${database}": only databases ending in "-test" or "-e2e" may be reset.`,
		);
	}

	/**
	 * Widened before narrowing: the module exports the table factory and the
	 * relation objects alongside the tables themselves, and the resulting union
	 * makes the type predicate below ill-formed. `is` is the runtime check that
	 * actually decides.
	 */
	const tables = (Object.values(schema) as unknown[])
		.filter((value): value is PgTable => is(value, PgTable))
		.map((table) => `"${getTableName(table)}"`);

	/**
	 * An empty list would make this function a silent no-op, and every test
	 * depending on a clean database would start passing or failing for reasons
	 * unrelated to what it asserts.
	 */
	if (tables.length === 0) {
		throw new Error(
			"no tables found in the schema — refusing to reset nothing",
		);
	}

	await sql.unsafe(
		`TRUNCATE TABLE ${tables.join(", ")} RESTART IDENTITY CASCADE`,
	);
}
