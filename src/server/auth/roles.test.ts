import { describe, expect, it } from "vitest";

import {
	canConfigureProject,
	canRunChecks,
	isOwner,
	USER_ROLES,
	type UserRole,
} from "./roles";

/**
 * The capability matrix, asserted as a table rather than as prose.
 *
 * Written this way because the interesting failure is not "a predicate returns
 * the wrong answer for one role" — it is "somebody adds a fourth role and only
 * two of the three predicates learn about it". A table keyed by the exported
 * role list makes that omission a failure here rather than a surprise in
 * production.
 */

const EXPECTED: Record<
	UserRole,
	{ owner: boolean; run: boolean; configure: boolean }
> = {
	owner: { owner: true, run: true, configure: true },
	member: { owner: false, run: true, configure: false },
	viewer: { owner: false, run: false, configure: false },
};

describe("role predicates", () => {
	it("covers every role the product defines", () => {
		expect(Object.keys(EXPECTED).sort()).toEqual([...USER_ROLES].sort());
	});

	for (const role of USER_ROLES) {
		it(`answers all three questions for ${role}`, () => {
			const expected = EXPECTED[role];

			expect({
				owner: isOwner(role),
				run: canRunChecks(role),
				configure: canConfigureProject(role),
			}).toEqual(expected);
		});
	}

	/**
	 * The absent case is not hypothetical: `createTRPCContext` resolves the role
	 * to `null` for an unauthenticated caller, and every predicate is reachable
	 * with that value. Each must deny rather than throw — a predicate that throws
	 * turns a refusal into a 500.
	 */
	it.each([
		["null", null],
		["undefined", undefined],
	])("denies everything when the role is %s", (_label, role) => {
		expect({
			owner: isOwner(role),
			run: canRunChecks(role),
			configure: canConfigureProject(role),
		}).toEqual({ owner: false, run: false, configure: false });
	});
});
