import { BLOCK_NAMES, type ContentSummary } from "./content";
import type { Alias, CrawledPage, Hop, Reverification } from "./crawler";
import { type ExternalSweep, isGone } from "./external";
import { parseRobotsHeader } from "./metadata";
import { evaluatePath, type RobotsFile, type RobotsRule } from "./robots";
import { reconcile, type SitemapDocument } from "./sitemap";
import type { CertificateObservation } from "./tls";
import { normaliseUrl } from "./url";
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
	/** A page that was never translated, or never finished rendering. */
	CONTENT_UNTRANSLATED: "content_untranslated",
	/** A family whose variants disagree about what their content contains. */
	CONTENT_STRUCTURE_DIFFERS: "content_structure_differs",
	/** A page that published no title, or no meta description. */
	METADATA_MISSING: "metadata_missing",
	/** Pages in one language publishing the same title or description. */
	METADATA_DUPLICATED: "metadata_duplicated",
	/** A page declaring no canonical, on a site that declares them elsewhere. */
	CANONICAL_MISSING: "canonical_missing",
	/** A page whose canonicals contradict each other, or point down a chain. */
	CANONICAL_CONFLICTING: "canonical_conflicting",
	/** A canonical naming a page that errored, or one the crawl never reached. */
	CANONICAL_TARGET_BROKEN: "canonical_target_broken",
	/** A page telling search engines not to index it, from either channel. */
	NOINDEX_PRESENT: "noindex_present",
	/** Several URLs serving byte-identical content, in any language. */
	CONTENT_DUPLICATED: "content_duplicated",
	/** A page linked from somewhere on the site that does not load. */
	LINK_BROKEN: "link_broken",
	/** A certificate that has expired, is about to, or was not accepted. */
	CERTIFICATE_PROBLEM: "certificate_problem",
	/** A security header the site contradicts itself about. */
	SECURITY_HEADER_CONTRADICTION: "security_header_contradiction",
	/** A URL the sitemap submits that does not load. */
	SITEMAP_URL_FAILED: "sitemap_url_failed",
	/** A live page the site did not submit in its own sitemap. */
	PAGE_MISSING_FROM_SITEMAP: "page_missing_from_sitemap",
	/** A robots.txt rule blocking a URL the site's own sitemap submits. */
	ROBOTS_BLOCKS_INDEXABLE: "robots_blocks_indexable",
	/** A page the sitemap submits that nothing on the site links to. */
	PAGE_ORPHANED: "page_orphaned",
	/** A link leaving the site whose target is gone. */
	LINK_EXTERNAL_BROKEN: "link_external_broken",
	/** A redirect chain of more than one hop, or one that goes round. */
	REDIRECT_CHAIN: "redirect_chain",
	/** Images the page reserves no space for, so the layout shifts as they load. */
	IMAGE_MISSING_DIMENSIONS: "image_missing_dimensions",
	/** Images offered in no format newer than JPEG or PNG. */
	IMAGE_LEGACY_FORMAT: "image_legacy_format",
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
	/**
	 * Whether the crawl reached the end of the site, rather than stopping at the
	 * page ceiling, aborting on failures, or being interrupted.
	 *
	 * Two rules reason from absence — rule 1 from a locale missing in a family,
	 * rule 3 from a declared sibling missing from the crawl — and both inferences
	 * hold only if the crawl actually finished. Required rather than optional on
	 * purpose: a caller that forgets would silently get the confident-and-wrong
	 * behaviour rather than the safe one.
	 */
	crawlComplete: boolean;
	/**
	 * Failures the crawl asked about a second time.
	 *
	 * Required for the same reason `crawlComplete` is, though it fails safe in the
	 * opposite direction: a caller that forgets hands the broken-link rule no
	 * confirmed failures, and the rule goes quiet about every 5xx rather than
	 * reporting one on a single observation.
	 */
	reverified: Reverification[];
	/**
	 * The certificate the origin presented, or null when there was none to read.
	 * Null is silence: a probe that could not run is a fact about us.
	 */
	certificate: CertificateObservation | null;
	/**
	 * The site's robots.txt, parsed, or null when it published none.
	 *
	 * Null is silence rather than permission: no rule here reads an absent
	 * robots.txt as the site asserting anything.
	 */
	robots: RobotsFile | null;
	/**
	 * The site's sitemap, or null when it published none we could find.
	 * Null is silence, never permission to infer anything.
	 */
	sitemap: SitemapDocument | null;
	/** Where the crawl entered, so the orphan rule can exempt it. */
	entryUrl: string | null;
	/**
	 * Whether the project restricted the crawl to a subset of its own site.
	 *
	 * Required rather than optional, for the reason `crawlComplete` is: a caller
	 * that forgot would get the confident-and-wrong behaviour rather than the safe
	 * one.
	 *
	 * The orphan rule is the one that needs it. A scoped crawl was told not to
	 * visit most of the site, so it cannot have seen the pages that link to
	 * anything outside the scope — and "nothing links here" then describes the
	 * instruction we were given rather than the site we were checking.
	 */
	scopeNarrowed: boolean;
	/**
	 * Every in-scope URL the crawl put on its frontier.
	 *
	 * The orphan rule reads this rather than `pages`: a URL absent from here was
	 * never linked to by anything, while one present but unrecorded was reached
	 * and redirected somewhere already known.
	 */
	requested: string[];
	/** The links leaving the site, as checked after the crawl drained. */
	external: ExternalSweep;
	/**
	 * Routes that led somewhere other than where they were asked for.
	 *
	 * Read beside `pages` rather than instead of it, because the two hold
	 * different halves of the same fact: a route ending at a URL the crawl
	 * already recorded is discarded whole — hop list included — and that is
	 * the commonest shape a real chain takes: an old URL pointing at a new one
	 * the navigation also links.
	 */
	aliases: Alias[];
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
 * The directives that keep a page out of an index.
 *
 * `none` is defined as equivalent to `noindex, nofollow`, so it belongs here —
 * but the extractor deliberately leaves it as the word the page published, and
 * the finding quotes that word back. The equivalence is vocabulary a rule
 * applies; the evidence is what the site wrote.
 */
const NOINDEX_DIRECTIVES = new Set(["noindex", "none"]);

/**
 * Runs all four rules over one crawl.
 *
 * Order is stable so two runs over the same site produce comparable output —
 * which matters because a later slice diffs runs against each other.
 */
export function detectMissingVariants(options: DetectOptions): Finding[] {
	const {
		pages,
		expectedLocales,
		inScope,
		crawlComplete,
		reverified,
		certificate,
		robots,
		sitemap,
		entryUrl,
		requested,
		external,
		aliases,
		scopeNarrowed,
	} = options;

	const variants = groupVariants(pages);

	/**
	 * Built once and shared.
	 *
	 * `groupFamilies` walks the hreflang graph itself, so calling it per rule
	 * meant the union-find ran three times over a crawl that can hold two
	 * thousand pages. Nothing was wrong with the result — the rules simply grew
	 * one at a time, each reaching for the graph as though it were free.
	 */
	const variantFamilies = groupFamilies(pages);
	const byUrl = new Map(pages.map((page) => [page.url, page]));
	const expected = expectedLocales.map((locale) => locale.toLowerCase());

	/**
	 * Which pages link to a given URL.
	 *
	 * Derived here rather than passed in, for the reason `byUrl` and
	 * `variantFamilies` are: it is a pure reading of `pages`, and a caller handing
	 * us an index built from a different set of pages than the one it also handed
	 * us is a failure mode worth not having.
	 *
	 * In-scope targets only. An external link is captured by the extractor and
	 * belongs to a rule that can actually go and check it.
	 */
	const linkedFrom = new Map<string, string[]>();
	for (const page of pages) {
		for (const link of page.links) {
			if (!inScope(link)) continue;
			if (link === page.url) continue;
			linkedFrom.set(link, [...(linkedFrom.get(link) ?? []), page.url]);
		}
	}

	/**
	 * URLs an earlier rule has already called broken.
	 *
	 * Read by rule 16, which would otherwise report a third time what rules 2, 6
	 * and 13 have each said more specifically — a declared sibling, a diverged
	 * variant, a nominated canonical. "It is also linked from four pages" is not
	 * worth a second heading in the list.
	 */
	const reportedBrokenTargets = new Set<string>();

	/**
	 * Pages that asked not to be indexed, on either channel.
	 *
	 * Populated by rule 14 and read by rule 20, which must not report a `noindex`
	 * page as missing from the sitemap: a site that told search engines to skip a
	 * page is *consistent* in leaving it out of its index submission, and saying
	 * otherwise would report the site for doing two things that agree.
	 */
	const noindexed = new Set<string>();

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
		 * A locale is only missing if we finished looking. On a truncated crawl the
		 * page publishing it may sit beyond the ceiling, and reporting it absent
		 * blames the site for where we stopped.
		 */
		if (!crawlComplete) break;
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

	for (const family of variantFamilies) {
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

	for (const [brokenUrl, detail] of [...collapsed.entries()].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		reportedBrokenTargets.add(brokenUrl);
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

				reportedBrokenTargets.add(target);
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
			/**
			 * Only meaningful on a crawl that finished. Against a real site this rule
			 * produced eighteen findings from a twenty-page run, every one naming a
			 * page that returns 200 — the ceiling was reached before the German
			 * section, and the tool reported its own limit as the client's defect.
			 */
			if (!targetPage && crawlComplete && inScope(target)) {
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
	for (const family of variantFamilies) {
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
				 * The question is about a language, not a URL.
				 *
				 * "does not link to /de/careers (de)" is a complaint about German, and
				 * a page that publishes German somewhere else has answered it. Asking
				 * for one specific URL reported four false defects on a real site whose
				 * hreflang was correct.
				 */
				if (sibling.locale) {
					// A page does not link to another page in its own language; the set
					// holds one page per language by definition.
					if (
						member.locale &&
						satisfies(new Set([member.locale]), sibling.locale)
					) {
						continue;
					}
					// Or it declares that language, pointing somewhere else.
					if (satisfies(member.declaredLocales, sibling.locale)) continue;
				}

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

	// ── Rule 7: content that was never translated ─────────────────────────────
	//
	// FR-027's first and most trustworthy signal, in two kinds of evidence that
	// share a finding type because they are one story to the reader: this page was
	// never finished. The `kind` in the detail says which was observed, following
	// the same discriminator rule 5 uses for its defects.
	//
	// Both kinds skip pages that errored. A page that 404s has no content at all,
	// so every content rule would rank it as the most extreme drift on the site —
	// while rules 2 and 6 are already describing it correctly, and better. That is
	// the double-report this file spends half its length avoiding.

	/**
	 * A template that reached the reader.
	 *
	 * Per page and independent of family, because an unrendered expression is a
	 * defect on a monolingual page too — nothing about it depends on there being
	 * a translation to compare against. It needs no `crawlComplete` guard for the
	 * same reason: the evidence is on the page in front of us, not in the shape of
	 * what we did or did not reach.
	 */
	for (const page of [...pages].sort((a, b) => a.url.localeCompare(b.url))) {
		if (isError(page)) continue;
		if (!page.content.isHtml) continue;
		if (page.content.markers.length === 0) continue;

		findings.push({
			type: FINDING_TYPES.CONTENT_UNTRANSLATED,
			url: page.url,
			detail: {
				kind: "placeholder_markers",
				url: page.url,
				locale: variants.get(page.url)?.locale ?? null,
				markers: [...page.content.markers].sort(),
			},
		});
	}

	/**
	 * Pages inside one family serving the same content under different languages.
	 *
	 * Reported once per identical *set*, never once per page. Two pages sharing a
	 * body is one problem, and naming it twice — once from each side — would be
	 * the defect rule 6 was written to collapse, reappearing under a new type. A
	 * family where German and French were both copied from English is one finding
	 * naming three URLs, not three findings naming each other.
	 *
	 * Only meaningful on a crawl that finished: a truncated run can hold half a
	 * family, and the members it did not reach are the ones most likely to carry
	 * the real translation.
	 */

	/**
	 * The identical sets this rule has already spoken for.
	 *
	 * Read by rule 15, which asks a wider question over the same digests and would
	 * otherwise report the same URLs a second time under a second heading. Keyed on
	 * the digest *and* the exact set of URLs rather than the digest alone: if a page
	 * outside the family carries the same content, that is a larger fact than this
	 * rule observed, and rule 15 should still be free to say so.
	 */
	const identicalSetsReported = new Set<string>();

	if (crawlComplete) {
		for (const family of variantFamilies) {
			if (family.members.length < 2) continue;

			const byDigest = new Map<
				string,
				Array<{ url: string; locale: string }>
			>();

			for (const member of family.members) {
				const page = byUrl.get(member.url);
				if (!page || isError(page) || !page.content.isHtml) continue;

				const digest = page.content.textDigest;
				/**
				 * Null below the comparable-length floor. A page with almost no text
				 * matches its sibling by accident rather than by neglect.
				 */
				if (!digest) continue;
				/**
				 * A member whose language nothing established cannot be said to be
				 * untranslated — there is no language it failed to be in.
				 */
				if (!member.locale) continue;

				byDigest.set(digest, [
					...(byDigest.get(digest) ?? []),
					{ url: member.url, locale: member.locale },
				]);
			}

			for (const [digest, sharing] of [...byDigest.entries()].sort(([a], [b]) =>
				a.localeCompare(b),
			)) {
				/**
				 * Two *languages*, not two URLs and not two locale tags.
				 *
				 * One page is nothing to compare. Two URLs serving one language
				 * identically is duplicate content — a real problem, a different one,
				 * and no evidence that anything went untranslated. And `en` beside
				 * `en-gb` is that same case wearing two tags: a British page carrying
				 * the generic English body has not failed to be translated, because
				 * there was never a second language involved.
				 *
				 * Compared on the primary subtag for the same reason `satisfies` above
				 * treats a regional refinement as answering for its language.
				 */
				const languages = new Set(
					sharing.map((m) => m.locale.split(/[-_]/)[0] ?? m.locale),
				);
				if (languages.size < 2) continue;

				const locales = new Set(sharing.map((m) => m.locale));
				const urls = sharing.map((m) => m.url).sort();

				identicalSetsReported.add(JSON.stringify([digest, urls]));

				findings.push({
					type: FINDING_TYPES.CONTENT_UNTRANSLATED,
					url: null,
					detail: {
						kind: "identical_to_siblings",
						groupKey: family.groupKey,
						urls,
						locales: [...locales].sort(),
					},
				});
			}
		}
	}

	// ── Rule 8: variants that disagree about what they contain ────────────────
	//
	// FR-027's "missing sections", judged on the presence of a block type and
	// never on how many of it there are. Translators legitimately merge and split
	// headings, so a rule comparing counts would fire on honest work — which is
	// the objection the PRD raised against content drift and the reason this slice
	// ships the signals that can be stated as yes or no.
	//
	// One finding per family, matching rule 5's shape and for the same reason: a
	// template that dropped a block in one locale breaks every page it renders,
	// and per-page reporting would make the worst sites the least readable.
	//
	// The finding names both sides of each difference and designates no culprit.
	// With two members there is no basis to say which is wrong, and with more it
	// is still the site's editors who know which way the content was supposed to
	// go. The difference itself is the actionable fact.
	if (crawlComplete) {
		for (const family of variantFamilies) {
			/**
			 * Only members whose content we actually isolated.
			 *
			 * A summary that fell back to the whole body carries the navigation with
			 * it, and a site with a search box in its header would show every page as
			 * containing a form. Comparing those would be comparing our extraction
			 * rather than the site — the distinction `context/foundation/lessons.md`
			 * exists to enforce — so the rule declines instead.
			 */
			const comparable: Array<{ url: string; content: ContentSummary }> = [];
			for (const member of family.members) {
				const page = byUrl.get(member.url);
				if (!page || isError(page)) continue;
				if (!page.content.isHtml || !page.content.isolated) continue;
				comparable.push({ url: member.url, content: page.content });
			}

			if (comparable.length < 2) continue;

			const differences: Array<Record<string, unknown>> = [];

			for (const block of BLOCK_NAMES) {
				const present = comparable
					.filter((m) => m.content.blocks[block])
					.map((m) => m.url)
					.sort();
				const absent = comparable
					.filter((m) => !m.content.blocks[block])
					.map((m) => m.url)
					.sort();

				// Agreement, either way, is not a difference.
				if (present.length === 0 || absent.length === 0) continue;

				differences.push({ block, present, absent });
			}

			if (differences.length === 0) continue;

			findings.push({
				type: FINDING_TYPES.CONTENT_STRUCTURE_DIFFERS,
				url: null,
				detail: {
					groupKey: family.groupKey,
					memberUrls: comparable.map((m) => m.url).sort(),
					differences,
				},
			});
		}
	}

	// ── Rule 9: a page that published no title or no description ──────────────
	//
	// FR-021's plainest signal and entirely the site's own assertion: the tag is
	// absent, or it is there and empty. Those are the same fact to a search
	// engine, so the extractor already reduces both to null and this rule does
	// not need to know there were ever two shapes.
	//
	// One finding per page, never one per field. A head that was never filled in
	// is one defect, and splitting it would put the same page in the same list
	// twice — the double-report the rest of this file spends its length
	// avoiding.
	for (const page of [...pages].sort((a, b) => a.url.localeCompare(b.url))) {
		if (isError(page)) continue;
		/**
		 * A PDF or a feed has no `<title>` element and never should. Reporting one
		 * as missing its title would be a finding about the format the URL serves
		 * rather than about anything the site got wrong.
		 */
		if (!page.content.isHtml) continue;

		const fields: string[] = [];
		if (page.metadata.title === null) fields.push("title");
		if (page.metadata.description === null) fields.push("description");
		if (fields.length === 0) continue;

		findings.push({
			type: FINDING_TYPES.METADATA_MISSING,
			url: page.url,
			detail: { url: page.url, fields },
		});
	}

	// ── Rule 10: one title or description published on several pages ──────────
	//
	// FR-021's second signal, and the one with a confirmed defect behind it: a
	// template fallback nobody filled in serves the homepage's title on a legal
	// page. Reported once per duplicated *string* and never once per page,
	// following rule 7's shape — two pages sharing a title is one problem, and
	// naming it from each side would be the double-report rule 6 was written to
	// collapse.
	//
	// **Scoped to a language.** Two locale variants legitimately share a title —
	// a brand or product name — and a page whose German copy is byte-identical
	// to its English is already reported by rule 7. Without this scope the same
	// defect arrives twice under two headings, and honest translations that
	// share a proper noun arrive as a defect at all.
	//
	// Compared on the primary subtag, for the reason `satisfies` treats a
	// regional refinement as answering for its language: `en` and `en-gb` pages
	// sharing a title compete for the same query, which is the whole reason
	// duplicate titles matter.
	//
	// **Pages with no established language form their own bucket** rather than
	// being skipped. The original refusal was right about what it was refusing:
	// calling two pages duplicates *in a language* neither of them declared is a
	// claim about our guess. But it also made the rule silent on a site that
	// publishes one language and says so nowhere — no hreflang, no locale path
	// segment — which is every monolingual site, and FR-020 asks about duplicates
	// "across URLs" without qualifying by language at all.
	//
	// Bucketing rather than merging keeps both readings honest. Two unlocalised
	// pages sharing a title share it, and that is the site's own assertion with no
	// guess in it. An unlocalised page and a `de` page sharing one are not compared,
	// because deciding they are the same language would be the guess the original
	// refusal named.
	//
	// Only on a crawl that finished. The finding's substance is a list of every
	// page carrying the string, and a truncated run can hold one member of a
	// pair and not the other — so the list would describe where we stopped
	// rather than what the site publishes.
	if (crawlComplete) {
		const byValue = new Map<
			string,
			{
				field: string;
				language: string | null;
				value: string;
				urls: string[];
			}
		>();

		for (const page of [...pages].sort((a, b) => a.url.localeCompare(b.url))) {
			if (isError(page)) continue;

			/**
			 * Null when nothing established a language, and carried as null rather
			 * than as a placeholder string. A page could publish a title in a locale
			 * literally named `unknown`, and collapsing the two would report a real
			 * language and our absence of one as the same bucket.
			 */
			const locale = variants.get(page.url)?.locale;
			const language = locale ? (locale.split(/[-_]/)[0] ?? locale) : null;

			for (const [field, value] of [
				["title", page.metadata.title],
				["description", page.metadata.description],
			] as const) {
				if (value === null) continue;

				/**
				 * Serialised rather than concatenated with a separator. A title can
				 * contain any character at all, so any delimiter chosen here is a
				 * delimiter a page could publish — and two different strings would
				 * then key alike and be reported as one duplicate.
				 */
				const key = JSON.stringify([field, language, value]);
				const entry = byValue.get(key) ?? { field, language, value, urls: [] };
				entry.urls.push(page.url);
				byValue.set(key, entry);
			}
		}

		for (const [, entry] of [...byValue.entries()].sort(([a], [b]) =>
			a.localeCompare(b),
		)) {
			// One page publishing a string is a page publishing a string.
			if (entry.urls.length < 2) continue;

			findings.push({
				type: FINDING_TYPES.METADATA_DUPLICATED,
				url: null,
				detail: {
					field: entry.field,
					language: entry.language,
					value: entry.value,
					urls: [...entry.urls].sort(),
				},
			});
		}
	}

	// ── Rules 11, 12 and 13: what a page says its canonical URL is ────────────
	//
	// FR-022, in three defects that share one input. Every canonical below has
	// already been through `normaliseUrl` in the extractor, and every page URL
	// through it in the crawler — but both sides pass through again here, because
	// these rules are also called with pages a test built by hand, and a
	// comparison that only works when its caller normalised first is a comparison
	// waiting to report our own trailing slash as the client's defect.

	/**
	 * A page's canonicals, in the same shape as the URL they are compared to.
	 *
	 * Deduplicated *after* normalising rather than before: two hrefs differing
	 * only by a trailing slash or a tracking parameter name one URL, and counting
	 * them as two would make "this page declares several canonicals" fire on a
	 * page that declares one.
	 */
	const canonicalsOf = (page: CrawledPage): string[] => [
		...new Set(
			page.metadata.canonicals
				.map((href) => normaliseUrl(href))
				.filter((href): href is string => href !== null),
		),
	];

	const selfUrl = (page: CrawledPage): string =>
		normaliseUrl(page.url) ?? page.url;

	/**
	 * The pages the canonical rules are willing to speak about.
	 *
	 * The same two exclusions rule 9 makes, for the same reasons: a page that
	 * errored served no head at all, and a PDF has no canonical link element and
	 * never should — reporting either would be a finding about the response
	 * rather than about the site.
	 */
	const canonicalCandidates = [...pages]
		.filter((page) => !isError(page) && page.content.isHtml)
		.sort((a, b) => a.url.localeCompare(b.url));

	// ── Rule 11: no canonical, on a site that publishes them ──────────────────
	//
	// Narrowed the way rule 4 was, and for the identical reason. A canonical tag
	// is optional, so a site that uses none is not defective — and firing per page
	// would produce one finding for every page of such a site, all saying the same
	// thing and none of them naming a defect. What *is* evidence is the site
	// publishing them somewhere: a template emitting a canonical on most pages and
	// not on others is an inconsistency the site itself reveals, rather than a
	// convention we prefer.
	//
	// Needs a finished crawl for the same reason the narrowing exists. The
	// evidence that the site uses canonicals is drawn from the pages we reached,
	// so a run that stopped early can be looking at exactly the half that has none.
	if (crawlComplete) {
		const declaring = canonicalCandidates.filter(
			(page) => canonicalsOf(page).length > 0,
		);

		if (declaring.length > 0) {
			for (const page of canonicalCandidates) {
				if (canonicalsOf(page).length > 0) continue;

				findings.push({
					type: FINDING_TYPES.CANONICAL_MISSING,
					url: page.url,
					detail: {
						url: page.url,
						/**
						 * The narrowing's own evidence, carried into the finding. Without
						 * it the reader is told a page lacks something optional and has no
						 * way to see why that was worth reporting.
						 */
						pagesDeclaringCanonical: declaring.length,
					},
				});
			}
		}
	}

	// ── Rule 12: canonicals that contradict each other ────────────────────────
	//
	// Two shapes under a `kind` discriminator, following rule 7's precedent: they
	// are one story to the reader — this page cannot say which URL it wants
	// indexed — and the detail says which was observed.
	//
	// One finding per page, never one per tag or per link in a chain. A template
	// emitting two canonicals emits them on every page it renders, so per-tag
	// reporting would make the worst sites the least readable.
	for (const page of canonicalCandidates) {
		const canonicals = canonicalsOf(page);
		if (canonicals.length === 0) continue;

		if (canonicals.length > 1) {
			findings.push({
				type: FINDING_TYPES.CANONICAL_CONFLICTING,
				url: page.url,
				detail: { kind: "multiple", url: page.url, canonicals },
			});
			continue;
		}

		const canonical = canonicals[0];
		if (canonical === undefined) continue;
		// A self-referential canonical is standard practice, not a chain of one.
		if (canonical === selfUrl(page)) continue;

		const target = byUrl.get(canonical);
		/**
		 * A target the crawl never fetched, or that errored, is rule 13's business.
		 * Saying it here as well would be one problem under two names — and a page
		 * that served an error has no head to have declared anything with.
		 */
		if (!target || isError(target) || !target.content.isHtml) continue;

		const onward = canonicalsOf(target);
		/**
		 * A target declaring no canonical is missing one, which rule 11 says when
		 * the site's own usage makes it worth saying. A target declaring several is
		 * contradicting itself, which this rule already reports against that page.
		 * Neither is a chain, and calling either one would file the target's defect
		 * against whichever page happened to point at it.
		 */
		if (onward.length !== 1) continue;

		const targetCanonical = onward[0];
		if (targetCanonical === undefined) continue;
		if (targetCanonical === selfUrl(target)) continue;

		/**
		 * A chain: this page names a canonical which is itself not canonical, so
		 * nothing in the sequence states where the content actually lives.
		 */
		findings.push({
			type: FINDING_TYPES.CANONICAL_CONFLICTING,
			url: page.url,
			detail: { kind: "chain", url: page.url, canonical, targetCanonical },
		});
	}

	// ── Rule 13: a canonical naming somewhere broken ──────────────────────────
	//
	// Rules 2 and 3 in a second setting, guards included: the target errored, or
	// the crawl finished without reaching an in-scope target. The reasoning that
	// shaped those two applies here unchanged — an out-of-scope target's absence
	// is the configuration working rather than the site failing, and an unreached
	// target on a truncated crawl blames the site for where we stopped.
	//
	// One type rather than two, because the fix is the same either way: the URL
	// this page nominated does not serve the content. The `kind` says which was
	// observed.
	for (const page of canonicalCandidates) {
		const canonicals = canonicalsOf(page);
		/**
		 * Only a page naming exactly one canonical. With several there is no single
		 * target to call broken, and rule 12 is already telling the reader the more
		 * useful thing — that the page has to decide where it points before
		 * anything can be said about what it points at.
		 */
		if (canonicals.length !== 1) continue;

		const canonical = canonicals[0];
		if (canonical === undefined) continue;
		if (canonical === selfUrl(page)) continue;

		const target = byUrl.get(canonical);

		if (target && isError(target)) {
			reportedBrokenTargets.add(canonical);
			findings.push({
				type: FINDING_TYPES.CANONICAL_TARGET_BROKEN,
				url: page.url,
				detail: {
					kind: "failed",
					url: page.url,
					canonical,
					httpStatus: target.httpStatus,
					fetchError: target.fetchError,
				},
			});
			continue;
		}

		if (!target && crawlComplete && inScope(canonical)) {
			findings.push({
				type: FINDING_TYPES.CANONICAL_TARGET_BROKEN,
				url: page.url,
				detail: { kind: "unreached", url: page.url, canonical },
			});
		}
	}

	// ── Rule 14: a page asking not to be indexed ──────────────────────────────
	//
	// FR-023, and the most expensive regression a client site can suffer: a
	// `noindex` shipped to production removes pages from search silently, and
	// nothing on the page looks wrong until the traffic goes.
	//
	// Read from both channels, because the directive is equally valid in markup
	// and in the `X-Robots-Tag` response header — and the header is the one a
	// human reviewer cannot see. Checking only the markup would report a page as
	// clean while it is deindexed, which is the specific failure this rule exists
	// to prevent.
	//
	// No `crawlComplete` guard: the evidence is on the page in front of us, not
	// in the shape of what we did or did not reach — the same reasoning the
	// placeholder-marker half of rule 7 carries.
	//
	// No `isHtml` guard either, and that one is deliberate rather than an
	// oversight. Serving `X-Robots-Tag` on a PDF is the header's textbook use,
	// so a rule that skipped non-HTML responses would be blind exactly where the
	// header is the *only* channel available.
	//
	// The finding makes no claim about whether this site is production. FR-023's
	// environment qualifier is not observable from a crawl; the rule reports what
	// the site asserted, and the operator who chose the start URL knows what they
	// pointed it at.
	for (const page of [...pages].sort((a, b) => a.url.localeCompare(b.url))) {
		if (isError(page)) continue;

		const declarations = [
			...page.metadata.robots.map((robots) => ({
				channel: "markup" as const,
				...robots,
			})),
			...(page.xRobotsTag === null
				? []
				: parseRobotsHeader(page.xRobotsTag).map((robots) => ({
						channel: "header" as const,
						...robots,
					}))),
		];

		const sources = declarations.flatMap((declaration) => {
			const directive = declaration.directives.find((token) =>
				NOINDEX_DIRECTIVES.has(token),
			);
			if (directive === undefined) return [];
			return [
				{
					channel: declaration.channel,
					/** Null for the generic form, which speaks to every crawler. */
					crawler: declaration.crawler,
					directive,
				},
			];
		});

		if (sources.length === 0) continue;

		const carrying = new Set(sources.map((source) => source.channel));

		/**
		 * Channels that published directives and did *not* ask for a noindex.
		 *
		 * Recorded as evidence inside the one finding rather than as a finding of
		 * its own, because a disagreement changes nothing about the outcome —
		 * either channel asserting `noindex` deindexes the page. What it explains
		 * is why nobody noticed: everyone reading the page source saw `index`.
		 */
		const indexingChannels = [
			...new Set(declarations.map((declaration) => declaration.channel)),
		]
			.filter((channel) => !carrying.has(channel))
			.sort();

		noindexed.add(page.url);
		findings.push({
			type: FINDING_TYPES.NOINDEX_PRESENT,
			url: page.url,
			detail: {
				url: page.url,
				sources,
				channels: [...carrying].sort(),
				indexingChannels,
			},
		});
	}

	// ── Rule 15: several URLs serving the same content ────────────────────────
	//
	// FR-020's content half. Rule 7 asks whether a family's *languages* were
	// translated; this asks the wider question the requirement actually poses —
	// whether the same content is published at more than one address — and it is
	// deliberately indifferent to language, because whether two URLs serve the
	// same bytes has nothing to do with what language those bytes are in.
	//
	// Exact digest equality, and no similarity metric. Two URLs serving identical
	// content is something the site did; two URLs at ninety-odd percent similarity
	// is our tokenisation, our region selection, our similarity function and our
	// threshold — four of our decisions and none of the site's. A ratio is
	// deferred for the same reason the word-count signal was deferred out of S-03,
	// and any future proposal has to state its number *and* its measured firing
	// rate against a real client crawl before it is planned.
	//
	// One finding per identical set, never per page — rule 7's shape, for rule 7's
	// reason. A CMS serving one article at four addresses is one defect.
	if (crawlComplete) {
		const byDigest = new Map<string, string[]>();

		for (const page of [...pages].sort((a, b) => a.url.localeCompare(b.url))) {
			if (isError(page)) continue;
			if (!page.content.isHtml) continue;

			/**
			 * Only pages whose content we actually isolated — and the guard matters
			 * more here than it does in rule 8.
			 *
			 * Within a family the members share a template, so a fallback summary at
			 * least carries the same navigation on both sides. Across arbitrary URLs
			 * it does not: a listing page declines isolation while an article page
			 * isolates, so comparing the two compares a `<main>` against a whole body.
			 * Any finding from that describes our extraction rather than the site.
			 */
			if (!page.content.isolated) continue;

			/**
			 * Null below the comparable-length floor, which is inherited rather than
			 * restated. Two nearly-empty pages match by accident.
			 */
			const digest = page.content.textDigest;
			if (!digest) continue;

			byDigest.set(digest, [...(byDigest.get(digest) ?? []), page.url]);
		}

		for (const [digest, sharing] of [...byDigest.entries()].sort(([a], [b]) =>
			a.localeCompare(b),
		)) {
			// One page serving its own content is a page serving its own content.
			if (sharing.length < 2) continue;

			const urls = [...sharing].sort();

			/**
			 * Already said, for this exact set. Rule 7 reached the same URLs from the
			 * family side and named the more specific defect — that a translation was
			 * never made — so repeating it here would be one problem under two
			 * headings. A set rule 7 did not report, or reported with fewer members,
			 * still belongs to this rule.
			 */
			if (identicalSetsReported.has(JSON.stringify([digest, urls]))) continue;

			/**
			 * Resolved by the site itself. Two URLs serving identical content where
			 * both name the same canonical is not a defect — it is a site telling
			 * search engines which address counts, which is the documented remedy for
			 * duplicate content. Reporting it anyway would blame a site for doing the
			 * thing this finding exists to ask for, and would repeat the redirect-alias
			 * false positive under a third name.
			 */
			const addresses = new Set(
				urls.map((url) => {
					const page = byUrl.get(url);
					if (!page) return url;
					const canonicals = canonicalsOf(page);
					return canonicals.length === 1
						? (canonicals[0] ?? selfUrl(page))
						: selfUrl(page);
				}),
			);
			if (addresses.size === 1) continue;

			findings.push({
				type: FINDING_TYPES.CONTENT_DUPLICATED,
				url: null,
				detail: {
					digest,
					/**
					 * The same on every member by definition — the digests matched — so
					 * it is read from whichever came first. Carried because "these pages
					 * are identical" reads very differently for three hundred characters
					 * than for three thousand.
					 */
					textLength: byUrl.get(urls[0] ?? "")?.content.textLength ?? 0,
					urls,
				},
			});
		}
	}

	// ── Rule 16: a link to a page that does not load ──────────────────────────
	//
	// FR-016's internal half. The crawl already fetched every in-scope link it
	// found, so the status is in hand; what was missing is the attribution — which
	// pages point at it, which is the whole of the fix.
	//
	// **One finding per broken target, never per linking page.** A dead URL in
	// site-wide navigation is linked from every page on the site, so per-page
	// reporting would turn one defect into five hundred findings and make the
	// worst sites the least readable — rule 5's argument, in the setting where it
	// bites hardest.
	//
	// No `crawlComplete` gate. This reasons from a status we observed rather than
	// from absence, so a truncated run reports less but never wrongly.
	const brokenTargets = [...linkedFrom.keys()].sort();

	for (const target of brokenTargets) {
		const page = byUrl.get(target);
		/**
		 * A link to a URL the crawl never recorded is not a broken link. It may sit
		 * beyond the page ceiling, or behind a redirect to a page already recorded
		 * under another name — and calling either one dead would report where we
		 * stopped, or our own identity rules, as the client's defect.
		 */
		if (!page || !isError(page)) continue;

		/**
		 * Already said, and said better. Rules 2, 6 and 13 each name this URL as
		 * broken with the relationship that makes it matter — a declared sibling, a
		 * diverged variant, a nominated canonical.
		 */
		if (reportedBrokenTargets.has(target)) continue;

		/**
		 * A 5xx or a network error is reported only once it has failed twice.
		 *
		 * The crawl re-requests transient failures after it drains and keeps the
		 * later observation, so a page that recovered is no longer failing here at
		 * all. What this guard covers is the case where no second look happened —
		 * an aborted crawl — where the honest reading is that the site was having a
		 * bad moment, not that it has a dead link. A 4xx needs no such treatment:
		 * it is a stable answer, and reporting it is what this product is for.
		 */
		const confirmation = reverified.find((entry) => entry.url === target);
		const transient = page.fetchError !== null || (page.httpStatus ?? 0) >= 500;
		if (transient && !confirmation?.confirmed) continue;

		findings.push({
			type: FINDING_TYPES.LINK_BROKEN,
			url: null,
			detail: {
				target,
				httpStatus: page.httpStatus,
				fetchError: page.fetchError,
				/**
				 * Whether the failure survived a second request. False for a 4xx, which
				 * was never asked twice — the flag says how the evidence was obtained,
				 * not how bad the defect is.
				 */
				confirmed: confirmation?.confirmed ?? false,
				linkedFrom: [...new Set(linkedFrom.get(target) ?? [])].sort(),
			},
		});
	}

	// ── Rule 17: a certificate that is not what it should be ──────────────────
	//
	// FR-030's transport half, and the least inferential finding in the product: a
	// certificate states its own expiry date and the chain either verifies or does
	// not. Nothing here is our standard.
	//
	// One finding per origin, naming the most severe problem observed. A
	// certificate that is both expired and self-signed is one certificate to
	// replace, and two findings would be two headings for one job.
	if (certificate) {
		const validTo = certificate.validTo ? new Date(certificate.validTo) : null;
		const daysRemaining =
			validTo && !Number.isNaN(validTo.getTime())
				? Math.floor((validTo.getTime() - Date.now()) / 86_400_000)
				: null;

		/**
		 * Node's own verdict, translated into what a reader would do about it.
		 * `ERR_TLS_CERT_ALTNAME_INVALID` is a certificate issued for a different
		 * hostname; everything else it reports at this point is the chain.
		 */
		const rejection = certificate.authorizationError;
		const expiredByClock = daysRemaining !== null && daysRemaining < 0;
		const expiredByChain = rejection === "CERT_HAS_EXPIRED";
		const mismatched = rejection === "ERR_TLS_CERT_ALTNAME_INVALID";
		const untrusted = rejection !== null && !expiredByChain && !mismatched;

		/**
		 * Thirty days, and anchored outside our own taste.
		 *
		 * Let's Encrypt issues ninety-day certificates and its clients renew at
		 * thirty days remaining, which is the renewal cadence most of the web now
		 * runs on. A certificate inside that window on an automated site has
		 * already missed a renewal it was supposed to make — so the number marks a
		 * missed event rather than a preference. The finding quotes `validTo`
		 * regardless, so a reader on a different cadence can judge for themselves.
		 */
		const expiringSoon =
			daysRemaining !== null && daysRemaining >= 0 && daysRemaining <= 30;

		const kind =
			expiredByClock || expiredByChain
				? "expired"
				: mismatched
					? "hostname_mismatch"
					: untrusted
						? "untrusted_chain"
						: expiringSoon
							? "expiring_soon"
							: null;

		if (kind !== null) {
			findings.push({
				type: FINDING_TYPES.CERTIFICATE_PROBLEM,
				url: null,
				detail: {
					kind,
					origin: certificate.origin,
					validTo: certificate.validTo,
					daysRemaining,
					issuer: certificate.issuer,
					subject: certificate.subject,
					authorizationError: rejection,
				},
			});
		}
	}

	// ── Rule 18: a security header the site contradicts itself about ──────────
	//
	// FR-030's header half, and the shape of it is the whole decision. **A header
	// the site never sends is not reported.** "Every page should carry a Content
	// Security Policy" is our standard, not the site's assertion, and a rule
	// resting on it would be the fifth entry in `lessons.md` rather than a finding
	// about anybody's site.
	//
	// What is reportable is the site disagreeing with itself, in two ways.
	//
	// `malformed` — a header present with a value that cannot mean what it says.
	// Each check below is anchored in the header's own specification, not in a
	// preference: `Strict-Transport-Security` has exactly one required directive,
	// and `X-Content-Type-Options` has exactly one defined value.
	//
	// `inconsistent` — published on some pages and omitted on others. This is
	// rule 11's narrowing applied to a second optional thing: the site using the
	// header *somewhere* is what makes its absence elsewhere evidence rather than
	// a preference of ours. It catches the real defect in this area — a template
	// or edge rule that covers most routes and misses a few.
	const headerPages = [...pages]
		.filter((page) => !isError(page))
		.sort((a, b) => a.url.localeCompare(b.url));

	/** Names in the order the crawler collects them, so output is stable. */
	const headerNames = [
		...new Set(
			headerPages.flatMap((page) => Object.keys(page.securityHeaders)),
		),
	].sort();

	for (const header of headerNames) {
		const malformed: Array<{ url: string; value: string }> = [];

		for (const page of headerPages) {
			const value = page.securityHeaders[header];
			if (value === undefined) continue;

			const trimmed = value.trim();
			const invalid =
				trimmed === "" ||
				(header === "strict-transport-security" &&
					!/(^|[;\s])max-age\s*=\s*\d+/i.test(trimmed)) ||
				(header === "x-content-type-options" &&
					trimmed.toLowerCase() !== "nosniff");

			if (invalid) malformed.push({ url: page.url, value });
		}

		if (malformed.length > 0) {
			findings.push({
				type: FINDING_TYPES.SECURITY_HEADER_CONTRADICTION,
				url: null,
				detail: {
					kind: "malformed",
					header,
					/** The value as published, so the reader can see what is wrong. */
					value: malformed[0]?.value ?? "",
					affectedUrls: malformed.map((entry) => entry.url).sort(),
				},
			});
		}
	}

	/**
	 * Only on a crawl that finished.
	 *
	 * This half reasons from absence — the pages that did *not* carry the header —
	 * and a truncated run can hold exactly the subset that omits it. That is the
	 * guard written after a ceiling was reported as eighteen defects on a live
	 * client site.
	 */
	if (crawlComplete) {
		for (const header of headerNames) {
			const publishing = headerPages.filter(
				(page) => page.securityHeaders[header] !== undefined,
			);
			const omitting = headerPages.filter(
				(page) => page.securityHeaders[header] === undefined,
			);

			// Agreement, either way, is not a contradiction.
			if (publishing.length === 0 || omitting.length === 0) continue;

			findings.push({
				type: FINDING_TYPES.SECURITY_HEADER_CONTRADICTION,
				url: null,
				detail: {
					kind: "inconsistent",
					header,
					/**
					 * The narrowing's own evidence, carried into the finding — the same
					 * reason rule 11 carries `pagesDeclaringCanonical`. Without it the
					 * reader is told a page lacks something optional and cannot see why
					 * that was worth reporting.
					 */
					pagesPublishing: publishing.length,
					affectedUrls: omitting.map((page) => page.url).sort(),
				},
			});
		}
	}

	// ── Rules 19, 20 and 21: what the site submitted, and what it blocks ──────
	//
	// FR-017 and FR-018, sharing one input. All three read the sitemap, and the
	// third reads robots.txt beside it.
	//
	// The comparison itself lives in `sitemap.ts` rather than here, because every
	// trap in it is a URL-identity trap and doing it once, where it can be tested
	// on its own, is worth more than doing it three times inline.
	if (sitemap) {
		/**
		 * The crawl's origin, taken from the pages themselves.
		 *
		 * A sitemap may legitimately live on another host — a CDN, commonly — so
		 * the origin that matters is the one the crawl walked, not the one the
		 * sitemap was served from.
		 */
		const crawlOrigin = (() => {
			const first = pages[0]?.url;
			if (first === undefined) return null;
			try {
				return new URL(first).origin;
			} catch {
				return null;
			}
		})();

		if (crawlOrigin !== null) {
			const reconciled = reconcile(sitemap.entries, crawlOrigin, inScope);
			const source = sitemap.sources[0] ?? null;

			// ── Rule 19: a sitemap entry that does not load ───────────────────────
			//
			// FR-017's first direction, and narrower than it looks. It reports only
			// entries the crawl **recorded with a failure**, never entries merely
			// absent from the crawl — and that distinction is the whole rule.
			//
			// The crawl records the URL the server *served* and discards a response
			// that redirects to a page already recorded. So a sitemap URL that 301s
			// to its canonical address was fetched successfully, is perfectly
			// healthy, and never appears under its own name. Deriving failure from
			// absence would report the site's own tidy redirects as broken sitemap
			// entries — the redirect-alias false positive re-emerging in a third
			// setting, which is exactly what `context/foundation/lessons.md` was
			// written after.
			//
			// One finding for the whole sitemap rather than one per entry: a
			// sitemap generated from a stale index breaks in bulk, and per-entry
			// reporting would make the worst case the least readable.
			if (crawlComplete) {
				const failed: Array<Record<string, unknown>> = [];

				for (const [url, entries] of [...reconciled.comparable].sort(
					([a], [b]) => a.localeCompare(b),
				)) {
					const page = byUrl.get(url);
					if (!page || !isError(page)) continue;

					failed.push({
						raw: entries[0]?.raw ?? url,
						normalised: url,
						httpStatus: page.httpStatus,
						fetchError: page.fetchError,
					});
				}

				if (failed.length > 0) {
					findings.push({
						type: FINDING_TYPES.SITEMAP_URL_FAILED,
						url: null,
						detail: {
							sitemapSource: source,
							discovery: sitemap.discovery,
							entries: failed,
						},
					});
				}
			}

			// ── Rule 20: a live page the sitemap does not list ────────────────────
			//
			// FR-017's second direction, and it rests on firmer ground than almost
			// anything else in this file: the sitemap's completeness is the site's
			// own assertion, and the other half is a *positive* observation — we
			// fetched this page and it returned 200.
			//
			// **No `crawlComplete` gate**, and that is deliberate rather than an
			// oversight. Truncating the crawl can only make this rule quieter, never
			// wrong: a page we never fetched is simply not among the pages we are
			// asking about. Every other absence-reasoning rule here needs the gate
			// because absence is its evidence; here presence is.
			//
			// The exclusions are what keep it honest. A sitemap is *correct* to omit
			// a page that errored, a page that asked not to be indexed, and a page
			// whose canonical names a different address — in each case the site has
			// already said this URL is not the one it wants indexed.
			const omitted: string[] = [];

			for (const page of [...pages].sort((a, b) =>
				a.url.localeCompare(b.url),
			)) {
				if (isError(page)) continue;
				if (!page.content.isHtml) continue;
				if (!inScope(page.url)) continue;
				if (reconciled.comparable.has(page.url)) continue;

				// The site said not to index it; leaving it out is consistent.
				if (noindexed.has(page.url)) continue;

				/**
				 * The site nominated a different address for this content, so the
				 * sitemap listing that address instead is the site agreeing with
				 * itself. A self-referential canonical is not this case.
				 */
				const canonicals = canonicalsOf(page);
				const canonical = canonicals.length === 1 ? canonicals[0] : undefined;
				if (canonical !== undefined && canonical !== selfUrl(page)) continue;

				omitted.push(page.url);
			}

			if (omitted.length > 0) {
				findings.push({
					type: FINDING_TYPES.PAGE_MISSING_FROM_SITEMAP,
					url: null,
					detail: {
						sitemapSource: source,
						discovery: sitemap.discovery,
						/**
						 * The corpus-level fact carried into the finding, the way rule 11
						 * carries `pagesDeclaringCanonical`. Without it the reader is told
						 * some pages are absent from a list and cannot see how long the
						 * list was.
						 */
						sitemapEntryCount: reconciled.comparable.size,
						urls: omitted,
					},
				});
			}

			// ── Rule 21: robots.txt blocks a page the sitemap submits ─────────────
			//
			// FR-018, formulated as a contradiction rather than as an intent.
			//
			// "Pages intended to be indexable" is a claim about a human's mental
			// state, and nothing observable is intent. What *is* observable is the
			// site asserting two opposing things on the same host: its sitemap
			// submits this URL for indexing, and its robots.txt tells crawlers not
			// to fetch it. The finding can be stated entirely in quotation — the
			// loc, the verbatim `Disallow` line, its line number, and the group it
			// sits in.
			//
			// **Not internal links.** "Blocked but linked from N pages" would fire
			// on `/search`, `/cart`, `/login`, faceted navigation and print views —
			// the canonical *correct* uses of `Disallow` — and `page.links` is
			// already in hand, which makes it the tempting formulation. It is
			// rejected in writing rather than by omission.
			//
			// **Evaluated as googlebot, falling back to `*`.** This reads backwards
			// at first: we send no distinct user-agent, so on paper our group is the
			// wildcard. But the finding is a claim about the site's instruction to
			// *search engines*, and Googlebot ignores `*` entirely once a
			// `googlebot` group exists — so a site with a permissive wildcard and a
			// blocking googlebot group is catastrophically blocked in the way that
			// matters, and evaluating the wildcard would report nothing. The group
			// travels in the detail so the reader sees which audience was addressed.
			//
			// **No `crawlComplete` gate.** This rule reads sitemap ⋈ robots.txt and
			// does not consult the crawl at all, so it survives a truncated or
			// aborted run intact. It also depends on the crawler continuing not to
			// obey robots.txt — not for its own evidence, which is documentary, but
			// because a crawl that skipped blocked pages would make the rest of this
			// slice blind to them.
			if (robots) {
				const byRule = new Map<
					string,
					{ rule: RobotsRule; group: string; urls: string[] }
				>();

				/**
				 * Every same-origin entry, in scope or not — the one rule here that
				 * ignores the crawl's configured scope, deliberately.
				 *
				 * Elsewhere `inScope` suppresses a finding because the evidence would
				 * be an *absence* the configuration caused. Nothing is absent here:
				 * both facts are published, in two files, by the same site. An
				 * operator excluding `/private` from a crawl has said where to spend
				 * requests, not that the site may contradict itself there unwatched —
				 * and a section excluded from crawling is exactly where a
				 * sitemap/robots contradiction is least likely to be noticed by hand.
				 */
				const published = [
					...reconciled.comparable.keys(),
					...reconciled.outOfScope.flatMap((entry) =>
						entry.url === null ? [] : [entry.url],
					),
				];

				for (const url of [...new Set(published)].sort()) {
					let path: string;
					try {
						path = new URL(url).pathname;
					} catch {
						continue;
					}

					const verdict = evaluatePath(robots, path, "googlebot");
					if (verdict.allowed || verdict.rule === null) continue;

					const key = `${verdict.group ?? "*"} ${verdict.rule.lineNumber}`;
					const entry = byRule.get(key) ?? {
						rule: verdict.rule,
						group: verdict.group ?? "*",
						urls: [],
					};
					entry.urls.push(url);
					byRule.set(key, entry);
				}

				/**
				 * One finding per blocking rule, not per URL.
				 *
				 * FR-018 asks which robots.txt *rules* block pages — the rule is the
				 * subject and the pages are the evidence — and the shape matters
				 * practically as well: a single `Disallow: /` matching four hundred
				 * sitemap URLs is one line to fix, not four hundred findings.
				 */
				for (const [, entry] of [...byRule].sort(([a], [b]) =>
					a.localeCompare(b),
				)) {
					findings.push({
						type: FINDING_TYPES.ROBOTS_BLOCKS_INDEXABLE,
						url: null,
						detail: {
							rule: entry.rule.pattern,
							ruleLine: entry.rule.line,
							ruleLineNumber: entry.rule.lineNumber,
							userAgentGroup: entry.group,
							sitemapSource: source,
							discovery: sitemap.discovery,
							urls: [...entry.urls].sort(),
						},
					});
				}
			}

			// ── Rule 22: a page the sitemap submits that nothing links to ─────────
			//
			// FR-019. By the requirement's own wording an orphan is "reachable via
			// sitemap but linked from nowhere", so both channels are load-bearing:
			// the sitemap is the site asserting the page matters, and the link graph
			// is the site never pointing at it. Either alone says nothing — a page
			// absent from the sitemap and unlinked is simply not published, and a
			// page in the sitemap that is linked is ordinary.
			//
			// **Gated on `crawlComplete`**, because this reasons from absence: a
			// truncated run has not seen the pages that might link here. That guard
			// exists because a run stopping at its ceiling once reported the ceiling
			// as eighteen defects on a live client site, naming URLs that all
			// returned 200.
			//
			// **And gated on having looked where a link would be.** `crawlComplete`
			// says the run was not cut short; it does not say the run looked at the
			// site. A project whose start URL is a leaf — one blog post, one section
			// page — finishes in a single page having visited nothing that could
			// have linked anywhere, and every other URL in the sitemap then looks
			// unlinked. That is a fact about where we started, and it once produced
			// forty-four defects invented by our own entry point.
			//
			// So a URL is only called an orphan when the crawl recorded a page that
			// would be expected to link to it: its section index, or any ancestor up
			// to the site root. "We looked at `/news-press` and it does not point at
			// this article" is evidence; "we looked at one unrelated page" is not.
			// The test is per URL rather than a share of the sitemap, because
			// coverage of the sitemap is the wrong denominator — a site can be
			// mostly orphaned, and a rule that went quiet in proportion would go
			// quiet exactly when it mattered most. It also needs no threshold, which
			// is what `lessons.md` asks of any inference we make ourselves.
			//
			// **And gated on the project not having narrowed the crawl.** The third
			// version of the same mistake, found the same way as the first two. A
			// project scoped to a handful of paths was told not to visit the rest of
			// the site, so the pages that would link to anything outside that scope
			// were never fetched — and the rule read their absence as the site
			// linking nowhere. On a client project scoped to `/, /company` it
			// reported both company pages as orphans, on the strength of a crawl
			// instructed not to look anywhere they might be linked from.
			//
			// The ancestor test does not catch it: the site root is an ancestor of
			// everything and is almost always in scope, so it passes while the pages
			// that actually carry the links sit outside. Silence is the only honest
			// answer, and it is the same trade `crawlComplete` already makes.
			const recordedAncestor = (url: string): boolean => {
				let parsed: URL;
				try {
					parsed = new URL(url);
				} catch {
					return false;
				}

				const segments = parsed.pathname.split("/").filter(Boolean);
				for (let depth = segments.length - 1; depth >= 0; depth -= 1) {
					const path =
						depth === 0 ? "" : `/${segments.slice(0, depth).join("/")}`;
					/**
					 * Both spellings of the same page. `normaliseUrl` drops a trailing
					 * slash, but a root recorded as `https://site/` and one recorded as
					 * `https://site` are the same front door, and looking up only one of
					 * them would decide this by punctuation.
					 */
					for (const ancestor of [
						`${parsed.origin}${path}`,
						`${parsed.origin}${path}/`,
					]) {
						const page = byUrl.get(ancestor);
						if (page && !isError(page)) return true;
					}
				}
				return false;
			};

			if (crawlComplete && !scopeNarrowed) {
				const orphans: string[] = [];
				const everRequested = new Set(requested);

				for (const url of [...reconciled.comparable.keys()].sort()) {
					/**
					 * The entry page is reachable by definition and has no inbound link
					 * by construction — that is what makes it the entry. Reporting it
					 * would be a finding about where we chose to start.
					 */
					if (url === entryUrl) continue;

					/**
					 * Nothing was looked at that would have carried a link here, so
					 * there is no absence to reason from.
					 */
					if (!recordedAncestor(url)) continue;

					const page = byUrl.get(url);

					/**
					 * The common orphan, and the one a link-following crawl can only see
					 * by its absence: the sitemap submits this URL and nothing on the
					 * site ever pointed at it, so the frontier never held it.
					 *
					 * Read from the requested set rather than from `pages`, because a
					 * URL that redirected to an already-recorded page *was* linked to —
					 * it is simply recorded under the name the server served. Judging by
					 * `pages` alone would report the site's own redirects as orphans,
					 * which is the alias false positive under yet another name.
					 */
					if (!everRequested.has(url)) {
						orphans.push(url);
						continue;
					}

					/**
					 * The rarer orphan: reached, but only because a sibling's hreflang
					 * declared it. No page links to it, which is what the requirement
					 * asks about — the crawl found it through a channel a reader never
					 * uses.
					 */
					if (!page || isError(page)) continue;
					if ((linkedFrom.get(url) ?? []).length > 0) continue;

					orphans.push(url);
				}

				if (orphans.length > 0) {
					findings.push({
						type: FINDING_TYPES.PAGE_ORPHANED,
						url: null,
						detail: {
							sitemapSource: source,
							discovery: sitemap.discovery,
							urls: orphans,
						},
					});
				}
			}
		}
	}

	// ── Rule 23: a link leaving the site whose target is gone ─────────────────
	//
	// FR-016's external half, and it reports far less than the sweep observed —
	// deliberately.
	//
	// **Only `404` and `410`, or a network error confirmed twice.** Those are the
	// host saying the resource does not exist, which is a fact about the link. A
	// `401`, `403` or `429` is the host saying *we* may not have it, which is a
	// fact about being an automated client — and filing that as a defect on the
	// client's site would report someone else's access policy as their broken
	// link. A `5xx` is excluded for a third reason: a link to a site that is
	// briefly down is not a broken link.
	//
	// That narrowing matters more here than anywhere else in this file, because
	// bot-hostile hosts are common and there is still no way to suppress a finding
	// once it is reported. A rule that called every `403` a dead link would put
	// permanent noise in every future run.
	//
	// One finding per dead target, listing the pages that link to it, matching
	// rule 16's shape for rule 16's reason.
	if (external.complete) {
		/**
		 * Which pages link to each URL the sweep checked.
		 *
		 * Keyed off the sweep's own list rather than recomputed from `inScope`,
		 * which here is the run's path-prefix closure and knows nothing about
		 * origins — asking it whether a link is external would get the wrong answer
		 * for every off-origin URL whose path happens not to be excluded. The sweep
		 * already decided what was external; this only needs to say who pointed at
		 * it.
		 */
		const swept = new Set(external.checked.map((check) => check.url));
		const linkedFromExternal = new Map<string, string[]>();
		for (const page of pages) {
			for (const link of page.links) {
				if (!swept.has(link)) continue;
				linkedFromExternal.set(link, [
					...(linkedFromExternal.get(link) ?? []),
					page.url,
				]);
			}
		}

		for (const check of [...external.checked].sort((a, b) =>
			a.url.localeCompare(b.url),
		)) {
			if (!isGone(check)) continue;

			findings.push({
				type: FINDING_TYPES.LINK_EXTERNAL_BROKEN,
				url: null,
				detail: {
					target: check.url,
					httpStatus: check.httpStatus,
					fetchError: check.fetchError,
					confirmed: check.confirmed,
					linkedFrom: [
						...new Set(linkedFromExternal.get(check.url) ?? []),
					].sort(),
				},
			});
		}
	}

	// ── Rule 24: a redirect that goes round, or goes too far ──────────────────
	//
	// FR-016's remainder. Until this slice a redirect was not expressible at all:
	// the runtime followed the hops and returned the last response, so no page in
	// any run carried a 3xx and a chain left no trace.
	//
	// **One hop is not a finding.** A single redirect is ordinary site behaviour —
	// canonicalising `www.`, forcing https, tidying a moved page — and reporting it
	// would fire on nearly every site, which is the noise failure the PRD calls
	// fatal. Two hops is where a reader has something to fix: each one costs a
	// round trip, and search engines discount them.
	//
	// **A chain that exists only because of our own normalisation is not a
	// finding.** `normaliseUrl` drops the query string and the trailing slash, so a
	// `/path` → `/path/` hop is our identity definition meeting the site's rather
	// than a defect of theirs. That is the trap which produced the recorded
	// alias false positive, arriving here under a third name.
	//
	// No `crawlComplete` gate: every hop was observed, not inferred from absence.
	/**
	 * Every route walked, from both places a chain can end up.
	 *
	 * A route ending at a URL the crawl already recorded is discarded whole, hop
	 * list included, and that is the commonest shape a real chain takes: an old
	 * URL pointing at a new one the navigation also links. Reading `pages` alone
	 * would miss most of them, and reading the aliases alone would miss every
	 * loop — a loop lands nowhere, so it is never an alias of anything. Keyed by
	 * where the route was entered, since a recorded page and its own alias are
	 * two records of one walk.
	 */
	const routes = new Map<string, { chain: Hop[]; landed: string | null }>();
	for (const page of pages) {
		const entry = page.redirectChain[0]?.url;
		if (entry === undefined) continue;
		routes.set(entry, { chain: page.redirectChain, landed: page.url });
	}
	for (const alias of aliases) {
		const entry = alias.chain[0]?.url;
		if (entry === undefined || routes.has(entry)) continue;
		routes.set(entry, { chain: alias.chain, landed: alias.served });
	}

	for (const [entry, route] of [...routes].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		/**
		 * A loop is the last hop pointing back at somewhere the chain has already
		 * been — not at the page we landed on, which is simply how a chain ends.
		 * Conflating the two called every ordinary chain a loop.
		 */
		const visited = route.chain.map((hop) => hop.url);
		const last = route.chain.at(-1);
		const loops = last?.location != null && visited.includes(last.location);

		/**
		 * Hops that changed something the site controls.
		 *
		 * A hop whose destination differs from its source only in the parts
		 * `normaliseUrl` already collapses is invisible to every other comparison in
		 * this product, and counting it here would report our own rules as the
		 * client's chain.
		 */
		const substantive = route.chain.filter(
			(hop) => hop.location !== null && hop.location !== hop.url,
		);

		if (!loops && substantive.length < 2) continue;

		findings.push({
			type: FINDING_TYPES.REDIRECT_CHAIN,
			url: null,
			detail: {
				kind: loops ? "loop" : "chain",
				/** Where the chain was entered, which is the URL to correct. */
				from: entry,
				/** Where it ended up; null on a loop, which ends nowhere. */
				to: loops ? null : route.landed,
				hops: route.chain.map((hop) => ({
					url: hop.url,
					status: hop.status,
					location: hop.location,
				})),
				/**
				 * The pages still pointing at the stale URL, which is where the fix
				 * is made. Deleting the redirect is the site owner's other option and
				 * often not theirs to take; editing their own links always is.
				 */
				linkedFrom: [...(linkedFrom.get(entry) ?? [])].sort(),
			},
		});
	}

	// ── Rule 25: images the page reserves no space for ────────────────────────
	//
	// FR-029's cheapest signal and entirely the site's own markup: an `img` that
	// declares neither a width nor a height gives the browser nothing to reserve,
	// so everything below it moves when the image arrives. The attributes are the
	// page's own statement about its layout, so their absence is too.
	//
	// Both attributes, never either: a width alone reserves no space, because the
	// height is what pushes the rest of the document down.
	//
	// One finding per page rather than one per image, following rule 9: a
	// template that forgot the attributes forgot them everywhere, and a page with
	// forty images would otherwise fill the list on its own.
	for (const page of [...pages].sort((a, b) => a.url.localeCompare(b.url))) {
		if (isError(page)) continue;
		/**
		 * Null is silence. A page crawled before images were observed, or one that
		 * never returned HTML, has no answer — and the honest handling of "we did
		 * not look" is to say nothing rather than to report a clean page.
		 */
		if (!page.images) continue;
		/**
		 * A PDF or a feed contains no images in this sense and never should.
		 * Rule 9 declines on the same grounds, and for the same reason: the format
		 * a URL serves is not something the site got wrong.
		 */
		if (!page.content.isHtml) continue;
		if (page.images.undimensioned === 0) continue;

		findings.push({
			type: FINDING_TYPES.IMAGE_MISSING_DIMENSIONS,
			url: page.url,
			detail: {
				url: page.url,
				count: page.images.undimensioned,
				of: page.images.total,
				/** Capped at capture; the count above is the exact number. */
				images: page.images.undimensionedUrls,
				listed: page.images.undimensionedUrls.length,
			},
		});
	}

	// ── Rule 26: images offered in no modern format ───────────────────────────
	//
	// The second half of FR-029 that needs no request. Judged only on URLs whose
	// extension names a raster format the site chose: an `svg` has no modern
	// replacement, an extensionless CDN URL may well be negotiating one by
	// content type, and calling either legacy would be a finding about our guess.
	//
	// A `picture` offering a modern `source` exempts its own `img` fallback.
	// That fallback is the site being careful about old browsers, and reporting it
	// would punish exactly the markup the rule wants to see.
	for (const page of [...pages].sort((a, b) => a.url.localeCompare(b.url))) {
		if (isError(page)) continue;
		if (!page.images) continue;
		if (!page.content.isHtml) continue;
		if (page.images.legacy === 0) continue;

		findings.push({
			type: FINDING_TYPES.IMAGE_LEGACY_FORMAT,
			url: page.url,
			detail: {
				url: page.url,
				count: page.images.legacy,
				of: page.images.total,
				images: page.images.legacyUrls,
				listed: page.images.legacyUrls.length,
			},
		});
	}

	return findings;
}
