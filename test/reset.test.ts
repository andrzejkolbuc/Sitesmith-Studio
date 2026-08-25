import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { resetDatabase } from "./reset";

/**
 * The guard on the only function in this repository that empties tables.
 *
 * Every test file that needs a clean database now calls `resetDatabase`, which
 * makes it a single point of failure in the literal sense: a mistake in the name
 * check destroys whatever database the caller happened to be pointed at. That
 * has almost happened once already — a configuration in which the setup step
 * still saw the development database — so the check is asserted rather than
 * assumed.
 *
 * No database is contacted here. `postgres()` does not connect until a query is
 * issued, and every case below is expected to be refused before one is.
 */

const clients: postgres.Sql[] = [];

function clientFor(databaseName: string) {
	const client = postgres(
		`postgresql://postgres:unused@127.0.0.1:1/${databaseName}`,
		{ max: 1 },
	);
	clients.push(client);
	return client;
}

afterAll(async () => {
	await Promise.all(clients.map((client) => client.end()));
});

describe("resetDatabase", () => {
	const refused = [
		["the development database", "sitesmith-studio"],
		["production", "sitesmith-studio-production"],
		["a name merely containing the word test", "test-sitesmith-studio"],
		["a near miss", "sitesmith-studio-tests"],
		["postgres itself", "postgres"],
		["an empty name", ""],
	] as const;

	for (const [description, name] of refused) {
		it(`refuses ${description}`, async () => {
			await expect(resetDatabase(clientFor(name))).rejects.toThrow(
				/Refusing to truncate/,
			);
		});
	}

	/**
	 * The permitted names are asserted through the failure they produce rather
	 * than by letting them run: reaching a connection error proves the guard let
	 * them past, which is the property under test, without needing a server.
	 */
	for (const name of ["sitesmith-studio-test", "sitesmith-studio-e2e"]) {
		it(`allows ${name} through to the query`, async () => {
			/**
			 * The error is captured rather than asserted with `rejects.not.toThrow`,
			 * which reads correctly and is a trap: on a promise that resolves, the
			 * negation can swallow the failure and report a pass. Here the outcome is
			 * inspected directly, so "did not reject at all" is a visible failure.
			 */
			const outcome = await resetDatabase(clientFor(name)).then(
				() => null,
				(caught: unknown) => caught,
			);

			expect(outcome).toBeInstanceOf(Error);
			expect(String(outcome)).not.toMatch(/Refusing to truncate/);
		});
	}
});
