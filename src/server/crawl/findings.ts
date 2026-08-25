import type { CrawledPage } from "./crawler";
import { groupVariants, localeFromUrl, type PageVariant } from "./variants";

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
			if (present.has(locale)) continue;
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

	// ── Rules 2 and 3: declared siblings that failed or were never reached ────
	for (const page of [...pages].sort((a, b) => a.url.localeCompare(b.url))) {
		for (const [locale, target] of Object.entries(page.hreflangTargets).sort(
			([a], [b]) => a.localeCompare(b),
		)) {
			if (target === page.url) continue;

			const targetPage = byUrl.get(target);

			if (targetPage && isError(targetPage)) {
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

	// ── Rule 4: locale-shaped URL with no hreflang at all ─────────────────────
	//
	// Narrowed deliberately. Unnarrowed, this fires on every legitimately
	// monolingual page — a blog post, a legal page — and on a site with any
	// volume of those it buries the three rules above. A URL that already carries
	// a locale segment is a page claiming to be one language among several, so its
	// silence about the others is a real omission.
	for (const page of [...pages].sort((a, b) => a.url.localeCompare(b.url))) {
		if (isError(page)) continue;
		if (Object.keys(page.hreflangTargets).length > 0) continue;

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
