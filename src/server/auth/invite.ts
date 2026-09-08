import { createHash, randomBytes } from "node:crypto";

/**
 * Invite tokens: how one is minted, and how a stored row is found from one.
 *
 * Built from `node:crypto` rather than a token library, matching how the rest of
 * this codebase gets its randomness — `randomBytes` for anything secret-bearing
 * (see `password.ts`) and `createHash("sha256")` for a digest (see
 * `crawl/content.ts`). Nothing here needs a dependency.
 *
 * **Only the digest is stored.** A token grants an account, which makes it worth
 * more than the rows it sits next to: a database dump, a backup, or a log line
 * that happened to capture a row would otherwise be a working invite. Hashing
 * costs one extra step on a lookup that happens once per invite, ever.
 *
 * No timing-safe comparison, deliberately. `verifyPassword` needs one because a
 * password is low-entropy and an attacker can iterate; a 256-bit token cannot be
 * approached that way, and the lookup is an indexed equality on its digest — a
 * near-miss and a total miss are the same query.
 */

/**
 * 32 bytes, hex-encoded to 64 characters.
 *
 * Hex rather than base64url so the token is unambiguous in a URL path, in a
 * chat message, and in the one place it will actually live: pasted by hand into
 * whatever the agency already uses to talk to its client.
 */
const TOKEN_BYTES = 32;

/**
 * How long an invite stays usable.
 *
 * Seven days is the compromise the delivery choice forces. The link is handed to
 * the Owner to send out of band, so it will sit in a mailbox or a chat thread —
 * an expiry is the only thing that stops it sitting there indefinitely. Short
 * enough to bound that, long enough that a client who reads email weekly is not
 * locked out.
 */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashInviteToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export function createInviteToken(): { token: string; tokenHash: string } {
	const token = randomBytes(TOKEN_BYTES).toString("hex");
	return { token, tokenHash: hashInviteToken(token) };
}

export function inviteExpiry(now: Date = new Date()): Date {
	return new Date(now.getTime() + INVITE_TTL_MS);
}
