/**
 * How much of a family-level finding to show before summarising the rest.
 *
 * A family finding carries one entry per affected member, and a template fault
 * can make every member of every family defective at once. Rendering all of them
 * would let a single finding push everything else off the screen — the failure
 * that family-level reporting exists to prevent, reintroduced at the point of
 * display.
 *
 * Separated from the component so the rule can be tested. It is small enough to
 * look obviously correct, which is exactly the kind of thing that turns out to
 * be off by one.
 */

export const MAX_LISTED = 5;

export type Summarised = {
	/** The entries to render, in the order given. */
	shown: string[];
	/** How many were left out; zero when everything is shown. */
	hidden: number;
};

export function summariseList(
	items: string[],
	limit: number = MAX_LISTED,
): Summarised {
	/**
	 * A limit below one would hide everything and report the total as "more",
	 * which tells the reader a number and nothing they can act on.
	 */
	const safeLimit = Math.max(1, limit);
	const shown = items.slice(0, safeLimit);

	return { shown, hidden: Math.max(0, items.length - shown.length) };
}
