import { describe, expect, it } from "vitest";

import type { CrawledPage } from "./crawler";
import { detectMissingVariants } from "./findings";
import { localeFromUrl } from "./variants";

/**
 * The rules, against site shapes they were not written for.
 *
 * `findings.test.ts` crawls a fixture site. That fixture was written by the same
 * author who decided what the rules should do, in the same sitting, which means
 * it can only confirm a belief — never discover the belief was wrong. Every
 * shape below is instead taken from how multilingual sites are actually built:
 * the `x-default` fallback that Google's hreflang guidance defines, regional
 * refinements like `en-gb`, market segments such as `/us/`, and pages that
 * declare only themselves.
 *
 * Each case states its expectation and where that expectation comes from,
 * written before the rules were run against it. Where the rules disagreed, the
 * disagreement was investigated rather than the expectation edited — the whole
 * value of this file rests on that, since an expectation adjusted to match the
 * output is just the output written twice.
 *
 * The standard being applied is the product's own: "if runs routinely report
 * changes that do not matter, the developer stops reading them and the product
 * is dead". A false positive here is not a cosmetic defect.
 */

const BASE = "https://shop.test";

const page = (
	path: string,
	options: {
		hreflang?: Record<string, string>;
		status?: number;
	} = {},
): CrawledPage => ({
	url: `${BASE}${path}`,
	httpStatus: options.status ?? 200,
	hreflangTargets: Object.fromEntries(
		Object.entries(options.hreflang ?? {}).map(([locale, target]) => [
			locale,
			target.startsWith("http") ? target : `${BASE}${target}`,
		]),
	),
	links: [],
	fetchError: null,
});

/** A finding reduced to what a reader would check: what, and about which page. */
type Summary = { type: string; url: string | null };

function findingsFor(options: {
	pages: CrawledPage[];
	expectedLocales?: string[];
	inScope?: (url: string) => boolean;
	/** Defaults to a finished crawl: every existing case describes one. */
	crawlComplete?: boolean;
}): Summary[] {
	return detectMissingVariants({
		pages: options.pages,
		expectedLocales: options.expectedLocales ?? [],
		inScope: options.inScope ?? ((url) => url.startsWith(BASE)),
		crawlComplete: options.crawlComplete ?? true,
	})
		.map((finding) => ({ type: finding.type, url: finding.url }))
		.sort(
			(a, b) =>
				a.type.localeCompare(b.type) ||
				(a.url ?? "").localeCompare(b.url ?? ""),
		);
}

/**
 * The same call, keeping the evidence.
 *
 * Family-level findings carry their substance in `detail` — which members are
 * wrong and how — so a summary of type and URL would assert almost nothing about
 * them.
 */
function detailedFindingsFor(options: {
	pages: CrawledPage[];
	expectedLocales?: string[];
	inScope?: (url: string) => boolean;
	/** Defaults to a finished crawl: every existing case describes one. */
	crawlComplete?: boolean;
}) {
	return detectMissingVariants({
		pages: options.pages,
		expectedLocales: options.expectedLocales ?? [],
		inScope: options.inScope ?? ((url) => url.startsWith(BASE)),
		crawlComplete: options.crawlComplete ?? true,
	});
}

describe("shapes the rules should already handle", () => {
	it("says nothing about a complete family", () => {
		const alternates = { en: "/en", de: "/de", fr: "/fr" };

		expect(
			findingsFor({
				pages: [
					page("/en", { hreflang: alternates }),
					page("/de", { hreflang: alternates }),
					page("/fr", { hreflang: alternates }),
				],
				expectedLocales: ["en", "de", "fr"],
			}),
		).toEqual([]);
	});

	it("reports the one locale a family does not publish", () => {
		const alternates = { en: "/en", de: "/de" };

		expect(
			findingsFor({
				pages: [
					page("/en", { hreflang: alternates }),
					page("/de", { hreflang: alternates }),
				],
				expectedLocales: ["en", "de", "fr"],
			}),
		).toEqual([{ type: "missing_locale", url: `${BASE}/de` }]);
	});

	it("treats hreflang values as case-insensitive", () => {
		/**
		 * Real markup is inconsistent about this, and the language tag standard
		 * says case carries no meaning. `EN-GB` and `en-gb` are the same tag.
		 */
		const alternates = { EN: "/en", DE: "/de" };

		expect(
			findingsFor({
				pages: [
					page("/en", { hreflang: alternates }),
					page("/de", { hreflang: alternates }),
				],
				expectedLocales: ["en", "de"],
			}),
		).toEqual([]);
	});

	it("reports a broken sibling once, not also as a missing locale", () => {
		/**
		 * The German page is declared and returns 404. A reader needs one finding —
		 * the German variant is broken. Told additionally that German is missing,
		 * they would go looking for a second, non-existent problem.
		 */
		expect(
			findingsFor({
				pages: [
					page("/en", { hreflang: { en: "/en", de: "/de" } }),
					page("/de", { status: 404 }),
				],
				expectedLocales: ["en", "de"],
			}),
		).toEqual([{ type: "hreflang_target_failed", url: `${BASE}/en` }]);
	});

	it("does not report an out-of-scope sibling as unreached", () => {
		/**
		 * Country-code subdomains are a standard way to split locales. The crawl
		 * was configured not to leave the main host, so the sibling's absence is
		 * the configuration working rather than the site being broken.
		 */
		expect(
			findingsFor({
				pages: [
					page("/en", {
						hreflang: { en: "/en", de: "https://de.shop.test/" },
					}),
				],
				inScope: (url) => url.startsWith(BASE),
			}),
		).toEqual([]);
	});
});

describe("shapes taken from how multilingual sites are actually built", () => {
	it("does not treat x-default as a language", () => {
		/**
		 * `x-default` is defined by Google's hreflang guidance as the page shown to
		 * users whose language matches nothing — a fallback pointer, not a
		 * language. It is extremely common on real sites, and it routinely points
		 * at the same URL as the site's primary language.
		 *
		 * Here the site publishes English at `/` and German at `/de`, and marks `/`
		 * as the fallback. A reader would say this site is complete. Reporting
		 * English as missing — while the English page sits at the URL being
		 * reported — is the kind of confidently wrong finding that ends trust in
		 * the tool.
		 */
		const alternates = { "x-default": "/", en: "/", de: "/de" };

		expect(
			findingsFor({
				pages: [
					page("/", { hreflang: alternates }),
					page("/de", { hreflang: alternates }),
				],
				expectedLocales: ["en", "de"],
			}),
		).toEqual([]);
	});

	it("does not depend on where x-default appears in the markup", () => {
		/**
		 * The same site, with the fallback declared last instead of first. Document
		 * order is an authoring accident; two sites that differ only in the order
		 * of their link tags must not produce different findings.
		 */
		const alternates = { en: "/", de: "/de", "x-default": "/" };

		expect(
			findingsFor({
				pages: [
					page("/", { hreflang: alternates }),
					page("/de", { hreflang: alternates }),
				],
				expectedLocales: ["en", "de"],
			}),
		).toEqual([]);
	});

	it("does not mistake a two-letter path segment for a language", () => {
		/**
		 * `/us/` is a market, `/go/` is a redirect path, `/ok/` is a status
		 * segment. None is a language: none of these is an ISO 639-1 code, and a
		 * reader looking at this site would see one English site, not three
		 * untranslated languages.
		 *
		 * This is the same failure the locale pattern was narrowed to prevent for
		 * `/design/` and `/media/`, except that a two-letter segment slips through
		 * the narrowing.
		 */
		expect(
			findingsFor({
				pages: [page("/us/pricing"), page("/go/signup"), page("/ok/confirmed")],
			}),
		).toEqual([]);
	});

	it("still recognises a genuine locale segment", () => {
		/**
		 * The guard on the case above: narrowing the pattern must not silence the
		 * rule entirely. `de` is a real language code and this page declares no
		 * alternates, which is exactly what the rule exists to report.
		 */
		expect(findingsFor({ pages: [page("/de/preise")] })).toEqual([
			{ type: "no_hreflang", url: `${BASE}/de/preise` },
		]);
	});

	it("accepts a regional variant as satisfying the language it refines", () => {
		/**
		 * A site publishing `en-us` and `en-gb` publishes English. A project that
		 * expects `en` is asking for English, and telling its owner that English is
		 * missing — from a family containing two English pages — is a false
		 * positive of the worst kind, because the evidence contradicting it is in
		 * the finding itself.
		 *
		 * The reverse does not hold and is asserted separately below: a project
		 * expecting `en-gb` is asking for British English specifically, and a
		 * generic `en` page does not answer it.
		 */
		const alternates = { "en-us": "/en-us", "en-gb": "/en-gb", de: "/de" };

		expect(
			findingsFor({
				pages: [
					page("/en-us", { hreflang: alternates }),
					page("/en-gb", { hreflang: alternates }),
					page("/de", { hreflang: alternates }),
				],
				expectedLocales: ["en", "de"],
			}),
		).toEqual([]);
	});

	it("does not accept a bare language as satisfying a requested region", () => {
		/**
		 * The asymmetry that makes the case above safe rather than merely
		 * permissive. A project expecting `en-gb` has said it needs British
		 * English; a generic English page is not that, and silently accepting it
		 * would hide the gap the project was configured to find.
		 */
		const alternates = { en: "/en", de: "/de" };

		expect(
			findingsFor({
				pages: [
					page("/en", { hreflang: alternates }),
					page("/de", { hreflang: alternates }),
				],
				expectedLocales: ["en-gb", "de"],
			}),
		).toEqual([{ type: "missing_locale", url: `${BASE}/de` }]);
	});

	it("still recognises the languages this product exists to check", () => {
		/**
		 * The guard on a hand-written list of 184 codes: a single typo would drop a
		 * language silently, and the failure would look like the rules simply not
		 * firing for one locale. These are the languages an agency working across
		 * European and world markets would actually configure.
		 */
		const languages = [
			"en",
			"de",
			"fr",
			"es",
			"it",
			"pt",
			"nl",
			"pl",
			"sv",
			"da",
			"fi",
			"no",
			"cs",
			"sk",
			"hu",
			"ro",
			"bg",
			"el",
			"tr",
			"ru",
			"uk",
			"ar",
			"he",
			"hi",
			"ja",
			"ko",
			"zh",
			"th",
			"vi",
			"id",
		];

		const unrecognised = languages.filter(
			(language) => localeFromUrl(`${BASE}/${language}/page`) !== language,
		);

		expect(unrecognised).toEqual([]);
	});

	it("known limitation: a market segment that is also a language code", () => {
		/**
		 * Not an endorsement — a boundary, written down so that changing it is a
		 * decision rather than an accident.
		 *
		 * `uk` is Ukrainian and `br` is Breton, and both are also how English-
		 * language sites label their United Kingdom and Brazil markets. Nothing in
		 * a URL distinguishes the two readings, so this rule cannot: unlike `/us/`
		 * and `/go/`, which are now correctly ignored because they name no
		 * language at all, these are genuinely ambiguous.
		 *
		 * The product's answer is FR-008 — the derived language mapping is
		 * reviewable and correctable by the operator — not a cleverer regex here.
		 */
		expect(localeFromUrl(`${BASE}/uk/pricing`)).toBe("uk");
		expect(localeFromUrl(`${BASE}/br/precos`)).toBe("br");

		// Whereas the segments that name no language at all stay silent.
		expect(localeFromUrl(`${BASE}/us/pricing`)).toBeNull();
		expect(localeFromUrl(`${BASE}/go/signup`)).toBeNull();
	});

	it("reports a page whose only declared alternate is itself", () => {
		/**
		 * A self-referencing link is standard practice and carries no information
		 * about translations. A localised page whose *only* alternate is itself has
		 * declared that it has no siblings — which is the situation the
		 * no-alternates rule exists to report, and is indistinguishable to a reader
		 * from declaring nothing at all.
		 */
		expect(
			findingsFor({
				pages: [page("/de/preise", { hreflang: { de: "/de/preise" } })],
			}),
		).toEqual([{ type: "no_hreflang", url: `${BASE}/de/preise` }]);
	});
});

/**
 * FR-025's remaining half: declarations that contradict each other.
 *
 * "Pointing at dead URLs" already ships as the broken-variant and unreached
 * rules. What follows covers the other two terms — non-reciprocal and
 * incomplete — plus the self-reference the hreflang guidance requires of every
 * page in a set.
 *
 * Reported per family rather than per page or per edge. A template that emits a
 * partial alternate list breaks every page it renders, and a finding per edge
 * would bury the rest of the run under one defect. The requirement asks for the
 * same thing in its own words: the divergence itself is the finding, not five
 * independent per-URL reports.
 */
describe("a family whose declarations disagree with each other", () => {
	const detailsOf = (findings: ReturnType<typeof detailedFindingsFor>) =>
		findings.filter((f) => f.type === "hreflang_family_inconsistent");

	it("says nothing about a family that declares itself correctly", () => {
		/**
		 * Every member names every member including itself. This is what correct
		 * hreflang looks like, and it has to stay silent or the rule is worthless.
		 */
		const alternates = { en: "/en", de: "/de", fr: "/fr" };

		expect(
			findingsFor({
				pages: [
					page("/en", { hreflang: alternates }),
					page("/de", { hreflang: alternates }),
					page("/fr", { hreflang: alternates }),
				],
			}),
		).toEqual([]);
	});

	it("reports a declaration that is not returned", () => {
		/**
		 * The asymmetry FR-025 names. `/en` points at `/de`; `/de` points only at
		 * itself. Search engines treat an unreturned declaration as unconfirmed, so
		 * the pair does not function as a set at all — and the page to edit is the
		 * one that failed to point back.
		 */
		const findings = detailsOf(
			detailedFindingsFor({
				pages: [
					page("/en", { hreflang: { en: "/en", de: "/de" } }),
					page("/de", { hreflang: { de: "/de" } }),
				],
			}),
		);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.url).toBeNull();

		const defects = findings[0]?.detail.defects as Array<
			Record<string, unknown>
		>;

		expect(defects).toEqual([
			{
				url: `${BASE}/de`,
				kind: "not_reciprocated",
				sibling: `${BASE}/en`,
				// The tag to write, not just the page to write it on.
				siblingLocale: "en",
			},
		]);
	});

	it("reports a member declaring fewer alternates than its family publishes", () => {
		/**
		 * `/fr` names English but not German, and German never named it either — so
		 * this is an omission rather than an unreturned declaration. The distinction
		 * is kept because the fix differs: one page is missing a link, versus two
		 * pages that never knew about each other.
		 */
		const full = { en: "/en", de: "/de", fr: "/fr" };

		const findings = detailsOf(
			detailedFindingsFor({
				pages: [
					page("/en", { hreflang: full }),
					page("/de", { hreflang: { en: "/en", de: "/de" } }),
					page("/fr", { hreflang: { en: "/en", fr: "/fr" } }),
				],
			}),
		);

		expect(findings).toHaveLength(1);

		const defects = findings[0]?.detail.defects as Array<
			Record<string, unknown>
		>;

		// /de omits /fr and /fr omits /de; neither declared the other.
		expect(defects).toContainEqual({
			url: `${BASE}/de`,
			kind: "incomplete",
			sibling: `${BASE}/fr`,
			siblingLocale: "fr",
		});
		expect(defects).toContainEqual({
			url: `${BASE}/fr`,
			kind: "incomplete",
			sibling: `${BASE}/de`,
			siblingLocale: "de",
		});
	});

	it("reports a page that names its siblings but not itself", () => {
		/**
		 * The guidance requires every page in a set to include a self-referential
		 * hreflang. Without it the set is ambiguous about which URL serves which
		 * language, and the omission is invisible to anyone reading the page.
		 */
		const findings = detailsOf(
			detailedFindingsFor({
				pages: [
					page("/en", { hreflang: { en: "/en", de: "/de" } }),
					page("/de", { hreflang: { en: "/en" } }),
				],
			}),
		);

		expect(findings).toHaveLength(1);

		const defects = findings[0]?.detail.defects as Array<
			Record<string, unknown>
		>;

		expect(defects).toContainEqual({
			url: `${BASE}/de`,
			kind: "no_self_reference",
			locale: "de",
		});
	});

	it("produces one finding per family however many members are wrong", () => {
		/**
		 * The noise property, asserted directly. A template bug breaks every page it
		 * renders; a finding per page or per edge would make the worst sites the
		 * least readable, which is the failure the product calls fatal.
		 */
		const findings = detailsOf(
			detailedFindingsFor({
				pages: [
					page("/en", { hreflang: { en: "/en", de: "/de", fr: "/fr" } }),
					page("/de", { hreflang: { de: "/de" } }),
					page("/fr", { hreflang: { fr: "/fr" } }),
				],
			}),
		);

		expect(findings).toHaveLength(1);

		const defects = findings[0]?.detail.defects as unknown[];
		expect(defects.length).toBeGreaterThan(1);
	});

	it("says nothing about a family of one", () => {
		/**
		 * The same guard rule 1 carries. A page with no siblings cannot disagree
		 * with them, and without this a site of untranslated pages reports one
		 * finding each — the shape that produced seven findings where two were
		 * correct.
		 */
		expect(
			findingsFor({
				pages: [page("/de/preise", { hreflang: { de: "/de/preise" } })],
			}).filter((f) => f.type === "hreflang_family_inconsistent"),
		).toEqual([]);
	});

	it("does not ask a page that never loaded to declare anything", () => {
		/**
		 * A 404 has no HTML and therefore no hreflang. Reporting it for failing to
		 * point back would blame a page for being broken in a second, vaguer way —
		 * and the broken-variant rule already says it plainly, with the evidence.
		 *
		 * This is the shape that caught the first draft of the rule: it produced two
		 * findings where one was correct, which is the failure S-01 had to fix once
		 * already.
		 */
		expect(
			findingsFor({
				pages: [
					page("/en", { hreflang: { en: "/en", de: "/de" } }),
					page("/de", { status: 404 }),
				],
			}).filter((f) => f.type === "hreflang_family_inconsistent"),
		).toEqual([]);
	});

	it("does not count an x-default pointer as a missing declaration", () => {
		/**
		 * The fallback pointer is not a language, so there is nothing for its target
		 * to declare back. Counting it as an edge would report a defect on most real
		 * multilingual sites, which is where this rule would have died.
		 */
		const alternates = { en: "/en", de: "/de", "x-default": "/en" };

		expect(
			findingsFor({
				pages: [
					page("/en", { hreflang: alternates }),
					page("/de", { hreflang: alternates }),
				],
			}),
		).toEqual([]);
	});

	it("ignores a page the family reaches only through its fallback pointer", () => {
		/**
		 * Grouping unions on every declared target, fallback pointers included, so a
		 * language-selector page named by x-default is pulled into the family. It is
		 * not a translation of anything: it declares no language and no language
		 * declares it.
		 *
		 * Left in, it makes a correct site look broken from both directions — the
		 * selector is blamed for naming no siblings, and every real variant is
		 * blamed for not naming the selector. Four defects on a site with none.
		 */
		const alternates = { en: "/en", de: "/de", "x-default": "/choose" };

		expect(
			findingsFor({
				pages: [
					page("/en", { hreflang: alternates }),
					page("/de", { hreflang: alternates }),
					page("/choose"),
				],
			}).filter((f) => f.type === "hreflang_family_inconsistent"),
		).toEqual([]);
	});

	it("does not also call a page silent when its family already named it", () => {
		/**
		 * One fact, one finding. `/de` declares nothing, and that shows up two ways:
		 * as a page with no alternates, and as a member that does not link back to
		 * the sibling declaring it.
		 *
		 * The family finding wins because it is strictly more useful — it names the
		 * page to link to and the language to use, where the other only observes
		 * that something is absent. Saying both would be one problem under two
		 * names, which is the failure this project has now fixed three times.
		 */
		const findings = findingsFor({
			pages: [page("/en", { hreflang: { en: "/en", de: "/de" } }), page("/de")],
		});

		expect(
			findings.filter((f) => f.type === "hreflang_family_inconsistent"),
		).toHaveLength(1);
		expect(findings.filter((f) => f.type === "no_hreflang")).toEqual([]);
	});

	it("still calls a page silent when no family speaks for it", () => {
		/**
		 * The guard on the deferral: a locale-shaped page nobody declares has no
		 * family to describe it, so suppressing rule 4 here would lose the finding
		 * entirely rather than replace it.
		 */
		expect(
			findingsFor({ pages: [page("/de/preise")] }).filter(
				(f) => f.type === "no_hreflang",
			),
		).toHaveLength(1);
	});

	it("measures completeness against the family, not the project's locales", () => {
		/**
		 * A family publishing only en and de, where the project also expects fr, is
		 * internally consistent — every member names every member. The missing
		 * French is rule 1's to report, and saying it here as well would be the
		 * double-report that S-01 already had to fix once.
		 */
		const alternates = { en: "/en", de: "/de" };

		const findings = findingsFor({
			pages: [
				page("/en", { hreflang: alternates }),
				page("/de", { hreflang: alternates }),
			],
			expectedLocales: ["en", "de", "fr"],
		});

		expect(
			findings.filter((f) => f.type === "hreflang_family_inconsistent"),
		).toEqual([]);
		// Rule 1 still speaks, exactly once.
		expect(findings.filter((f) => f.type === "missing_locale")).toHaveLength(1);
	});
});

/**
 * FR-026: one variant failing while its siblings are not.
 *
 * The requirement is unusually specific about the shape of the answer — "where
 * five language variants are healthy and one is not, the divergence itself is
 * the finding, not five independent per-URL reports of which one happens to be
 * bad" — and measurement showed the product doing exactly the forbidden thing:
 * a six-variant family with one broken member produced five findings, one per
 * declaring sibling, each saying the same thing.
 *
 * So the collapse is threshold-based rather than universal. Two or more
 * declarers become one finding; a single declarer keeps the per-URL report,
 * because with one declarer that report already is one finding. The threshold is
 * what makes this safe to add to shipped behaviour.
 */
describe("a variant that failed while its siblings did not", () => {
	/** Every member declares every member, including itself. */
	const fullSet = {
		en: "/en",
		de: "/de",
		fr: "/fr",
		es: "/es",
		it: "/it",
	};

	it("says once that a variant is broken, not once per page pointing at it", () => {
		const findings = findingsFor({
			pages: [
				page("/en", { hreflang: fullSet }),
				page("/de", { hreflang: fullSet }),
				page("/es", { hreflang: fullSet }),
				page("/it", { hreflang: fullSet }),
				page("/fr", { status: 404 }),
			],
		});

		expect(findings.filter((f) => f.type === "variant_diverged")).toHaveLength(
			1,
		);

		/**
		 * The per-URL reports are replaced rather than accompanied. Keeping both
		 * would describe one problem twice — the failure S-01 already had to fix
		 * once, and the reason the divergence exists at all.
		 */
		expect(findings.filter((f) => f.type === "hreflang_target_failed")).toEqual(
			[],
		);
	});

	it("names the broken page, its status, and who points at it", () => {
		/**
		 * A collapsed finding has to carry everything the four it replaced carried,
		 * or the collapse trades noise for ignorance.
		 */
		const findings = detailedFindingsFor({
			pages: [
				page("/en", { hreflang: fullSet }),
				page("/de", { hreflang: fullSet }),
				page("/es", { hreflang: fullSet }),
				page("/it", { hreflang: fullSet }),
				page("/fr", { status: 404 }),
			],
		}).filter((f) => f.type === "variant_diverged");

		const detail = findings[0]?.detail as {
			brokenUrl: string;
			locale: string | null;
			httpStatus: number | null;
			declaredBy: string[];
			healthyUrls: string[];
		};

		expect(detail.brokenUrl).toBe(`${BASE}/fr`);
		expect(detail.locale).toBe("fr");
		expect(detail.httpStatus).toBe(404);
		expect(detail.declaredBy).toHaveLength(4);
		expect(detail.healthyUrls).toHaveLength(4);
	});

	it("leaves a variant with a single declarer reported as it always was", () => {
		/**
		 * The threshold, and the reason this rule can be added to shipped behaviour
		 * without rewriting it. One page declaring a broken sibling already produces
		 * exactly one finding; collapsing it would rename a working report for no
		 * gain and break every fixture built on that shape.
		 */
		const findings = findingsFor({
			pages: [
				page("/en", { hreflang: { en: "/en", de: "/de" } }),
				page("/de", { status: 404 }),
			],
		});

		expect(findings.filter((f) => f.type === "variant_diverged")).toEqual([]);
		expect(
			findings.filter((f) => f.type === "hreflang_target_failed"),
		).toHaveLength(1);
	});

	it("says nothing when the whole family failed", () => {
		/**
		 * Nothing diverged — the family is uniformly broken, which is a different
		 * problem and a bigger one. Calling it a divergence would point the reader
		 * at a comparison when what they need is that the section is down.
		 */
		expect(
			findingsFor({
				pages: [
					page("/en", { hreflang: fullSet, status: 500 }),
					page("/de", { status: 500 }),
					page("/fr", { status: 500 }),
				],
			}).filter((f) => f.type === "variant_diverged"),
		).toEqual([]);
	});

	it("says nothing about a family where every variant works", () => {
		expect(
			findingsFor({
				pages: [
					page("/en", { hreflang: fullSet }),
					page("/de", { hreflang: fullSet }),
					page("/fr", { hreflang: fullSet }),
					page("/es", { hreflang: fullSet }),
					page("/it", { hreflang: fullSet }),
				],
			}).filter((f) => f.type === "variant_diverged"),
		).toEqual([]);
	});
});

/**
 * A crawl that stopped early must not blame the site for where it did not go.
 *
 * Found against a real client site, and no fixture could have taught it: every
 * fixture crawl finishes. Twenty pages into a site whose English section alone
 * is larger than that, the page ceiling was reached before any German page —
 * and the run reported eighteen findings, every one of them saying a German
 * page "was never reached". All eighteen URLs return 200. The site was fine;
 * the tool described its own limit as the client's defect, confidently and at
 * volume.
 *
 * Two rules infer from absence. Rule 3 says a declared sibling that is missing
 * from the crawl is broken; rule 1 says a locale absent from a family is not
 * published. Both inferences are sound only when the crawl actually finished.
 * When it stopped early — page ceiling, failure abort, or process restart —
 * absence is evidence of nothing.
 */
describe("a crawl that did not finish", () => {
	const declaresMissingSibling = [
		page("/en", { hreflang: { en: "/en", de: "/de" } }),
	];

	it("does not report a declared sibling it may simply not have reached", () => {
		expect(
			findingsFor({ pages: declaresMissingSibling, crawlComplete: false }),
		).toEqual([]);
	});

	it("still reports one when the crawl ran to completion", () => {
		/**
		 * The guard on the suppression. Silence on a truncated run is right; silence
		 * on a finished one would delete the rule.
		 */
		expect(
			findingsFor({ pages: declaresMissingSibling, crawlComplete: true }),
		).toEqual([{ type: "hreflang_target_unreached", url: `${BASE}/en` }]);
	});

	it("does not report a locale that may be beyond where it stopped", () => {
		/**
		 * Rule 1's version of the same mistake, and the reason this fix is not
		 * limited to rule 3. It scored zero against the real site only by accident:
		 * truncation had left every family with a single member, so the
		 * two-member guard caught it. A slightly higher ceiling would have produced
		 * false "missing locale" findings alongside the false "never reached" ones.
		 */
		const alternates = { en: "/en", de: "/de" };

		expect(
			findingsFor({
				pages: [
					page("/en", { hreflang: alternates }),
					page("/de", { hreflang: alternates }),
				],
				expectedLocales: ["en", "de", "fr"],
				crawlComplete: false,
			}),
		).toEqual([]);
	});

	it("still reports a missing locale when the crawl ran to completion", () => {
		const alternates = { en: "/en", de: "/de" };

		expect(
			findingsFor({
				pages: [
					page("/en", { hreflang: alternates }),
					page("/de", { hreflang: alternates }),
				],
				expectedLocales: ["en", "de", "fr"],
				crawlComplete: true,
			}),
		).toEqual([{ type: "missing_locale", url: `${BASE}/de` }]);
	});

	it("still reports what it saw with its own eyes", () => {
		/**
		 * The boundary of the suppression. Rules that read what a crawled page
		 * actually said — rather than inferring from what is absent — remain valid
		 * however early the crawl stopped, and silencing them would throw away real
		 * findings for no reason.
		 */
		expect(
			findingsFor({
				pages: [page("/de/preise")],
				crawlComplete: false,
			}).filter((f) => f.type === "no_hreflang"),
		).toHaveLength(1);
	});
});
