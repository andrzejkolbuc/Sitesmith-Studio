import { type EvidenceRoles, evidenceRoles } from "~/server/crawl/evidence";

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

/**
 * Evidence roles live beside the rules that produce the `detail` they decode.
 *
 * They moved to `~/server/crawl/evidence` when the run comparison needed them
 * server-side: identity across runs falls back to a finding's `subject` for any
 * type it does not map explicitly, and reaching into the results view from the
 * server would have inverted the dependency. Re-exported here rather than
 * updated at every call site, because this is where the view has always asked
 * for them.
 */
export { type EvidenceRoles, evidenceRoles };

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

/** Whether two lists name the same pages, order and repetition aside. */
function samePages(a: string[], b: string[]): boolean {
	const left = new Set(a);
	const right = new Set(b);
	if (left.size !== right.size) return false;
	for (const url of left) if (!right.has(url)) return false;
	return true;
}

/**
 * Every page a finding concerns.
 *
 * The results list groups findings by kind, and a count of findings alone
 * understates the reach of the family-level ones: a single "links disagree"
 * finding can be about six pages. Counting the pages behind each group tells the
 * reader how much of their site a problem actually touches, which is the
 * question they are trying to answer when they scan the list.
 *
 * Origin leads, because the pages a reader would edit are the ones they are
 * about to go and look at. A type whose two roles name the same pages lists them
 * once — for the duplicate rules the set *is* the problem, and reporting it
 * twice would double a count whose whole point is how many pages share one
 * string.
 */
export function pagesInvolved(finding: {
	type: string;
	url?: string | null;
	detail: Record<string, unknown>;
}): string[] {
	const { subject, origin } = evidenceRoles(finding);

	return samePages(subject, origin) ? origin : [...origin, ...subject];
}

/** How many distinct pages a group of findings touches. */
export function countPages(
	findings: Array<{
		type: string;
		url?: string | null;
		detail: Record<string, unknown>;
	}>,
): number {
	return new Set(findings.flatMap(pagesInvolved)).size;
}
