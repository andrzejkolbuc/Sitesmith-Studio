import { describe, expect, it } from "vitest";

import { runsToExpire, SNAPSHOTS_KEPT } from "./retention";

/**
 * The retention rule, read as the PRD states it: the pinned baseline never
 * expires, and beyond it only the most recent runs keep their images.
 *
 * Pure cases only — the enforcer that applies this to rows is exercised against
 * a real database in `run.test.ts`, because what it has to get right is that it
 * updates rather than deletes, and that is a property of the query.
 */
describe("runsToExpire", () => {
	const newestFirst = ["r5", "r4", "r3", "r2", "r1"];

	it("expires nothing when there are fewer runs than the window", () => {
		expect(runsToExpire(["r2", "r1"], null, 3)).toEqual([]);
	});

	it("expires nothing when the run list is empty", () => {
		expect(runsToExpire([], null, 3)).toEqual([]);
	});

	it("keeps the most recent runs and expires the rest", () => {
		expect(runsToExpire(newestFirst, null, 3)).toEqual(["r2", "r1"]);
	});

	it("keeps a baseline that has fallen outside the window", () => {
		/** r1 is the oldest run and would expire on the window alone. */
		expect(runsToExpire(newestFirst, "r1", 3)).toEqual(["r2"]);
	});

	it("does not let a baseline inside the window consume a slot", () => {
		/**
		 * Pinning a recent run must not silently shorten the recent window. r5 is
		 * the baseline and is kept for that reason; the window still keeps three
		 * others, so only the oldest goes.
		 */
		expect(runsToExpire(newestFirst, "r5", 3)).toEqual(["r1"]);
	});

	it("keeps the recent window when there is no baseline at all", () => {
		const expired = runsToExpire(newestFirst, null);
		expect(expired).toEqual(["r2", "r1"]);
		expect(newestFirst.length - expired.length).toBe(SNAPSHOTS_KEPT);
	});

	it("expires everything but the baseline when the window is zero", () => {
		/**
		 * Zero means none, and the baseline is still not one of them — the two
		 * rules are independent, which is the whole point of not counting the
		 * baseline against the window.
		 */
		expect(runsToExpire(newestFirst, "r3", 0)).toEqual([
			"r5",
			"r4",
			"r2",
			"r1",
		]);
	});

	it("ignores a baseline that is not among the runs", () => {
		expect(runsToExpire(newestFirst, "gone", 3)).toEqual(["r2", "r1"]);
	});
});
