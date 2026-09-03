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
 * The two roles the pages behind a finding can play.
 *
 * A finding names pages for two different reasons, and until now they were
 * unioned: the URL that is *wrong*, and the pages that *emit* it. For counting
 * how much of a site a problem touches the union is right — a dead link costs
 * the reader an edit on every page that points at it. For deciding whether two
 * findings share a cause it is fatal, because a single dead footer link makes
 * every page on the site adjacent to every other finding.
 *
 * So the mapping below answers both questions at once, and `pagesInvolved`
 * stays the union of them. Correlation reads `origin` alone.
 */
export type EvidenceRoles = {
	/** The URL that is wrong: the dead target, the duplicated set, the page. */
	subject: string[];
	/**
	 * The pages that emit it — where an editor goes to fix it.
	 *
	 * Empty for the five types that speak about the corpus rather than about any
	 * page: reconciling a sitemap or a robots.txt against the crawl produces a
	 * statement with no author to visit. That emptiness is load-bearing, not an
	 * omission — it is what keeps those findings out of correlation entirely,
	 * structurally rather than by being noticed as too wide.
	 */
	origin: string[];
};

/**
 * Which pages a finding names, and in which role.
 *
 * Kept as data rather than as rendering so the mapping can be tested — a type
 * added later and not listed here silently reports zero pages, which would read
 * as a problem affecting nothing.
 */
export function evidenceRoles(finding: {
	type: string;
	url?: string | null;
	detail: Record<string, unknown>;
}): EvidenceRoles {
	const { detail } = finding;

	const strings = (value: unknown): string[] =>
		Array.isArray(value)
			? value.filter((v): v is string => typeof v === "string")
			: [];

	const one = (value: unknown): string[] =>
		typeof value === "string" ? [value] : [];

	/** A finding whose subject and origin are the same pages. */
	const both = (urls: string[]): EvidenceRoles => ({
		subject: urls,
		origin: urls,
	});

	switch (finding.type) {
		/**
		 * The family's members, in both roles. A missing locale is added, and a
		 * disagreeing declaration is corrected, on the members themselves.
		 */
		case "missing_locale":
		case "hreflang_family_inconsistent":
			return both(strings(detail.memberUrls));

		/**
		 * Two pages are implicated: the one carrying the declaration, which is
		 * where the fix goes, and the one it points at.
		 */
		case "hreflang_target_failed":
		case "hreflang_target_unreached":
			return {
				subject: one(detail.target),
				origin: one(detail.declaredBy),
			};

		/**
		 * The broken variant is the defect; the siblings that declared it are the
		 * pages whose links have to change.
		 */
		case "variant_diverged":
			return {
				subject: one(detail.brokenUrl),
				origin: strings(detail.declaredBy),
			};

		case "no_hreflang":
			return both(one(detail.url));

		/**
		 * Two shapes under one type. The marker kind is about the single page it
		 * names; the identical-content kind speaks for every page sharing that
		 * content, and counting only one of them would understate a problem whose
		 * whole point is that it touches several.
		 */
		case "content_untranslated":
			return both(
				detail.kind === "identical_to_siblings"
					? strings(detail.urls)
					: one(detail.url),
			);

		case "content_structure_differs":
			return both(strings(detail.memberUrls));

		case "metadata_missing":
			return both(one(detail.url));

		/**
		 * Every page carrying the duplicated string, not the one the finding is
		 * filed against — it is filed against none. A duplicate is a problem about
		 * a set of pages, and counting one of them would understate exactly the
		 * thing that makes it a problem.
		 *
		 * Subject and origin coincide: the pages that carry the duplicate are both
		 * what is wrong and where it is fixed.
		 */
		case "metadata_duplicated":
			return both(strings(detail.urls));

		case "canonical_missing":
			return both(one(detail.url));

		/**
		 * The page and whatever it nominated. A canonical defect is about a
		 * relationship between two URLs, so counting only the page that declared it
		 * would describe half of what the reader has to go and look at — the same
		 * reading rules 2 and 3 already get above. The declaring page is the origin;
		 * the URLs it named are the subject.
		 */
		case "canonical_conflicting":
			return {
				subject: [...one(detail.canonical), ...strings(detail.canonicals)],
				origin: one(detail.url),
			};

		case "canonical_target_broken":
			return {
				subject: one(detail.canonical),
				origin: one(detail.url),
			};

		case "noindex_present":
			return both(one(detail.url));

		/**
		 * Every URL serving the shared content. Filed against none of them for the
		 * same reason `metadata_duplicated` is — the problem is that there are
		 * several — so counting one would understate the whole of it.
		 */
		case "content_duplicated":
			return both(strings(detail.urls));

		/**
		 * The dead URL and every page pointing at it. The linking pages are where
		 * the fix happens, so a count that named only the target would understate
		 * how much of the site has to be edited.
		 */
		case "link_broken":
		case "link_external_broken":
			return {
				subject: one(detail.target),
				origin: strings(detail.linkedFrom),
			};

		/**
		 * The pages that did not carry the header, or carried it malformed. The
		 * finding is about a set of responses, so counting the one it is filed
		 * against — none — would report it as touching nothing.
		 */
		case "security_header_contradiction":
			return both(strings(detail.affectedUrls));

		/**
		 * The pages still linking at the stale URL, which are the pages a reader
		 * would edit. The hops in between are not pages of the site; they are
		 * routes, and the entry URL stands in as subject only when nothing links to
		 * it — a chain reached from the sitemap, or from where the run started.
		 * With linking pages present the entry is one of the hops, not a page to
		 * count twice.
		 */
		case "redirect_chain": {
			const linking = strings(detail.linkedFrom);
			return {
				subject: linking.length > 0 ? [] : one(detail.from),
				origin: linking,
			};
		}

		/**
		 * Deliberately none, in either role. A certificate belongs to the origin
		 * host rather than to any page, so "how many pages does this touch" has no
		 * honest answer — and inventing one would put every page on the site behind
		 * a single finding. Listed explicitly so this reads as a decision rather
		 * than as a type somebody forgot.
		 */
		case "certificate_problem":
			return { subject: [], origin: [] };

		/**
		 * Live pages the sitemap omits, pages nothing links to, and the URLs a
		 * robots.txt rule blocks. Each is about a set of URLs and none is filed
		 * against one.
		 *
		 * No origin: these are statements the product makes by reconciling the
		 * site's own sitemap or robots.txt against what the crawl found. There is
		 * no page that emits them, and pretending otherwise would let a
		 * corpus-wide finding correlate with everything it happens to mention.
		 */
		case "page_missing_from_sitemap":
		case "page_orphaned":
		case "robots_blocks_indexable":
			return { subject: strings(detail.urls), origin: [] };

		/**
		 * The normalised URL of each failing entry. The raw loc travels beside it
		 * as evidence, but it is the normalised form that names a page. Same
		 * reasoning as above for the absent origin.
		 */
		case "sitemap_url_failed":
			return {
				subject: Array.isArray(detail.entries)
					? (detail.entries as Array<Record<string, unknown>>).flatMap(
							(entry) =>
								typeof entry.normalised === "string" ? [entry.normalised] : [],
						)
					: [],
				origin: [],
			};

		default:
			// An unmapped type still counts the page it names, so a new finding
			// never reports as affecting nothing. It gets no origin, so it cannot
			// be correlated on evidence nobody has described yet.
			return { subject: one(finding.url), origin: [] };
	}
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
