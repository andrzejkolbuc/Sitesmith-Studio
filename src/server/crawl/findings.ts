import type { CrawledPage } from "./crawler";
import {
	groupFamilies,
	groupVariants,
	localeFromUrl,
	type PageVariant,
} from "./variants";

/**
 * Turning what the crawl observed into what the product concluded.
 *
 * Four rules, each answering "a language variant is missing" in a different
 * sense. They are separated rather than merged because they differ in how
 * certain they are: rules 2 and 3 are self-evidencing — the site's own
 * declaration contradicts its own behaviour — while rules 1 and 4 depend on
 * expectations that could themselves be wrong.
 */

export const FINDING_TYPES = {
	/** A locale the project expects, absent from this variant family. */
	MISSING_LOCALE: "missing_locale",
	/** A declared sibling that returned an error. */
	HREFLANG_TARGET_FAILED: "hreflang_target_failed",
	/** A declared sibling the crawl never reached. */
	HREFLANG_TARGET_UNREACHED: "hreflang_target_unreached",
	/** A locale-shaped URL declaring no alternates at all. */
	NO_HREFLANG: "no_hreflang",
	/** A family whose members' declarations disagree with each other. */
	HREFLANG_FAMILY_INCONSISTENT: "hreflang_family_inconsistent",
	/** One variant failing while its siblings are fine. */
	VARIANT_DIVERGED: "variant_diverged",
} as const;

export type FindingType = (typeof FINDING_TYPES)[keyof typeof FINDING_TYPES];

export type Finding = {
	type: FindingType;
	/** The page the finding is about; null for family-level findings. */
	url: string | null;
	/** Evidence — enough to act on without re-running the crawl. */
	detail: Record<string, unknown>;
};

export type DetectOptions = {
	pages: CrawledPage[];
	/** Locales the project declares it expects to publish. */
	expectedLocales: string[];
	/** Used to avoid reporting a declared sibling that is legitimately out of scope. */
	inScope: (url: string) => boolean;
};

/**
 * Whether a family already publishes the language a project asked for.
 *
 * Deliberately one-directional. A site publishing `en-us` and `en-gb` publishes
 * English, so a project expecting `en` is answered — reporting English missing
 * from a family holding two English pages is a false positive carrying its own
 * refutation.
 *
 * The reverse is not true and must not be: a project expecting `en-gb` has said
 * it needs British English specifically, and accepting a generic `en` page would
 * hide the very gap the project was configured to find.
 */
const satisfies = (present: Set<string>, expected: string): boolean => {
	if (present.has(expected)) return true;
	return [...present].some((locale) => locale.startsWith(`${expected}-`));
};

const isError = (page: CrawledPage): boolean =>
	page.fetchError !== null ||
	page.httpStatus === null ||
	page.httpStatus >= 400;

/**
 * Runs all four rules over one crawl.
 *
 * Order is stable so two runs over the same site produce comparable output —
 * which matters because a later slice diffs runs against each other.
 */
export function detectMissingVariants(options: DetectOptions): Finding[] {
	const { pages, expectedLocales, inScope } = options;

	const variants = groupVariants(pages);
	const byUrl = new Map(pages.map((page) => [page.url, page]));
	const expected = expectedLocales.map((locale) => locale.toLowerCase());

	const findings: Finding[] = [];

	// ── Rule 1: a declared locale has no page in this family ──────────────────
	//
	// Only families containing at least one healthy page are considered. A family
	// whose every member errored has a different problem, and reporting it as
	// "missing a variant" would bury the real one.
	const families = new Map<string, PageVariant[]>();
	for (const variant of variants.values()) {
		const members = families.get(variant.groupKey) ?? [];
		members.push(variant);
		families.set(variant.groupKey, members);
	}

	for (const [groupKey, members] of [...families.entries()].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		/**
		 * A family of one is not evidence that translations are expected.
		 *
		 * A lone German blog post is a German blog post, not a page missing its
		 * English and French siblings. Without this guard, a site with fifty
		 * untranslated posts reports a hundred findings and buries the handful
		 * that matter — the same noise failure rule 4 was narrowed to avoid.
		 *
		 * Two or more members means the site has demonstrated it translates this
		 * content, which is what makes a gap in the set meaningful.
		 */
		if (members.length < 2) continue;

		const healthy = members.filter((m) => {
			const page = byUrl.get(m.url);
			return page && !isError(page);
		});
		if (healthy.length === 0) continue;

		/**
		 * Presence counts every member, healthy or not. A declared sibling that
		 * errored is already reported by rule 2; calling it "missing" here as well
		 * would report one problem twice under two different names.
		 */
		const present = new Set(
			members.map((m) => m.locale).filter((l): l is string => l !== null),
		);
		if (present.size === 0) continue;

		for (const locale of expected) {
			if (satisfies(present, locale)) continue;
			findings.push({
				type: FINDING_TYPES.MISSING_LOCALE,
				url: groupKey,
				detail: {
					groupKey,
					missingLocale: locale,
					presentLocales: [...present].sort(),
					memberUrls: members.map((m) => m.url).sort(),
				},
			});
		}
	}

	// ── Rule 6: one variant failing while its siblings are fine ───────────────
	//
	// Computed before rules 2 and 3 because it decides what they are allowed to
	// say. The requirement is specific about the shape of the answer: "where five
	// language variants are healthy and one is not, the divergence itself is the
	// finding, not five independent per-URL reports of which one happens to be
	// bad" — and that is exactly what was measured before this rule existed. A
	// six-variant family with one broken member produced five findings, one per
	// declaring sibling, each saying the same thing.
	//
	// Collapsed only past two declarers. With a single declarer the per-URL
	// finding already *is* one finding, so collapsing would rename a working
	// report for no gain — and every fixture in the project is built on that
	// shape.
	const collapsed = new Map<string, Record<string, unknown>>();

	/**
	 * Pages a family finding already speaks for.
	 *
	 * Read by rule 4 below, which otherwise reports the same fact a second time
	 * and less usefully: a page that declares nothing is both "silent" and "not
	 * linking back to the sibling that declares it", and only the second names
	 * what to add.
	 */
	const describedByFamily = new Set<string>();

	for (const family of groupFamilies(pages)) {
		const healthy = family.members.filter((member) => {
			const page = byUrl.get(member.url);
			return page && !isError(page);
		});

		/**
		 * A uniformly broken family has not diverged; it is down. Naming it a
		 * divergence would point the reader at a comparison when what they need to
		 * know is that the whole section is failing.
		 */
		if (healthy.length === 0) continue;

		for (const member of family.members) {
			const page = byUrl.get(member.url);
			if (!page || !isError(page)) continue;

			const declaredBy = healthy
				.filter((sibling) => sibling.declares.has(member.url))
				.map((sibling) => sibling.url)
				.sort();

			if (declaredBy.length < 2) continue;

			collapsed.set(member.url, {
				groupKey: family.groupKey,
				brokenUrl: member.url,
				/**
				 * Available even though the page served nothing, because a sibling
				 * named its language — the same sibling-declaration precedence that
				 * stopped a broken variant being reported twice in S-01.
				 */
				locale: member.locale,
				httpStatus: page.httpStatus,
				fetchError: page.fetchError,
				declaredBy,
				healthyUrls: healthy.map((sibling) => sibling.url).sort(),
			});
		}
	}

	for (const [, detail] of [...collapsed.entries()].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		findings.push({
			type: FINDING_TYPES.VARIANT_DIVERGED,
			url: null,
			detail,
		});
	}

	// ── Rules 2 and 3: declared siblings that failed or were never reached ────
	for (const page of [...pages].sort((a, b) => a.url.localeCompare(b.url))) {
		for (const [locale, target] of Object.entries(page.hreflangTargets).sort(
			([a], [b]) => a.localeCompare(b),
		)) {
			if (target === page.url) continue;

			const targetPage = byUrl.get(target);

			if (targetPage && isError(targetPage)) {
				/**
				 * Already said once, for the whole family. The divergence finding
				 * carries this page among its declarers and the same status, so
				 * emitting here as well would report one problem twice.
				 */
				if (collapsed.has(target)) continue;

				findings.push({
					type: FINDING_TYPES.HREFLANG_TARGET_FAILED,
					url: page.url,
					detail: {
						declaredBy: page.url,
						locale,
						target,
						httpStatus: targetPage.httpStatus,
						fetchError: targetPage.fetchError,
					},
				});
				continue;
			}

			/**
			 * Not reached. Suppressed when the target is outside the configured
			 * scope — the crawl was told not to go there, so its absence is the
			 * configuration working, not the site being broken.
			 */
			if (!targetPage && inScope(target)) {
				findings.push({
					type: FINDING_TYPES.HREFLANG_TARGET_UNREACHED,
					url: page.url,
					detail: { declaredBy: page.url, locale, target },
				});
			}
		}
	}

	// ── Rule 5: a family whose declarations disagree with each other ──────────
	//
	// FR-025's remaining half. "Pointing at dead URLs" is rules 2 and 3; this is
	// non-reciprocal and incomplete, plus the self-reference the hreflang
	// guidance requires of every page in a set.
	//
	// One finding per family, never per page or per edge. A template emitting a
	// partial alternate list breaks every page it renders, so per-edge reporting
	// would make the worst sites the least readable — and the requirement asks
	// for the same thing in its own words: the divergence itself is the finding.
	for (const family of groupFamilies(pages)) {
		/**
		 * Judged among the members that actually loaded.
		 *
		 * A page returning 404 has no HTML and therefore no hreflang, so it cannot
		 * declare anything back — reporting it for failing to would blame a page
		 * for being broken in a second, less accurate way, when rule 2 already says
		 * it plainly. A broken sibling is likewise not something the healthy members
		 * should be told to link to.
		 *
		 * Found by the S-01 test that pins the broken-variant finding to exactly one
		 * report; the first draft of this rule made it two.
		 */
		const reachable = family.members.filter((member) => {
			const page = byUrl.get(member.url);
			return page && !isError(page);
		});

		/**
		 * Narrowed again to the members the family reaches by a *language* edge.
		 *
		 * Grouping unions on every declared target, fallback pointers included, so a
		 * language-selector page named only by `x-default` arrives here as a family
		 * member. It is not a translation of anything — it declares no language and
		 * no language declares it — and leaving it in makes a correct site look
		 * broken from both directions at once: the selector is blamed for naming no
		 * siblings, and every real variant is blamed for not naming the selector.
		 *
		 * Declaring itself does not count as a link. A page that names only its own
		 * language has said nothing about being related to anyone.
		 */
		const declaredTargets = new Set(
			reachable.flatMap((member) => [...member.declares]),
		);
		const members = reachable.filter(
			(member) => member.declares.size > 0 || declaredTargets.has(member.url),
		);

		/**
		 * The same guard rule 1 carries, for the same reason. A page with no
		 * siblings cannot disagree with them, and without this a site of
		 * untranslated pages reports one finding each.
		 */
		if (members.length < 2) continue;

		const defects: Array<Record<string, unknown>> = [];

		for (const member of members) {
			for (const sibling of members) {
				if (sibling.url === member.url) continue;
				if (member.declares.has(sibling.url)) continue;

				/**
				 * Classified exclusively, because the two describe the same omission
				 * from different sides and the fix differs. If the sibling named this
				 * member, the link back is what is missing. If neither named the other,
				 * the two pages simply never knew about each other.
				 *
				 * Reporting both labels for one omission would be the double-report
				 * S-01 already had to fix once, at a smaller scale.
				 */
				/**
				 * The sibling's locale travels with the defect, because it is the part
				 * the reader has to type. Knowing which page is missing a link is only
				 * half an instruction: the fix is a tag naming a language, and making
				 * someone open the sibling to find out which one defeats the point of
				 * a finding being actionable without re-running the crawl.
				 */
				defects.push({
					url: member.url,
					kind: sibling.declares.has(member.url)
						? "not_reciprocated"
						: "incomplete",
					sibling: sibling.url,
					siblingLocale: sibling.locale,
				});
			}

			/**
			 * Only meaningful for a page that declares something. A member that
			 * declares nothing at all is already fully described by the missing
			 * sibling declarations above; adding "and it does not name itself" would
			 * pad the finding without telling the reader anything new.
			 */
			if (!member.declaresSelf && member.declares.size > 0) {
				defects.push({
					url: member.url,
					kind: "no_self_reference",
					locale: member.locale,
				});
			}
		}

		if (defects.length === 0) continue;

		for (const defect of defects) {
			if (typeof defect.url === "string") describedByFamily.add(defect.url);
		}

		findings.push({
			type: FINDING_TYPES.HREFLANG_FAMILY_INCONSISTENT,
			url: null,
			detail: {
				groupKey: family.groupKey,
				memberUrls: members.map((m) => m.url),
				defects,
			},
		});
	}

	// ── Rule 4: locale-shaped URL with no hreflang at all ─────────────────────
	//
	// Narrowed deliberately. Unnarrowed, this fires on every legitimately
	// monolingual page — a blog post, a legal page — and on a site with any
	// volume of those it buries the three rules above. A URL that already carries
	// a locale segment is a page claiming to be one language among several, so its
	// silence about the others is a real omission.
	for (const page of [...pages].sort((a, b) => a.url.localeCompare(b.url))) {
		if (isError(page)) continue;

		/**
		 * Alternates that point somewhere else. A self-referencing link is standard
		 * practice and says nothing about translations, so a page whose only
		 * alternate is itself has declared that it has no siblings — which is what
		 * this rule reports, and is indistinguishable to a reader from declaring
		 * nothing at all. Counting the raw entries let such a page go unreported.
		 */
		const alternates = Object.entries(page.hreflangTargets).filter(
			([, target]) => target !== page.url,
		);
		if (alternates.length > 0) continue;

		/**
		 * Deferred to the family finding when one already names this page. That
		 * finding says the same thing and says it better — which sibling, and in
		 * which language — so repeating it here would be one problem under two
		 * names.
		 */
		if (describedByFamily.has(page.url)) continue;

		const impliedLocale = localeFromUrl(page.url);
		if (!impliedLocale) continue;

		findings.push({
			type: FINDING_TYPES.NO_HREFLANG,
			url: page.url,
			detail: { url: page.url, impliedLocale },
		});
	}

	return findings;
}
