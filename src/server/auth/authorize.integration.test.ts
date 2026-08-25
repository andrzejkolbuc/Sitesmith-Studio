import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { tenants, users } from "~/server/db/schema";
import { authConfig } from "./config";
import { hashPassword } from "./password";

/**
 * The sign-in path, tested for what it refuses to tell the caller.
 *
 * Access is invite-only, so the set of addresses holding accounts is itself
 * client information: an attacker who can sort a list of addresses into
 * customers and strangers has learned who the agency works for. Two channels
 * carry that answer — the response and the time it takes — and this file pins
 * both.
 *
 * The timing case here overlaps `password.test.ts` on purpose. That one proves
 * `burnPasswordTime` costs what it should; this one proves `authorize` still
 * calls it. Deleting the call would leave the unit test green.
 */

const databaseUrl = process.env.DATABASE_URL ?? "";

if (!new URL(databaseUrl).pathname.endsWith("-test")) {
	throw new Error(
		`Refusing to run: DATABASE_URL does not point at a "-test" database. These tests truncate tables.`,
	);
}

const connection = postgres(databaseUrl, { max: 1 });
const db = drizzle(connection, { schema: { tenants, users } });

const KNOWN = {
	email: "owner@enumeration.test",
	password: "a-real-password-for-a-real-account",
};

type AuthorizeFn = (
	credentials: Record<string, unknown>,
	request: Request,
) => Promise<unknown>;

/**
 * Reaches the credentials provider's own `authorize`.
 *
 * Called directly rather than through an HTTP round trip because the property
 * under test is what this function returns, and the transport cannot change it.
 *
 * The indirection is not decoration. `providers[0].authorize` exists and is a
 * function, but it is Auth.js's placeholder — literally `() => null` — with the
 * configured implementation kept on `options` and merged in later. Reading the
 * obvious property therefore yields something that answers null to everything,
 * which is indistinguishable from a working refusal: the first draft of this
 * file passed every negative case while testing nothing at all. Hence both the
 * lookup order and the assertion below.
 */
function getAuthorize() {
	const provider = authConfig.providers[0] as unknown as {
		authorize?: AuthorizeFn;
		options?: { authorize?: AuthorizeFn };
	};

	const authorize = provider?.options?.authorize ?? provider?.authorize;

	if (typeof authorize !== "function") {
		throw new Error(
			"the credentials provider no longer exposes authorize — this test is calling the wrong thing",
		);
	}

	/**
	 * The placeholder takes no arguments; ours takes the credentials. If this
	 * ever trips, the lookup above has drifted and every negative test in this
	 * file has quietly stopped meaning anything.
	 */
	if (authorize.length === 0) {
		throw new Error(
			"resolved authorize takes no arguments, so it is Auth.js's placeholder rather than the configured implementation",
		);
	}

	return (credentials: Record<string, unknown>) =>
		authorize(credentials, new Request("http://localhost/"));
}

async function seedKnownUser(options: { withPassword: boolean }) {
	const [tenant] = await db
		.insert(tenants)
		.values({ name: "Enumeration Agency" })
		.returning();
	if (!tenant) throw new Error("tenant insert returned nothing");

	await db.insert(users).values({
		email: KNOWN.email,
		tenantId: tenant.id,
		passwordHash: options.withPassword
			? await hashPassword(KNOWN.password)
			: null,
	});
}

beforeEach(async () => {
	await db.delete(users);
	await db.delete(tenants);
});

afterAll(async () => {
	await db.delete(users);
	await db.delete(tenants);
	await connection.end();
});

describe("authorize", () => {
	it("accepts the correct credentials", async () => {
		await seedKnownUser({ withPassword: true });

		const result = (await getAuthorize()({
			email: KNOWN.email,
			password: KNOWN.password,
		})) as { id?: string; email?: string } | null;

		expect(result?.email).toBe(KNOWN.email);
		expect(result?.id).toBeTruthy();
	});

	it("accepts an address typed with different case and spacing", async () => {
		await seedKnownUser({ withPassword: true });

		/**
		 * Addresses are stored lowercase. A user who lets their phone capitalise
		 * the first letter is not attempting anything, and locking them out would
		 * be read as a broken password.
		 */
		const result = (await getAuthorize()({
			email: `  ${KNOWN.email.toUpperCase()}  `,
			password: KNOWN.password,
		})) as { email?: string } | null;

		expect(result?.email).toBe(KNOWN.email);
	});

	it("gives one identical answer to every kind of failure", async () => {
		await seedKnownUser({ withPassword: true });
		const authorize = getAuthorize();

		const outcomes = {
			"wrong password": await authorize({
				email: KNOWN.email,
				password: "not-the-password",
			}),
			"unknown address": await authorize({
				email: "stranger@enumeration.test",
				password: KNOWN.password,
			}),
			"malformed address": await authorize({
				email: "not-an-address",
				password: KNOWN.password,
			}),
			"empty password": await authorize({ email: KNOWN.email, password: "" }),
			"missing fields": await authorize({}),
		};

		/**
		 * Asserted as one object so a failure prints which case broke ranks rather
		 * than just that something was not null. Any distinguishable answer here —
		 * a different value, a thrown error, a message — tells the caller which
		 * addresses exist.
		 */
		expect(outcomes).toEqual({
			"wrong password": null,
			"unknown address": null,
			"malformed address": null,
			"empty password": null,
			"missing fields": null,
		});
	});

	it("answers identically for an account that has no password set", async () => {
		/**
		 * A real state: the invite flow creates the row before its owner has chosen
		 * a password. It must not be a way to ask whether an address was invited.
		 */
		await seedKnownUser({ withPassword: false });

		const outcome = await getAuthorize()({
			email: KNOWN.email,
			password: KNOWN.password,
		});

		expect(outcome).toBeNull();
	});

	it("takes comparable time whether or not the address exists", async () => {
		await seedKnownUser({ withPassword: true });
		const authorize = getAuthorize();

		const wrongPassword = () =>
			authorize({ email: KNOWN.email, password: "not-the-password" });
		const unknownAddress = () =>
			authorize({
				email: "stranger@enumeration.test",
				password: "not-the-password",
			});

		// Warm up: first-call costs and the connection pool land nowhere.
		await wrongPassword();
		await unknownAddress();

		const known: number[] = [];
		const unknown: number[] = [];

		// Interleaved, so a machine that slows down partway skews both equally.
		for (let i = 0; i < 5; i++) {
			let start = performance.now();
			await wrongPassword();
			known.push(performance.now() - start);

			start = performance.now();
			await unknownAddress();
			unknown.push(performance.now() - start);
		}

		const median = (values: number[]) =>
			[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

		const knownTime = median(known);
		const unknownTime = median(unknown);

		/**
		 * Loose on purpose. The regression worth catching is the deliberate burn
		 * disappearing from this function, which drops the unknown-address path to
		 * roughly the cost of one indexed query — an order of magnitude, not the
		 * few percent that separates two scrypt calls on a busy laptop.
		 */
		expect(knownTime).toBeGreaterThan(1);
		expect(unknownTime).toBeGreaterThan(knownTime * 0.4);
	});
});
