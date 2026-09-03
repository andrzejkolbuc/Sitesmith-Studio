import { evidenceRoles } from "./summarise";

/**
 * One explained problem per underlying cause, instead of many symptoms.
 *
 * This is the domain rule — the decision the product makes that no other tool
 * makes for the user. Twenty-four rules each report honestly and each report
 * separately, and on a real client site that produced sixty-seven list entries
 * for what a person would call five or six problems: twenty dead links and eight
 * diverged variants that were one broken language switcher, thirty-four
 * duplicated-metadata findings that were three CMS templates seen through ten
 * languages.
 *
 * The hard part is not grouping. It is grouping *honestly*. Correlating on
 * shared evidence — "these two findings mention the same URL" — collapses
 * everything: measured against that same run it put sixty-six of sixty-seven
 * findings into one group spanning all five hundred and thirty-three pages,
 * because a single dead footer link names every page that points at it and so
 * bridges the whole site. Grouping by shared evidence is not grouping by shared
 * cause, and the gap between them is where a false correlation comes from.
 *
 * So the key is narrower, and it is the site's own claim rather than ours: the
 * set of hreflang variant families that the pages *emitting* the findings belong
 * to. Two pages are siblings because the site's own hreflang tags say they are.
 * If the same defect appears on the same page in every language, that is one
 * edit — and the site, not the product, is what said those pages are the same
 * page.
 *
 * Every narrowing below is a narrowing. Nothing here widens a group, and there
 * is no threshold anywhere: sets are equal or they are not.
 */

/** Why a group's findings are one problem. */
export type CorrelationShape =
	/** One variant family emits all of them. */
	| "one-family"
	/** The same several families exhibit all of them. */
	| "family-set"
	/** No family is known; the same pages emit all of them. */
	| "same-pages";

/**
 * A finding, as the results view holds it.
 *
 * Structural rather than imported from the schema, for the reason `parity.ts`
 * declares its own page shape: this module answers a question about rows, not
 * about a table, and should stay testable without one.
 */
export type CorrelatableFinding = {
	id: string;
	type: string;
	detail: Record<string, unknown>;
};

export type CorrelatablePage = {
	url: string;
	/** The hreflang family this page belongs to, as the crawl recorded it. */
	variantGroupKey: string | null;
};

export type CorrelatedProblem = {
	/** Stable within a run, so the view can key on it. */
	key: string;
	shape: CorrelationShape;
	/** The families the origin occupies; empty for a `same-pages` problem. */
	families: string[];
	/** The pages that emit it — where an editor goes. */
	originPages: string[];
	/** Two or more. A group of one is not a problem; see below. */
	findings: CorrelatableFinding[];
};

export type Correlated = {
	problems: CorrelatedProblem[];
	/** Everything not folded, in the order it arrived. */
	remainder: CorrelatableFinding[];
};

/**
 * Findings that speak about the corpus rather than about any page.
 *
 * Not listed here as an exclusion list — they are excluded because
 * `evidenceRoles` gives them no origin at all, which is a fact about what they
 * are rather than a rule about what to do with them. A sitemap reconciliation
 * has no author to visit: it is a statement the product makes by comparing the
 * site's own sitemap against what the crawl found, and it is already one finding
 * per cause.
 *
 * Excluding them structurally matters more than it looks. The alternative —
 * excluding a finding for being *too wide* — is a threshold that scales with the
 * defect it hunts, and a site whose sitemap is badly wrong is exactly the site
 * where such a threshold goes quiet.
 */

/**
 * Whether internal and external link failures may share a group.
 *
 * They may not. A site's own URL rot and a third party deleting a page are
 * different events, however much layout they share — and on the real run they
 * *did* share a layout: two dead internal test pages and one dead partner link
 * all sat in the same fifty-one-family footer. Grouping them would have told the
 * reader one edit fixes three things when one of them is not theirs to fix.
 *
 * A shared layout is a shared location, not a shared cause.
 */
function namespaceOf(type: string): string {
	return type === "link_external_broken" ? "external" : "internal";
}

/**
 * The family a URL belongs to, under either spelling.
 *
 * A trailing slash is punctuation, not identity. Origin URLs are recorded from
 * the markup of the page that linked them, while page rows are recorded from
 * what the crawler requested, and the two can disagree by exactly that
 * character — the mismatch that made the orphan rule miss real orphans until
 * S-04's last phase. Looking up one spelling only would decide correlation by
 * punctuation.
 */
function familyLookup(
	pages: CorrelatablePage[],
): (url: string) => string | null {
	const byUrl = new Map<string, string | null>();
	for (const page of pages) byUrl.set(page.url, page.variantGroupKey);

	return (url) => {
		const direct = byUrl.get(url);
		if (direct !== undefined) return direct;

		const other = url.endsWith("/") ? url.slice(0, -1) : `${url}/`;
		return byUrl.get(other) ?? null;
	};
}

export function correlate(
	findings: CorrelatableFinding[],
	pages: CorrelatablePage[],
): Correlated {
	const familyOf = familyLookup(pages);

	const grouped = new Map<
		string,
		{
			shape: CorrelationShape;
			families: string[];
			originPages: string[];
			findings: CorrelatableFinding[];
		}
	>();
	const remainder: CorrelatableFinding[] = [];

	for (const finding of findings) {
		const { origin } = evidenceRoles({
			type: finding.type,
			url: null,
			detail: finding.detail,
		});
		const originPages = [...new Set(origin)].sort();

		/**
		 * No origin, no correlation. Corpus-level findings land here, and so does
		 * any finding type added later and not yet described in `evidenceRoles` —
		 * failing towards reporting it on its own, which is the direction that
		 * cannot invent a relationship.
		 */
		if (originPages.length === 0) {
			remainder.push(finding);
			continue;
		}

		const families = originPages.map(familyOf);

		/**
		 * Every origin page must resolve, or the family set is a guess about the
		 * ones that did not. A partial set would let two findings correlate on the
		 * pages they happen to share while differing on the pages we could not
		 * place — so an unresolved page drops the whole finding back to requiring
		 * an identical origin set, which asserts nothing beyond what was observed.
		 */
		const resolved = families.every((f): f is string => f !== null);

		const distinct = resolved ? [...new Set(families as string[])].sort() : [];

		const shape: CorrelationShape = !resolved
			? "same-pages"
			: distinct.length === 1
				? "one-family"
				: "family-set";

		const namespace = namespaceOf(finding.type);
		const key =
			shape === "same-pages"
				? `${namespace}|pages:${originPages.join("|")}`
				: `${namespace}|families:${distinct.join("|")}`;

		const existing = grouped.get(key);
		if (existing) {
			existing.findings.push(finding);
			/**
			 * The union, not the first one seen. Two findings can share a family set
			 * while naming different pages within it — the same defect on the German
			 * and French members of one family — and a reader who is told to go and
			 * edit only the pages of whichever finding arrived first has been handed
			 * half the work.
			 */
			existing.originPages = [
				...new Set([...existing.originPages, ...originPages]),
			].sort();
		} else {
			grouped.set(key, {
				shape,
				families: distinct,
				originPages,
				findings: [finding],
			});
		}
	}

	const problems: CorrelatedProblem[] = [];

	for (const [key, group] of grouped) {
		/**
		 * A group of one is not a problem, it is a finding. Rendering it as a
		 * correlated problem would claim an inference the product did not make and
		 * would pad the section that exists to be shorter than the list below it.
		 */
		if (group.findings.length < 2) {
			remainder.push(...group.findings);
			continue;
		}

		problems.push({ key, ...group });
	}

	/**
	 * Biggest first, because the problem folding twenty-eight findings is the one
	 * the reader wants first. Ties broken on the key so that two runs over the
	 * same site produce the same order.
	 */
	problems.sort(
		(a, b) =>
			b.findings.length - a.findings.length || a.key.localeCompare(b.key),
	);

	/**
	 * Remainder keeps the order it arrived in. It is handed to the existing
	 * type-grouped list, which does its own grouping and would otherwise have its
	 * ordering silently decided here.
	 */
	const order = new Map(findings.map((f, i) => [f.id, i] as const));
	remainder.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

	return { problems, remainder };
}
