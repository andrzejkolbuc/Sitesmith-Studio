import {
	randomBytes,
	scrypt as scryptCallback,
	timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
	password: string,
	salt: Buffer,
	keylen: number,
	options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/**
 * Password hashing on Node's built-in scrypt.
 *
 * scrypt is memory-hard and is one of the KDFs OWASP considers acceptable for
 * password storage. It ships with Node, so this adds no dependency and no
 * native build step — which matters because the deployment target is a
 * container, and native crypto modules are a common source of image-build pain.
 *
 * Digest format: `scrypt$N$r$p$saltHex$keyHex`. The parameters travel with the
 * digest so they can be raised later without invalidating existing passwords —
 * verification reads whatever the stored digest was created with.
 */

const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(SALT_LENGTH);
	const key = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, {
		...PARAMS,
	});

	return [
		"scrypt",
		PARAMS.N,
		PARAMS.r,
		PARAMS.p,
		salt.toString("hex"),
		key.toString("hex"),
	].join("$");
}

/**
 * Returns true when `password` matches `digest`.
 *
 * Never throws on a malformed digest — a corrupt or unrecognised value is
 * simply a failed match, so a bad row cannot turn into a 500 on the sign-in
 * path.
 */
export async function verifyPassword(
	password: string,
	digest: string,
): Promise<boolean> {
	const parts = digest.split("$");
	if (parts.length !== 6 || parts[0] !== "scrypt") return false;

	const [, rawN, rawR, rawP, saltHex, keyHex] = parts as [
		string,
		string,
		string,
		string,
		string,
		string,
	];

	const N = Number.parseInt(rawN, 10);
	const r = Number.parseInt(rawR, 10);
	const p = Number.parseInt(rawP, 10);
	if (
		!Number.isSafeInteger(N) ||
		!Number.isSafeInteger(r) ||
		!Number.isSafeInteger(p)
	) {
		return false;
	}

	let expected: Buffer;
	let salt: Buffer;
	try {
		expected = Buffer.from(keyHex, "hex");
		salt = Buffer.from(saltHex, "hex");
	} catch {
		return false;
	}
	/**
	 * The stored digest must not choose how many bytes get compared.
	 *
	 * Deriving the key at `expected.length` looked harmless — the comparison is
	 * still constant-time and still has to match. But it lets the digest set the
	 * work: a value carrying a one-byte key would be checked one byte deep and
	 * would accept roughly one password in 256. `Buffer.from(hex)` reaches the
	 * same place quietly, since it stops at the first invalid pair and returns a
	 * short buffer rather than throwing.
	 *
	 * Both lengths have been fixed since the first digest was written, so
	 * anything else was not produced by `hashPassword`. Note that changing
	 * `KEY_LENGTH` later means encoding it in the digest — the format records the
	 * scrypt parameters, but not this.
	 */
	if (expected.length !== KEY_LENGTH || salt.length !== SALT_LENGTH) {
		return false;
	}

	let actual: Buffer;
	try {
		actual = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, {
			N,
			r,
			p,
		});
	} catch {
		return false;
	}

	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Burns roughly the same time as a real verification, without comparing against
 * anything.
 *
 * Called on the sign-in path when no user matches the submitted address. If we
 * returned immediately instead, an unknown address would answer measurably
 * faster than a known one with a wrong password — a timing oracle that lets an
 * attacker enumerate which email addresses hold accounts. On an invite-only
 * product that leaks the client list.
 */
export async function burnPasswordTime(password: string): Promise<void> {
	const salt = randomBytes(SALT_LENGTH);
	await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { ...PARAMS });
}
