import { describe, expect, it } from "vitest";

import { MAX_LISTED, summariseList } from "./summarise";

/**
 * The truncation rule, made checkable.
 *
 * The fixture site's families are small, so no crawl the test suite performs
 * ever produces a list long enough to truncate — which would have left the
 * "states how many were not shown" criterion asserting nothing. Extracted and
 * tested here rather than left to a manual glance at a screen that cannot
 * currently show the case.
 */

const list = (n: number) => Array.from({ length: n }, (_, i) => `item ${i}`);

describe("summariseList", () => {
	it("shows everything when the list is short enough", () => {
		const { shown, hidden } = summariseList(list(3));

		expect(shown).toHaveLength(3);
		expect(hidden).toBe(0);
	});

	it("shows everything at exactly the limit", () => {
		/**
		 * The boundary that decides whether a reader is told "and 0 more". Off by
		 * one here produces a finding that claims to be hiding nothing while saying
		 * so, which reads as a bug in the tool.
		 */
		const { shown, hidden } = summariseList(list(MAX_LISTED));

		expect(shown).toHaveLength(MAX_LISTED);
		expect(hidden).toBe(0);
	});

	it("counts exactly what it left out", () => {
		const { shown, hidden } = summariseList(list(12));

		expect(shown).toHaveLength(MAX_LISTED);
		expect(hidden).toBe(12 - MAX_LISTED);
		// The two together must account for the whole list, or the count misleads.
		expect(shown.length + hidden).toBe(12);
	});

	it("keeps the order it was given", () => {
		/**
		 * The entries arrive sorted so that two runs over the same site produce
		 * comparable output. Reordering here would break that at the last step.
		 */
		const { shown } = summariseList(["c", "a", "b"], 2);

		expect(shown).toEqual(["c", "a"]);
	});

	it("handles an empty list without claiming anything is hidden", () => {
		expect(summariseList([])).toEqual({ shown: [], hidden: 0 });
	});

	it("never hides everything, however small the limit", () => {
		/**
		 * A limit of zero would render nothing but a count, telling the reader a
		 * number and no page they could act on.
		 */
		const { shown, hidden } = summariseList(list(4), 0);

		expect(shown).toHaveLength(1);
		expect(hidden).toBe(3);
	});
});
