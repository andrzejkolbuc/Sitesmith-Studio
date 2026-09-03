import { describe, expect, it } from "vitest";

import {
	type CorrelatableFinding,
	type CorrelatablePage,
	correlate,
} from "./correlate";

/**
 * Shapes the correlation rule has to get right, and the ones it has to refuse.
 *
 * Written in the register of `site-shapes.test.ts`: the expectation comes first
 * and from outside the implementation, because an expectation adjusted to match
 * the output is just the output written twice. The shapes that matter are the
 * ones that could produce a *wrong* grouping — a rule that folds too much is
 * worse than one that folds nothing, since it tells a client one edit will fix
 * twenty things.
 *
 * The site below is the shape of the real one the rule was designed against: a
 * page in ten languages, the members of each family declared siblings by the
 * site's own hreflang tags.
 */

const B = "https://shop.test";

/** A family whose members the site declares to be each other's translations. */
function family(slug: string, locales: string[]): CorrelatablePage[] {
	const key = `${B}/${locales[0]}/${slug}`;
	return locales.map((locale) => ({
		url: `${B}/${locale}/${slug}`,
		variantGroupKey: key,
	}));
}

/** A page the site never declared a sibling for: its own family of one. */
function single(path: string): CorrelatablePage {
	return { url: `${B}${path}`, variantGroupKey: `${B}${path}` };
}

const LOCALES = ["en", "de", "fr"];

function brokenLink(
	id: string,
	target: string,
	linkedFrom: string[],
): CorrelatableFinding {
	return {
		id,
		type: "link_broken",
		detail: { target, httpStatus: 404, confirmed: false, linkedFrom },
	};
}

describe("correlating findings that share a cause", () => {
	it("folds many dead links emitted by one variant family into one problem", () => {
		/**
		 * The shape the rule exists for. A language switcher on two pages of one
		 * family builds sibling URLs from the wrong slug, so every language gets a
		 * dead link — twenty findings, one template, one edit.
		 */
		const pages = family("careers", LOCALES);
		const emitters = [`${B}/en/careers`, `${B}/de/careers`];

		const findings = LOCALES.flatMap((locale, i) => [
			brokenLink(`l${i}a`, `${B}/${locale}/karriere`, [emitters[0] as string]),
			brokenLink(`l${i}b`, `${B}/${locale}/carrieres`, [emitters[1] as string]),
		]);

		const { problems, remainder } = correlate(findings, pages);

		expect(problems).toHaveLength(1);
		expect(problems[0]?.shape).toBe("one-family");
		expect(problems[0]?.findings).toHaveLength(6);
		/**
		 * Sorted, not in the order the emitters were declared — two runs over the
		 * same site have to render the same list. This expectation was written the
		 * other way round first and was wrong about the rule rather than the rule
		 * being wrong about the site.
		 */
		expect(problems[0]?.originPages).toEqual([...emitters].sort());
		expect(remainder).toEqual([]);
	});

	it("folds two different check types that one family emits", () => {
		/**
		 * FR-040's actual claim: findings of *different* kinds reported as one
		 * problem. The dead links and the diverged variant are the same fault seen
		 * from two ends, and the site is what says the pages emitting them are one
		 * page in two languages.
		 */
		const pages = family("careers", LOCALES);
		const emitters = [`${B}/en/careers`, `${B}/de/careers`];

		const findings: CorrelatableFinding[] = [
			brokenLink("l1", `${B}/fr/karriere`, [emitters[0] as string]),
			brokenLink("l2", `${B}/fr/carrieres`, [emitters[1] as string]),
			{
				id: "v1",
				type: "variant_diverged",
				detail: {
					locale: "fr",
					brokenUrl: `${B}/fr/karriere`,
					declaredBy: emitters,
				},
			},
		];

		const { problems } = correlate(findings, pages);

		expect(problems).toHaveLength(1);
		expect(new Set(problems[0]?.findings.map((f) => f.type))).toEqual(
			new Set(["link_broken", "variant_diverged"]),
		);
	});

	it("folds findings whose origins occupy the same set of families", () => {
		/**
		 * The duplicated-metadata shape: the same handful of pages carry the same
		 * title in every language, so the finding repeats once per language over the
		 * corresponding members of the same families.
		 */
		const legal = family("legal", LOCALES);
		const privacy = family("privacy", LOCALES);

		const findings: CorrelatableFinding[] = LOCALES.map((locale) => ({
			id: `m-${locale}`,
			type: "metadata_duplicated",
			detail: {
				field: "title",
				language: locale,
				value: "Legal",
				urls: [`${B}/${locale}/legal`, `${B}/${locale}/privacy`],
			},
		}));

		const { problems } = correlate(findings, [...legal, ...privacy]);

		expect(problems).toHaveLength(1);
		expect(problems[0]?.shape).toBe("family-set");
		expect(problems[0]?.families).toHaveLength(2);
		expect(problems[0]?.findings).toHaveLength(3);
	});

	it("names every origin page, not only the first finding's", () => {
		/**
		 * The reader is being told where to go. Two findings sharing a family set
		 * while naming different members of it must hand over both sets of pages, or
		 * half the work is invisible.
		 */
		const pages = family("legal", LOCALES);

		const findings: CorrelatableFinding[] = [
			{
				id: "a",
				type: "metadata_duplicated",
				detail: { urls: [`${B}/en/legal`] },
			},
			{
				id: "b",
				type: "metadata_duplicated",
				detail: { urls: [`${B}/de/legal`] },
			},
		];

		const { problems } = correlate(findings, pages);

		expect(problems[0]?.originPages).toEqual([
			`${B}/de/legal`,
			`${B}/en/legal`,
		]);
	});
});

describe("correlations the rule must refuse", () => {
	it("never folds an external link failure in with an internal one", () => {
		/**
		 * The measured false correlation, and the reason for the guard. Two dead
		 * internal test pages and one dead partner link sat in the same site-wide
		 * footer on the real run. They share a layout, which is a location, not a
		 * cause: a third party deleting a page is not an edit the site's owner can
		 * make.
		 */
		const nav = [single("/"), single("/about"), single("/contact")];
		const everywhere = nav.map((p) => p.url);

		const findings: CorrelatableFinding[] = [
			brokenLink("d1", `${B}/dev/test-page`, everywhere),
			brokenLink("d2", `${B}/dev/other-test`, everywhere),
			{
				id: "x1",
				type: "link_external_broken",
				detail: {
					target: "https://partner.example/global",
					httpStatus: 410,
					confirmed: true,
					linkedFrom: everywhere,
				},
			},
		];

		const { problems, remainder } = correlate(findings, nav);

		expect(problems).toHaveLength(1);
		expect(problems[0]?.findings.map((f) => f.id)).toEqual(["d1", "d2"]);
		expect(remainder.map((f) => f.id)).toEqual(["x1"]);
	});

	it("never correlates a finding that speaks about the corpus", () => {
		/**
		 * A sitemap reconciliation and an orphan list have no page that emits them.
		 * They are already one finding per cause, and folding them into anything
		 * would be asserting a relationship between two rules rather than between
		 * two pieces of evidence.
		 */
		const pages = family("legal", LOCALES);

		const findings: CorrelatableFinding[] = [
			{
				id: "s1",
				type: "page_missing_from_sitemap",
				detail: { urls: pages.map((p) => p.url) },
			},
			{
				id: "o1",
				type: "page_orphaned",
				detail: { urls: pages.map((p) => p.url) },
			},
			{
				id: "c1",
				type: "certificate_problem",
				detail: { kind: "expiring", origin: B },
			},
		];

		const { problems, remainder } = correlate(findings, pages);

		expect(problems).toEqual([]);
		expect(remainder.map((f) => f.id)).toEqual(["s1", "o1", "c1"]);
	});

	it("splits findings whose family sets differ by one family", () => {
		/**
		 * Set equality, not similarity. Two findings over four of five shared
		 * families are not the same problem, and any rule that said they were would
		 * need a number to say how close is close enough.
		 */
		const legal = family("legal", LOCALES);
		const privacy = family("privacy", LOCALES);
		const terms = family("terms", LOCALES);

		const findings: CorrelatableFinding[] = [
			{
				id: "a",
				type: "metadata_duplicated",
				detail: { urls: [`${B}/en/legal`, `${B}/en/privacy`] },
			},
			{
				id: "b",
				type: "metadata_duplicated",
				detail: { urls: [`${B}/de/legal`, `${B}/de/terms`] },
			},
		];

		const { problems, remainder } = correlate(findings, [
			...legal,
			...privacy,
			...terms,
		]);

		expect(problems).toEqual([]);
		expect(remainder).toHaveLength(2);
	});

	it("does not make a problem out of a single finding", () => {
		const pages = family("legal", LOCALES);

		const { problems, remainder } = correlate(
			[
				{
					id: "only",
					type: "metadata_duplicated",
					detail: { urls: [`${B}/en/legal`] },
				},
			],
			pages,
		);

		expect(problems).toEqual([]);
		expect(remainder.map((f) => f.id)).toEqual(["only"]);
	});
});

describe("what the rule does on a site that declares no siblings", () => {
	it("correlates only findings emitted by exactly the same pages", () => {
		/**
		 * The stated limit, asserted rather than assumed. On a monolingual site
		 * every page is its own family, so an equal family set means an equal page
		 * set — the rule goes quiet rather than guessing, and what it still catches
		 * is a shared template, which was observed rather than inferred.
		 */
		const nav = [single("/"), single("/about")];
		const everywhere = nav.map((p) => p.url);

		const findings: CorrelatableFinding[] = [
			brokenLink("a", `${B}/gone-one`, everywhere),
			brokenLink("b", `${B}/gone-two`, everywhere),
			brokenLink("c", `${B}/gone-three`, [`${B}/`]),
		];

		const { problems, remainder } = correlate(findings, nav);

		expect(problems).toHaveLength(1);
		expect(problems[0]?.findings.map((f) => f.id)).toEqual(["a", "b"]);
		expect(remainder.map((f) => f.id)).toEqual(["c"]);
	});

	it("falls back to the exact origin set when a page has no family recorded", () => {
		/**
		 * A family set built from only the origin pages we could place is a guess
		 * about the ones we could not. Dropping to an identical-origin requirement
		 * asserts nothing beyond what was observed.
		 */
		const pages: CorrelatablePage[] = [
			{ url: `${B}/en/legal`, variantGroupKey: `${B}/en/legal` },
			{ url: `${B}/en/privacy`, variantGroupKey: null },
		];

		const { problems } = correlate(
			[
				brokenLink("a", `${B}/gone-one`, [`${B}/en/legal`, `${B}/en/privacy`]),
				brokenLink("b", `${B}/gone-two`, [`${B}/en/legal`, `${B}/en/privacy`]),
			],
			pages,
		);

		expect(problems).toHaveLength(1);
		expect(problems[0]?.shape).toBe("same-pages");
		expect(problems[0]?.families).toEqual([]);
	});
});

describe("invariants the view depends on", () => {
	it("accounts for every finding exactly once", () => {
		/**
		 * The property that makes it safe to hide folded findings from the list
		 * below. If this ever fails, a run either shows a finding twice or loses one
		 * — and losing one is a check silently not reported.
		 */
		const pages = [
			...family("careers", LOCALES),
			single("/"),
			single("/about"),
		];

		const findings: CorrelatableFinding[] = [
			brokenLink("a", `${B}/gone`, [`${B}/en/careers`]),
			brokenLink("b", `${B}/gone-two`, [`${B}/de/careers`]),
			brokenLink("c", `${B}/gone-three`, [`${B}/`]),
			{ id: "d", type: "page_orphaned", detail: { urls: [`${B}/hidden`] } },
			{
				id: "e",
				type: "metadata_duplicated",
				detail: { urls: [`${B}/en/careers`, `${B}/de/careers`] },
			},
		];

		const { problems, remainder } = correlate(findings, pages);

		const seen = [
			...problems.flatMap((p) => p.findings.map((f) => f.id)),
			...remainder.map((f) => f.id),
		];

		expect(seen).toHaveLength(findings.length);
		expect(new Set(seen)).toEqual(new Set(findings.map((f) => f.id)));
	});

	it("matches an origin URL against a page recorded with the other spelling", () => {
		/**
		 * A trailing slash is punctuation, not identity. The markup that linked a
		 * page and the crawler that requested it can disagree by exactly that
		 * character, and the orphan rule shipped wrong for a phase because of it.
		 */
		const pages: CorrelatablePage[] = [
			{ url: `${B}/en/careers`, variantGroupKey: `${B}/en/careers` },
			{ url: `${B}/de/careers`, variantGroupKey: `${B}/en/careers` },
		];

		const { problems } = correlate(
			[
				brokenLink("a", `${B}/gone-one`, [`${B}/en/careers/`]),
				brokenLink("b", `${B}/gone-two`, [`${B}/de/careers/`]),
			],
			pages,
		);

		expect(problems).toHaveLength(1);
		expect(problems[0]?.shape).toBe("one-family");
	});

	it("orders problems the same way for the same input", () => {
		const pages = [...family("careers", LOCALES), ...family("legal", LOCALES)];

		const findings: CorrelatableFinding[] = [
			{
				id: "m1",
				type: "metadata_duplicated",
				detail: { urls: [`${B}/en/legal`] },
			},
			{
				id: "m2",
				type: "metadata_duplicated",
				detail: { urls: [`${B}/de/legal`] },
			},
			brokenLink("a", `${B}/gone`, [`${B}/en/careers`]),
			brokenLink("b", `${B}/gone-two`, [`${B}/de/careers`]),
			brokenLink("c", `${B}/gone-three`, [`${B}/fr/careers`]),
		];

		const first = correlate(findings, pages);
		const again = correlate([...findings].reverse(), pages);

		expect(first.problems.map((p) => p.key)).toEqual(
			again.problems.map((p) => p.key),
		);
		// The three-finding problem leads the two-finding one.
		expect(first.problems[0]?.findings).toHaveLength(3);
	});

	it("survives a detail that is missing or the wrong shape", () => {
		/**
		 * Detail is jsonb written by whatever produced the run, including runs
		 * recorded before a field existed. A crash here would take down the whole
		 * results screen over one malformed row.
		 */
		const { problems, remainder } = correlate(
			[
				{ id: "a", type: "link_broken", detail: {} },
				{
					id: "b",
					type: "link_broken",
					detail: { linkedFrom: "not an array" },
				},
			],
			[],
		);

		expect(problems).toEqual([]);
		expect(remainder).toHaveLength(2);
	});
});
