import { BLOCK_NAMES, type ContentSummary } from "./content";
import type { CrawledPage } from "./crawler";
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
	const { pages, expectedLocales, inScope, crawlComplete } = options;

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

			for (const [, sharing] of [...byDigest.entries()].sort(([a], [b]) =>
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

				findings.push({
					type: FINDING_TYPES.CONTENT_UNTRANSLATED,
					url: null,
					detail: {
						kind: "identical_to_siblings",
						groupKey: family.groupKey,
						urls: sharing.map((m) => m.url).sort(),
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
	// Only on a crawl that finished. The finding's substance is a list of every
	// page carrying the string, and a truncated run can hold one member of a
	// pair and not the other — so the list would describe where we stopped
	// rather than what the site publishes.
	if (crawlComplete) {
		const byValue = new Map<
			string,
			{ field: string; language: string; value: string; urls: string[] }
		>();

		for (const page of [...pages].sort((a, b) => a.url.localeCompare(b.url))) {
			if (isError(page)) continue;

			/**
			 * A page whose language nothing established cannot be said to duplicate
			 * another *in that language* — there is no language to have shared. The
			 * same refusal rule 7 makes, and for the same reason: comparing them
			 * anyway would be a claim about our guess rather than about the site.
			 */
			const locale = variants.get(page.url)?.locale;
			if (!locale) continue;
			const language = locale.split(/[-_]/)[0] ?? locale;

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

	return findings;
}
