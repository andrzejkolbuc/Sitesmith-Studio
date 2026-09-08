import { describe, expect, it } from "vitest";

import {
	createInviteToken,
	hashInviteToken,
	INVITE_TTL_MS,
	inviteExpiry,
} from "./invite";

/**
 * The token contract.
 *
 * The property that matters is not "a token is random" — it is that what gets
 * stored cannot be turned back into what gets sent. If those two ever became
 * the same string, every assertion about invites elsewhere would still pass,
 * and the database would quietly hold a column of working credentials.
 */

describe("createInviteToken", () => {
	it("never stores the token it hands out", () => {
		const { token, tokenHash } = createInviteToken();

		expect(tokenHash).not.toBe(token);
		expect(tokenHash).toBe(hashInviteToken(token));
	});

	it("produces a 64-character hex token and digest", () => {
		const { token, tokenHash } = createInviteToken();

		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("does not repeat", () => {
		const tokens = new Set(
			Array.from({ length: 50 }, () => createInviteToken().token),
		);

		expect(tokens.size).toBe(50);
	});
});

describe("hashInviteToken", () => {
	it("is stable, so a stored digest keeps matching its token", () => {
		const { token, tokenHash } = createInviteToken();

		expect(hashInviteToken(token)).toBe(tokenHash);
		expect(hashInviteToken(token)).toBe(hashInviteToken(token));
	});

	it("gives different digests to different tokens", () => {
		expect(hashInviteToken("a")).not.toBe(hashInviteToken("b"));
	});
});

describe("inviteExpiry", () => {
	it("is the configured window ahead of the moment it is asked", () => {
		const now = new Date("2026-01-01T00:00:00.000Z");

		expect(inviteExpiry(now).getTime() - now.getTime()).toBe(INVITE_TTL_MS);
	});

	it("is in the future", () => {
		expect(inviteExpiry().getTime()).toBeGreaterThan(Date.now());
	});
});
