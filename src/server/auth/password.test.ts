import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { burnPasswordTime, hashPassword, verifyPassword } from "./password";

/**
 * Password verification — the one path where being wrong is not a bug report.
 *
 * Expectations here come from the digest contract stated in `password.ts` and
 * from what the sign-in path needs to be true, never from running the code and
 * recording its output. That distinction matters most in this file: a test that
 * hashes a password and then verifies it only proves the function agrees with
 * itself, which would still hold if both halves were replaced by `return true`.
 *
 * The interesting cases are therefore the ones that do not round-trip — foreign
 * formats, corrupt digests, and a stored value written by parameters this build
 * no longer uses.
 */

const scrypt = promisify(scryptCallback) as (
	password: string,
	salt: Buffer,
	keylen: number,
	options: { N: number; r: number; p: number },
) => Promise<Buffer>;

const PASSWORD = "correct horse battery staple";

describe("hashPassword", () => {
	it("produces a digest that states the parameters it was made with", async () => {
		const digest = await hashPassword(PASSWORD);
		const [scheme, n, r, p, salt, key] = digest.split("$");

		expect(scheme).toBe("scrypt");
		/**
		 * Asserted directly because a silent reduction in the work factor is
		 * invisible to every round-trip test in this file: hashing and verifying
		 * would still agree at N=2, and the stored passwords would be worthless.
		 */
		expect(Number(n)).toBe(16384);
		expect(Number(r)).toBe(8);
		expect(Number(p)).toBe(1);
		expect(salt).toMatch(/^[0-9a-f]{32}$/);
		expect(key).toMatch(/^[0-9a-f]{64}$/);
	});

	it("salts each digest separately", async () => {
		const first = await hashPassword(PASSWORD);
		const second = await hashPassword(PASSWORD);

		// Equal digests would mean an unsalted hash: two accounts choosing the same
		// password would become visibly identical rows.
		expect(first).not.toBe(second);
		await expect(verifyPassword(PASSWORD, first)).resolves.toBe(true);
		await expect(verifyPassword(PASSWORD, second)).resolves.toBe(true);
	});
});

describe("verifyPassword", () => {
	it("accepts the correct password", async () => {
		const digest = await hashPassword(PASSWORD);
		await expect(verifyPassword(PASSWORD, digest)).resolves.toBe(true);
	});

	it("rejects a wrong password", async () => {
		const digest = await hashPassword(PASSWORD);

		const wrongOnes = [
			"Correct horse battery staple",
			"correct horse battery stapl",
			"correct horse battery staple ",
			"correct horse battery staples",
			"",
		];

		for (const wrong of wrongOnes) {
			await expect(verifyPassword(wrong, digest)).resolves.toBe(false);
		}
	});

	it("verifies a digest written with different parameters", async () => {
		/**
		 * The reason parameters travel inside the digest: raising the cost later
		 * must not lock out everyone hashed before the change. Built by hand at a
		 * lower cost rather than by calling `hashPassword`, so this describes the
		 * stored format rather than whatever constants this build happens to use.
		 */
		const salt = randomBytes(16);
		const key = await scrypt(PASSWORD, salt, 32, { N: 1024, r: 8, p: 1 });
		const legacy = [
			"scrypt",
			1024,
			8,
			1,
			salt.toString("hex"),
			key.toString("hex"),
		].join("$");

		await expect(verifyPassword(PASSWORD, legacy)).resolves.toBe(true);
		await expect(verifyPassword("wrong", legacy)).resolves.toBe(false);
	});

	it("treats unicode-equivalent passwords as the same password", async () => {
		/**
		 * The same word typed on one platform can arrive decomposed and on another
		 * precomposed. Without normalisation the user is locked out of their own
		 * account by a difference they cannot see, so both directions are asserted.
		 */
		const composed = "pässwörd";
		const decomposed = "pässwörd";
		expect(composed).not.toBe(decomposed);

		const fromComposed = await hashPassword(composed);
		const fromDecomposed = await hashPassword(decomposed);

		await expect(verifyPassword(decomposed, fromComposed)).resolves.toBe(true);
		await expect(verifyPassword(composed, fromDecomposed)).resolves.toBe(true);
	});

	it("round-trips an empty password", async () => {
		/**
		 * The sign-in schema rejects an empty password long before this is reached,
		 * but this function must not lean on that: it is also called with whatever a
		 * seeding script supplies.
		 */
		const digest = await hashPassword("");
		await expect(verifyPassword("", digest)).resolves.toBe(true);
		await expect(verifyPassword("x", digest)).resolves.toBe(false);
	});
});

describe("verifyPassword on a stored value it cannot use", () => {
	/**
	 * Every case here must answer false rather than throw.
	 *
	 * A throw on this path becomes a 500 on sign-in, which turns one corrupt row
	 * into an outage — and, because a healthy row answers differently, into a
	 * signal about which addresses hold accounts.
	 */
	const unusable: Array<[name: string, digest: string]> = [
		["empty string", ""],
		["a bare word", "hunter2"],
		["another scheme", "$2b$12$abcdefghijklmnopqrstuv"],
		["too few fields", "scrypt$16384$8$1$abcd"],
		["too many fields", "scrypt$16384$8$1$abcd$abcd$extra"],
		["a non-numeric cost", "scrypt$high$8$1$abcd$abcd"],
		["an empty salt", "scrypt$16384$8$1$$abcd"],
		["an empty key", "scrypt$16384$8$1$abcd$"],
		["non-hex characters", "scrypt$16384$8$1$zzzz$zzzz"],
		["a plausible but foreign prefix", "scrypt2$16384$8$1$abcd$abcd"],
	];

	for (const [name, digest] of unusable) {
		it(`fails closed on ${name}`, async () => {
			await expect(verifyPassword(PASSWORD, digest)).resolves.toBe(false);
		});
	}

	it("fails closed on a digest demanding absurd memory", async () => {
		/**
		 * A cost parameter becomes attacker-influenced the moment a digest can be
		 * written by anything other than `hashPassword` — a restored backup, a
		 * migration, a compromised admin path. Asking scrypt for gigabytes has to be
		 * refused rather than attempted.
		 */
		const salt = randomBytes(16).toString("hex");
		const key = randomBytes(32).toString("hex");
		const absurd = `scrypt$1073741824$8$1$${salt}$${key}`;

		await expect(verifyPassword(PASSWORD, absurd)).resolves.toBe(false);
	});

	it("fails closed on a truncated key rather than matching a prefix", async () => {
		/**
		 * The dangerous shape: if verification compared only the bytes present, a
		 * one-byte digest would match roughly one password in 256.
		 */
		const digest = await hashPassword(PASSWORD);
		const fields = digest.split("$");
		const key = fields[5] ?? "";
		const truncated = [...fields.slice(0, 5), key.slice(0, 2)].join("$");

		await expect(verifyPassword(PASSWORD, truncated)).resolves.toBe(false);
	});
});

describe("burnPasswordTime", () => {
	/**
	 * The enumeration defence, asserted as a duration rather than as a call.
	 *
	 * Sign-in answers null for an unknown address and for a wrong password alike,
	 * so the message channel is already closed. Timing is the other one: if an
	 * unknown address came back in a millisecond while a real one took fifty, that
	 * gap is enough to sort a list of addresses into customers and strangers. On
	 * an invite-only product, that list is the client list.
	 *
	 * The bounds are deliberately loose. This runs on a shared machine with a
	 * garbage collector, and the regression worth catching is `burnPasswordTime`
	 * becoming a no-op — which moves the ratio to roughly zero, not to 0.6.
	 */
	const median = (values: number[]) =>
		[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

	it("costs about as much as a real verification", async () => {
		const digest = await hashPassword(PASSWORD);

		// Warm up, so the first call's JIT and allocation costs land nowhere.
		await verifyPassword(PASSWORD, digest);
		await burnPasswordTime(PASSWORD);

		const verifyTimes: number[] = [];
		const burnTimes: number[] = [];

		// Interleaved, so a machine that slows down partway skews both equally.
		for (let i = 0; i < 5; i++) {
			let start = performance.now();
			await verifyPassword(PASSWORD, digest);
			verifyTimes.push(performance.now() - start);

			start = performance.now();
			await burnPasswordTime(PASSWORD);
			burnTimes.push(performance.now() - start);
		}

		const verify = median(verifyTimes);
		const burn = median(burnTimes);

		// A real scrypt at N=16384 cannot be sub-millisecond. If it is, the work
		// factor has collapsed and the ratio below would be measuring noise.
		expect(verify).toBeGreaterThan(1);

		expect(burn).toBeGreaterThan(verify * 0.4);
		expect(burn).toBeLessThan(verify * 3);
	});
});
