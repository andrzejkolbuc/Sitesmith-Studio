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

/**
 * Every page a finding concerns.
 *
 * The results list groups findings by kind, and a count of findings alone
 * understates the reach of the family-level ones: a single "links disagree"
 * finding can be about six pages. Counting the pages behind each group tells the
 * reader how much of their site a problem actually touches, which is the
 * question they are trying to answer when they scan the list.
 *
 * Kept as data rather than as rendering so the mapping can be tested — a type
 * added later and not listed here silently reports zero pages, which would read
 * as a problem affecting nothing.
 */
export function pagesInvolved(finding: {
	type: string;
	url?: string | null;
	detail: Record<string, unknown>;
}): string[] {
	const { detail } = finding;

	const strings = (value: unknown): string[] =>
		Array.isArray(value)
			? value.filter((v): v is string => typeof v === "string")
			: [];

	const one = (value: unknown): string[] =>
		typeof value === "string" ? [value] : [];

	switch (finding.type) {
		case "missing_locale":
		case "hreflang_family_inconsistent":
			return strings(detail.memberUrls);

		case "hreflang_target_failed":
		case "hreflang_target_unreached":
			return [...one(detail.declaredBy), ...one(detail.target)];

		case "variant_diverged":
			return [...strings(detail.declaredBy), ...one(detail.brokenUrl)];

		case "no_hreflang":
			return one(detail.url);

		/**
		 * Two shapes under one type. The marker kind is about the single page it
		 * names; the identical-content kind speaks for every page sharing that
		 * content, and counting only one of them would understate a problem whose
		 * whole point is that it touches several.
		 */
		case "content_untranslated":
			return detail.kind === "identical_to_siblings"
				? strings(detail.urls)
				: one(detail.url);

		default:
			// An unmapped type still counts the page it names, so a new finding
			// never reports as affecting nothing.
			return one(finding.url);
	}
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
