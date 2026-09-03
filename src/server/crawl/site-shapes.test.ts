import { describe, expect, it } from "vitest";

import { type ContentSummary, emptyContent } from "./content";
import type { CrawledPage, Reverification } from "./crawler";
import type { ExternalSweep } from "./external";
import { detectMissingVariants } from "./findings";
import { emptyMetadata, type PageMetadata } from "./metadata";
import { parseRobots, type RobotsFile } from "./robots";
import type { SitemapDocument } from "./sitemap";
import type { CertificateObservation } from "./tls";
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
		/**
		 * Overrides on the content summary.
		 *
		 * The content rules read a digest, not text, so a case states the digest it
		 * means directly. Writing HTML here and extracting from it would make every
		 * case depend on the extractor as well as the rule, and a failure would no
		 * longer say which of the two was wrong.
		 */
		content?: Partial<ContentSummary>;
		/**
		 * Overrides on the metadata, for the same reason `content` takes them: a
		 * case states the title, canonical or directive it means directly rather
		 * than writing HTML and depending on the extractor as well as the rule.
		 */
		metadata?: Partial<PageMetadata>;
		/** Response headers this case is about, by lowercase name. */
		securityHeaders?: Record<string, string>;
		/** The `X-Robots-Tag` header, verbatim as a site would serve it. */
		xRobotsTag?: string | null;
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
	content: { ...emptyContent(true), ...options.content },
	metadata: {
		...emptyMetadata(),
		/**
		 * A unique title and description by default, so the metadata rules stay
		 * quiet about the many cases here that exist to exercise something else.
		 * Without them every hreflang shape below would also report a missing
		 * title, and the cases that *are* about metadata would be lost among them.
		 *
		 * A case that means "this page published none" says so with an explicit
		 * null, which is the shape the extractor produces for both an absent tag
		 * and an empty one.
		 */
		title: `Title of ${path}`,
		description: `Description of ${path}`,
		...options.metadata,
	},
	xRobotsTag: options.xRobotsTag ?? null,
	securityHeaders: options.securityHeaders ?? {},
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
	/** Defaults to none: most cases describe a crawl with no transient failure. */
	reverified?: Reverification[];
	/** Defaults to none: most cases are not about the transport layer. */
	certificate?: CertificateObservation | null;
	/** Defaults to none: most cases describe a site with no robots.txt. */
	robots?: RobotsFile | null;
	/** Defaults to none: most cases describe a site with no sitemap. */
	sitemap?: SitemapDocument | null;
	/** Defaults to none: most cases are not about the crawl's entry point. */
	entryUrl?: string | null;
	/**
	 * Defaults to every page given, which is what a case built by hand means: it
	 * states the crawl it wants, so nothing in it was silently unreachable.
	 */
	requested?: string[];
	/** Defaults to an incomplete, empty sweep: most cases are not about it. */
	external?: ExternalSweep;
}): Summary[] {
	return detectMissingVariants({
		pages: options.pages,
		expectedLocales: options.expectedLocales ?? [],
		inScope: options.inScope ?? ((url) => url.startsWith(BASE)),
		crawlComplete: options.crawlComplete ?? true,
		reverified: options.reverified ?? [],
		certificate: options.certificate ?? null,
		robots: options.robots ?? null,
		sitemap: options.sitemap ?? null,
		entryUrl: options.entryUrl ?? null,
		requested: options.requested ?? options.pages.map((p) => p.url),
		external: options.external ?? { checked: [], complete: false },
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
	/** Defaults to none: most cases describe a crawl with no transient failure. */
	reverified?: Reverification[];
	/** Defaults to none: most cases are not about the transport layer. */
	certificate?: CertificateObservation | null;
	/** Defaults to none: most cases describe a site with no robots.txt. */
	robots?: RobotsFile | null;
	/** Defaults to none: most cases describe a site with no sitemap. */
	sitemap?: SitemapDocument | null;
	/** Defaults to none: most cases are not about the crawl's entry point. */
	entryUrl?: string | null;
	/**
	 * Defaults to every page given, which is what a case built by hand means: it
	 * states the crawl it wants, so nothing in it was silently unreachable.
	 */
	requested?: string[];
	/** Defaults to an incomplete, empty sweep: most cases are not about it. */
	external?: ExternalSweep;
}) {
	return detectMissingVariants({
		pages: options.pages,
		expectedLocales: options.expectedLocales ?? [],
		inScope: options.inScope ?? ((url) => url.startsWith(BASE)),
		crawlComplete: options.crawlComplete ?? true,
		reverified: options.reverified ?? [],
		certificate: options.certificate ?? null,
		robots: options.robots ?? null,
		sitemap: options.sitemap ?? null,
		entryUrl: options.entryUrl ?? null,
		requested: options.requested ?? options.pages.map((p) => p.url),
		external: options.external ?? { checked: [], complete: false },
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

/**
 * The question is about a language, not about a URL.
 *
 * Rule 5 asked whether a member declared a sibling's exact URL. That is not what
 * the finding it produces claims — "does not link to /de/careers (de)" is a
 * complaint about German, and a page that declares German somewhere else has
 * answered it.
 *
 * Every instance of this observed in the wild was caused by redirect aliases,
 * which phase 1 removed. These cases are therefore constructed rather than
 * reproduced: they describe a site genuinely serving two URLs for one language,
 * which is rarer but not impossible, and which the rule would still misreport.
 */
describe("a family holding two URLs for one language", () => {
	it("does not report a member for a language it already declares", () => {
		/**
		 * `/en` declares German once, pointing at `/de-a`. `/de-b` is also German
		 * and also in the family. Asking whether `/en` links to `/de-b` specifically
		 * is the wrong question — it has published a German alternate, which is what
		 * the finding would otherwise accuse it of not doing.
		 */
		const findings = findingsFor({
			pages: [
				page("/en", { hreflang: { en: "/en", de: "/de-a" } }),
				page("/de-a", { hreflang: { de: "/de-a", en: "/en" } }),
				page("/de-b", { hreflang: { de: "/de-b", en: "/en" } }),
			],
		});

		expect(
			findings.filter((f) => f.type === "hreflang_family_inconsistent"),
		).toEqual([]);
	});

	it("still reports a member that declares nothing for a sibling's language", () => {
		/**
		 * The guard, and the more important half. Loosening the comparison must not
		 * silence the rule: `/en` declares only itself, so it publishes no German at
		 * all, and the sibling that names it gets no link back.
		 */
		const findings = detailedFindingsFor({
			pages: [
				page("/en", { hreflang: { en: "/en" } }),
				page("/de", { hreflang: { de: "/de", en: "/en" } }),
			],
		}).filter((f) => f.type === "hreflang_family_inconsistent");

		expect(findings).toHaveLength(1);

		const defects = findings[0]?.detail.defects as Array<
			Record<string, unknown>
		>;
		expect(defects).toContainEqual({
			url: `${BASE}/en`,
			kind: "not_reciprocated",
			sibling: `${BASE}/de`,
			siblingLocale: "de",
		});
	});
});

/**
 * Rule 7, against shapes it was not written for.
 *
 * The rule answers one question — was this page ever actually translated — from
 * two kinds of evidence. What matters here is not that it fires, which the
 * fixture already shows, but the set of cases where a human would say nothing is
 * wrong and the rule must agree.
 */
describe("content that was never translated", () => {
	const trio = { en: "/en", de: "/de", fr: "/fr" };
	const SAME = "d".repeat(64);
	const OTHER = "e".repeat(64);

	const untranslated = (finding: { type: string }) =>
		finding.type === "content_untranslated";

	it("reports one finding when two locales serve the same content", () => {
		/**
		 * Not two. The pair is one problem, and reporting it from each side would be
		 * the double-report rule 6 exists to collapse, wearing a new name.
		 */
		const findings = detailedFindingsFor({
			pages: [
				page("/en", { hreflang: trio, content: { textDigest: SAME } }),
				page("/de", { hreflang: trio, content: { textDigest: SAME } }),
				page("/fr", { hreflang: trio, content: { textDigest: OTHER } }),
			],
		}).filter(untranslated);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail).toMatchObject({
			kind: "identical_to_siblings",
			urls: [`${BASE}/de`, `${BASE}/en`],
			locales: ["de", "en"],
		});
	});

	it("still reports one finding when three locales share one body", () => {
		/**
		 * The shape that decides whether this scales: a site that copied its source
		 * language into every translation. Per-page reporting would produce three
		 * findings here and six on a six-language site, which is how a rule that is
		 * right in principle becomes unreadable in practice.
		 */
		const findings = detailedFindingsFor({
			pages: [
				page("/en", { hreflang: trio, content: { textDigest: SAME } }),
				page("/de", { hreflang: trio, content: { textDigest: SAME } }),
				page("/fr", { hreflang: trio, content: { textDigest: SAME } }),
			],
		}).filter(untranslated);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail.urls).toHaveLength(3);
	});

	it("says nothing when siblings genuinely differ", () => {
		expect(
			detailedFindingsFor({
				pages: [
					page("/en", { hreflang: trio, content: { textDigest: SAME } }),
					page("/de", { hreflang: trio, content: { textDigest: OTHER } }),
					page("/fr", {
						hreflang: trio,
						content: { textDigest: "f".repeat(64) },
					}),
				],
			}).filter(untranslated),
		).toEqual([]);
	});

	it("says nothing about a regional refinement sharing its language's content", () => {
		/**
		 * Duplicate content is a real problem and a different one. A British English
		 * page carrying the generic English body has not failed to be translated —
		 * there was never a second language involved — and calling it a translation
		 * defect would send the reader looking for a translator.
		 *
		 * `en` and `en-gb` are different locale tags, so a rule comparing tags rather
		 * than languages reports this. Found by mutation: weakening the guard to
		 * "two URLs" left every test passing, because the first version of this case
		 * forgot to give both pages a digest and so proved nothing.
		 */
		const uk = { en: "/en", "en-gb": "/uk" };

		expect(
			detailedFindingsFor({
				pages: [
					page("/en", { hreflang: uk, content: { textDigest: SAME } }),
					page("/uk", { hreflang: uk, content: { textDigest: SAME } }),
				],
			}).filter(untranslated),
		).toEqual([]);
	});

	it("says nothing when a page has too little text to compare", () => {
		/**
		 * A null digest is the extractor declining to judge. The rule has to decline
		 * with it rather than treating "no evidence" as "no difference".
		 */
		expect(
			detailedFindingsFor({
				pages: [
					page("/en", { hreflang: trio, content: { textDigest: null } }),
					page("/de", { hreflang: trio, content: { textDigest: null } }),
				],
			}).filter(untranslated),
		).toEqual([]);
	});

	it("says nothing about a member that errored", () => {
		/**
		 * A broken page has no content, so every content rule would rank it as the
		 * most extreme drift on the site — while rules 2 and 6 already describe it
		 * correctly. This is the fifth time this project has had to write this guard.
		 */
		expect(
			detailedFindingsFor({
				pages: [
					page("/en", { hreflang: trio, content: { textDigest: SAME } }),
					page("/de", {
						hreflang: trio,
						status: 404,
						content: { textDigest: SAME },
					}),
				],
			}).filter(untranslated),
		).toEqual([]);
	});

	it("says nothing about a response that was not HTML", () => {
		expect(
			detailedFindingsFor({
				pages: [
					page("/en", { hreflang: trio, content: { textDigest: SAME } }),
					page("/de", {
						hreflang: trio,
						content: { textDigest: SAME, isHtml: false },
					}),
				],
			}).filter(untranslated),
		).toEqual([]);
	});

	it("stays quiet about identical siblings on a crawl that stopped early", () => {
		/**
		 * The same reasoning rules 1 and 3 carry. A truncated run holds half a
		 * family, and the member it did not reach is the one most likely to hold the
		 * real translation.
		 */
		expect(
			detailedFindingsFor({
				pages: [
					page("/en", { hreflang: trio, content: { textDigest: SAME } }),
					page("/de", { hreflang: trio, content: { textDigest: SAME } }),
				],
				crawlComplete: false,
			}).filter(untranslated),
		).toEqual([]);
	});

	it("reports a marker on a page with no family at all", () => {
		/**
		 * An unrendered expression needs nothing to compare against. A monolingual
		 * site showing `{{ headline }}` has the same defect as a multilingual one,
		 * and a rule that only spoke about families would miss every such page.
		 */
		const findings = detailedFindingsFor({
			pages: [
				page("/pricing", { content: { markers: ["unrendered_expression"] } }),
			],
		}).filter(untranslated);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.url).toBe(`${BASE}/pricing`);
		expect(findings[0]?.detail.kind).toBe("placeholder_markers");
	});

	it("reports a marker even on a crawl that stopped early", () => {
		/**
		 * Unlike the sibling comparison, this evidence is on the page in front of
		 * us. Where we stopped crawling says nothing about whether that page
		 * rendered.
		 */
		expect(
			detailedFindingsFor({
				pages: [page("/pricing", { content: { markers: ["lorem_ipsum"] } })],
				crawlComplete: false,
			}).filter(untranslated),
		).toHaveLength(1);
	});

	it("says nothing about a marker on a page that errored", () => {
		expect(
			detailedFindingsFor({
				pages: [
					page("/pricing", {
						status: 500,
						content: { markers: ["lorem_ipsum"] },
					}),
				],
			}).filter(untranslated),
		).toEqual([]);
	});
});

/**
 * Rule 8, against shapes it was not written for.
 *
 * The rule compares what a family's variants contain, and the risk it carries is
 * the mirror of rule 7's: not that it misses a dropped form, but that it calls
 * an ordinary editorial difference a defect.
 */
describe("variants that do not contain the same things", () => {
	const trio = { en: "/en", de: "/de", fr: "/fr" };

	const differs = (finding: { type: string }) =>
		finding.type === "content_structure_differs";

	/** A member whose content we isolated, carrying the given blocks. */
	const withBlocks = (
		path: string,
		blocks: Partial<Record<string, boolean>>,
		extra: { status?: number; isHtml?: boolean; isolated?: boolean } = {},
	) =>
		page(path, {
			hreflang: trio,
			status: extra.status,
			content: {
				isolated: extra.isolated ?? true,
				isHtml: extra.isHtml ?? true,
				blocks: {
					heading: false,
					form: false,
					table: false,
					media: false,
					list: false,
					...blocks,
				},
			},
		});

	it("reports one finding naming both sides of the difference", () => {
		const findings = detailedFindingsFor({
			pages: [
				withBlocks("/en", { heading: true, form: true }),
				withBlocks("/de", { heading: true }),
				withBlocks("/fr", { heading: true }),
			],
		}).filter(differs);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail.differences).toEqual([
			{
				block: "form",
				present: [`${BASE}/en`],
				absent: [`${BASE}/de`, `${BASE}/fr`],
			},
		]);
	});

	it("says nothing when every member contains the same things", () => {
		expect(
			detailedFindingsFor({
				pages: [
					withBlocks("/en", { heading: true, list: true }),
					withBlocks("/de", { heading: true, list: true }),
					withBlocks("/fr", { heading: true, list: true }),
				],
			}).filter(differs),
		).toEqual([]);
	});

	it("declines when the content could not be isolated", () => {
		/**
		 * The guard that decides whether this rule is trustworthy on real sites. A
		 * fallback summary swept in the navigation, so a search box in the header
		 * makes a page appear to contain a form. Reporting that would be a claim
		 * about our extraction, not about the site.
		 */
		expect(
			detailedFindingsFor({
				pages: [
					withBlocks("/en", { heading: true, form: true }, { isolated: false }),
					withBlocks("/de", { heading: true }, { isolated: false }),
				],
			}).filter(differs),
		).toEqual([]);
	});

	it("ignores a member that errored rather than comparing its empty content", () => {
		/**
		 * A broken page contains nothing, so it differs from every healthy sibling
		 * in every block at once — the most alarming finding on the site, about a
		 * page rules 2 and 6 already describe correctly.
		 */
		expect(
			detailedFindingsFor({
				pages: [
					withBlocks("/en", { heading: true, form: true }),
					withBlocks("/de", {}, { status: 404 }),
				],
			}).filter(differs),
		).toEqual([]);
	});

	it("ignores a member whose response was not HTML", () => {
		expect(
			detailedFindingsFor({
				pages: [
					withBlocks("/en", { heading: true, form: true }),
					withBlocks("/de", {}, { isHtml: false }),
				],
			}).filter(differs),
		).toEqual([]);
	});

	it("stays quiet on a crawl that stopped early", () => {
		expect(
			detailedFindingsFor({
				pages: [
					withBlocks("/en", { heading: true, form: true }),
					withBlocks("/de", { heading: true }),
				],
				crawlComplete: false,
			}).filter(differs),
		).toEqual([]);
	});

	it("needs two comparable members before it says anything", () => {
		/**
		 * One isolated member and one that fell back is not a comparison. Without
		 * this the rule would report a family against a single page's blocks.
		 */
		expect(
			detailedFindingsFor({
				pages: [
					withBlocks("/en", { heading: true, form: true }),
					withBlocks("/de", { heading: true }, { isolated: false }),
				],
			}).filter(differs),
		).toEqual([]);
	});

	it("lists every differing block type in one finding, not one finding each", () => {
		const findings = detailedFindingsFor({
			pages: [
				withBlocks("/en", { heading: true, form: true, table: true }),
				withBlocks("/de", { heading: true }),
				withBlocks("/fr", { heading: true }),
			],
		}).filter(differs);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail.differences).toHaveLength(2);
	});
});

/**
 * Rules 9 and 10, against shapes they were not written for.
 *
 * FR-021's two trustworthy signals. Both are the site's own assertion — a tag is
 * absent, or one string appears on two pages — which is what makes them
 * shippable while the length signal is not. The risk they carry is the usual
 * one: reporting a legitimate practice as a defect, and in particular calling
 * two locale variants that share a brand name a duplicate.
 */
describe("titles and descriptions", () => {
	const missing = (finding: { type: string }) =>
		finding.type === "metadata_missing";
	const duplicated = (finding: { type: string }) =>
		finding.type === "metadata_duplicated";

	it("reports a page that published no title, naming the field", () => {
		const findings = detailedFindingsFor({
			pages: [page("/en/pricing", { metadata: { title: null } })],
		}).filter(missing);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.url).toBe(`${BASE}/en/pricing`);
		expect(findings[0]?.detail.fields).toEqual(["title"]);
	});

	it("reports a description tag that is present but empty", () => {
		/**
		 * `content=""` and no tag at all are the same fact to a search engine, and
		 * the extractor already reduces both to null — so by the time a rule sees
		 * one there is a single shape rather than two. That is deliberate: a rule
		 * that had to know about both would eventually handle only one.
		 */
		const findings = detailedFindingsFor({
			pages: [page("/en/pricing", { metadata: { description: null } })],
		}).filter(missing);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail.fields).toEqual(["description"]);
	});

	it("reports a page missing both fields once, not twice", () => {
		/**
		 * A head that was never filled in is one defect. Two findings would put the
		 * same page in the same list twice, which is the double-report this file
		 * spends its length avoiding.
		 */
		const findings = detailedFindingsFor({
			pages: [
				page("/en/pricing", { metadata: { title: null, description: null } }),
			],
		}).filter(missing);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail.fields).toEqual(["title", "description"]);
	});

	it("says nothing about a page that published both", () => {
		expect(
			detailedFindingsFor({ pages: [page("/en/pricing")] }).filter(missing),
		).toEqual([]);
	});

	it("says nothing about a page that failed", () => {
		/**
		 * A page that 404s served no head, so every metadata rule would rank it as
		 * maximally defective — while rule 2 is already describing it correctly and
		 * more usefully.
		 */
		expect(
			detailedFindingsFor({
				pages: [
					page("/en/gone", {
						status: 404,
						metadata: { title: null, description: null },
					}),
					page("/en/down", {
						status: 500,
						metadata: { title: null, description: null },
					}),
				],
			}).filter(missing),
		).toEqual([]);
	});

	it("says nothing about a response that was never HTML", () => {
		/**
		 * A PDF has no `<title>` element and never should. Reporting one would be a
		 * finding about the format the URL serves rather than about the site.
		 */
		expect(
			detailedFindingsFor({
				pages: [
					page("/en/brochure", {
						content: { isHtml: false },
						metadata: { title: null, description: null },
					}),
				],
			}).filter(missing),
		).toEqual([]);
	});

	it("reports two same-language pages sharing a title, once, naming both", () => {
		const findings = detailedFindingsFor({
			pages: [
				page("/en/legal", { metadata: { title: "Yazaki EMEA" } }),
				page("/en/privacy", { metadata: { title: "Yazaki EMEA" } }),
			],
		}).filter(duplicated);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.url).toBeNull();
		expect(findings[0]?.detail).toMatchObject({
			field: "title",
			language: "en",
			value: "Yazaki EMEA",
			urls: [`${BASE}/en/legal`, `${BASE}/en/privacy`],
		});
	});

	it("reports a shared description the same way", () => {
		const findings = detailedFindingsFor({
			pages: [
				page("/en/legal", {
					metadata: { description: "Discover Yazaki EMEA" },
				}),
				page("/en/privacy", {
					metadata: { description: "Discover Yazaki EMEA" },
				}),
			],
		}).filter(duplicated);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail.field).toBe("description");
	});

	it("says nothing about two languages sharing one title", () => {
		/**
		 * The negative assertion this rule rests on. A brand or product name is the
		 * same word in every locale, and a page whose German copy really is the
		 * English one is already reported by rule 7 — so an unscoped rule would
		 * report honest translations as defective and genuine ones twice.
		 */
		expect(
			detailedFindingsFor({
				pages: [
					page("/en/about", { metadata: { title: "Yazaki" } }),
					page("/de/about", { metadata: { title: "Yazaki" } }),
				],
			}).filter(duplicated),
		).toEqual([]);
	});

	it("treats a regional refinement as the language it refines", () => {
		/**
		 * `en` and `en-gb` pages sharing a title compete for the same query, which
		 * is the whole reason duplicate titles matter. The same reading `satisfies`
		 * applies when deciding whether a family publishes a language.
		 */
		expect(
			detailedFindingsFor({
				pages: [
					page("/en/legal", { metadata: { title: "Legal information" } }),
					page("/en-gb/legal", { metadata: { title: "Legal information" } }),
				],
			}).filter(duplicated),
		).toHaveLength(1);
	});

	it("reports two pages whose language nothing established, as their own bucket", () => {
		/**
		 * Two pages with no locale in the URL and no hreflang — every page of a
		 * monolingual site.
		 *
		 * This expectation is the reverse of the one that shipped with S-05, and the
		 * reversal is a change of requirement rather than a rule fitted to its own
		 * output. S-05 refused these pages because calling them duplicates *in a
		 * language* neither declared is a claim about our guess, and that reasoning
		 * still holds — it is why the bucket is separate rather than merged. What it
		 * did not cover is FR-020, which asks about duplicates "across URLs" and
		 * qualifies by nothing at all. Sharing a title is the site's own assertion
		 * whether or not it ever named a language.
		 */
		const findings = detailedFindingsFor({
			pages: [
				page("/legal", { metadata: { title: "Legal information" } }),
				page("/privacy", { metadata: { title: "Legal information" } }),
			],
		}).filter(duplicated);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail).toMatchObject({
			field: "title",
			language: null,
			value: "Legal information",
			urls: [`${BASE}/legal`, `${BASE}/privacy`],
		});
	});

	it("does not compare an unlocalised page against a localised one", () => {
		/**
		 * The guess S-05's refusal was actually about, and it is still refused.
		 * Deciding that a page declaring no language shares German's bucket would be
		 * our inference; the buckets stay apart and neither page is reported.
		 */
		expect(
			detailedFindingsFor({
				pages: [
					page("/legal", { metadata: { title: "Impressum" } }),
					page("/de/impressum", { metadata: { title: "Impressum" } }),
				],
			}).filter(duplicated),
		).toEqual([]);
	});

	it("says nothing about a duplicate on a truncated crawl", () => {
		/**
		 * The finding's substance is the list of pages carrying the string, and a
		 * run that stopped at its ceiling can hold one member of a pair and not the
		 * other — so the list would describe where we stopped rather than what the
		 * site publishes.
		 */
		expect(
			detailedFindingsFor({
				crawlComplete: false,
				pages: [
					page("/en/legal", { metadata: { title: "Yazaki EMEA" } }),
					page("/en/privacy", { metadata: { title: "Yazaki EMEA" } }),
				],
			}).filter(duplicated),
		).toEqual([]);
	});

	it("does not count a failed page towards a duplicate", () => {
		expect(
			detailedFindingsFor({
				pages: [
					page("/en/legal", { metadata: { title: "Yazaki EMEA" } }),
					page("/en/privacy", {
						status: 404,
						metadata: { title: "Yazaki EMEA" },
					}),
				],
			}).filter(duplicated),
		).toEqual([]);
	});

	it("says nothing when every page published its own title", () => {
		expect(
			detailedFindingsFor({
				pages: [page("/en/legal"), page("/en/privacy"), page("/de/impressum")],
			}).filter(duplicated),
		).toEqual([]);
	});
});

describe("canonical URLs", () => {
	const CANONICAL_TYPES = new Set([
		"canonical_missing",
		"canonical_conflicting",
		"canonical_target_broken",
	]);

	/**
	 * Every canonical finding, not one type at a time.
	 *
	 * The three rules read one input and narrow each other — rule 13 declines
	 * where rule 12 already spoke, rule 12 declines where rule 13 will — so a
	 * test filtering to a single type could not see the double-report those
	 * narrowings exist to prevent. "Exactly one finding" here means one across
	 * all three.
	 */
	const canonicalFindings = (
		options: Parameters<typeof detailedFindingsFor>[0],
	) => detailedFindingsFor(options).filter((f) => CANONICAL_TYPES.has(f.type));

	/**
	 * Canonicals are written here as the page would write them, un-normalised.
	 *
	 * `extractMetadata` normalises what it reads, so in production both sides of
	 * every comparison already match. These cases deliberately bypass it — which
	 * is the point: a rule that only works because its caller normalised first is
	 * a rule waiting to report our own trailing slash as the client's defect, and
	 * the two cases below would pass either way if the rule were trusted to skip
	 * the step.
	 */

	it("reports a page declaring two different canonicals, once", () => {
		const findings = canonicalFindings({
			pages: [
				page("/en/pricing", {
					metadata: {
						canonicals: [`${BASE}/en/pricing`, `${BASE}/en/plans`],
					},
				}),
			],
		});

		expect(findings).toHaveLength(1);
		expect(findings[0]?.type).toBe("canonical_conflicting");
		expect(findings[0]?.url).toBe(`${BASE}/en/pricing`);
		expect(findings[0]?.detail).toMatchObject({
			kind: "multiple",
			canonicals: [`${BASE}/en/pricing`, `${BASE}/en/plans`],
		});
	});

	it("reports a canonical pointing at a page that 404s", () => {
		const findings = canonicalFindings({
			pages: [
				page("/en/pricing", {
					metadata: { canonicals: [`${BASE}/en/gone`] },
				}),
				page("/en/gone", { status: 404 }),
			],
		});

		expect(findings).toHaveLength(1);
		expect(findings[0]?.type).toBe("canonical_target_broken");
		expect(findings[0]?.detail).toMatchObject({
			kind: "failed",
			url: `${BASE}/en/pricing`,
			canonical: `${BASE}/en/gone`,
			httpStatus: 404,
		});
	});

	it("reports a chain once, against the page that starts it", () => {
		/**
		 * A→B where B→C. Only A is defective: B names a canonical and that
		 * canonical is itself canonical, which is what a correct page looks like.
		 * Reporting B as well would file A's defect against the page it points at.
		 */
		const findings = canonicalFindings({
			pages: [
				page("/en/a", { metadata: { canonicals: [`${BASE}/en/b`] } }),
				page("/en/b", { metadata: { canonicals: [`${BASE}/en/c`] } }),
				page("/en/c", { metadata: { canonicals: [`${BASE}/en/c`] } }),
			],
		});

		expect(findings).toHaveLength(1);
		expect(findings[0]?.type).toBe("canonical_conflicting");
		expect(findings[0]?.url).toBe(`${BASE}/en/a`);
		expect(findings[0]?.detail).toMatchObject({
			kind: "chain",
			canonical: `${BASE}/en/b`,
			targetCanonical: `${BASE}/en/c`,
		});
	});

	it("says nothing about a canonical differing only by a trailing slash", () => {
		/**
		 * The crawl records `/en/pricing`; the page writes `/en/pricing/`. They are
		 * the same page, and it was *our* normalisation that made the strings
		 * differ — reporting it would be the page-identity false positive under a
		 * new name, which is the failure `lessons.md` exists to prevent.
		 */
		expect(
			canonicalFindings({
				pages: [
					page("/en/pricing", {
						metadata: { canonicals: [`${BASE}/en/pricing/`] },
					}),
				],
			}),
		).toEqual([]);
	});

	it("says nothing about a canonical differing only by a query string", () => {
		// `normaliseUrl` drops query strings, so the crawl already collapsed this
		// URL to the page it recorded.
		expect(
			canonicalFindings({
				pages: [
					page("/en/pricing", {
						metadata: {
							canonicals: [`${BASE}/en/pricing?utm_source=newsletter`],
						},
					}),
				],
			}),
		).toEqual([]);
	});

	it("says nothing about pages on a site that uses no canonicals at all", () => {
		/**
		 * The negative assertion the missing rule rests on. A canonical tag is
		 * optional; a site using none has not made a mistake, and firing per page
		 * would produce one finding for every page it publishes.
		 */
		expect(
			canonicalFindings({
				pages: [page("/en/pricing"), page("/en/about"), page("/en/contact")],
			}),
		).toEqual([]);
	});

	it("reports a page with no canonical when the site declares them elsewhere", () => {
		const findings = canonicalFindings({
			pages: [
				page("/en/about", { metadata: { canonicals: [`${BASE}/en/about`] } }),
				page("/en/pricing"),
			],
		});

		expect(findings).toHaveLength(1);
		expect(findings[0]?.type).toBe("canonical_missing");
		expect(findings[0]?.url).toBe(`${BASE}/en/pricing`);
		expect(findings[0]?.detail).toMatchObject({
			url: `${BASE}/en/pricing`,
			pagesDeclaringCanonical: 1,
		});
	});

	it("says nothing about a canonical pointing outside the crawl scope", () => {
		/**
		 * The crawl was told not to go there, so the target's absence is the
		 * configuration working rather than the site being broken — the same
		 * suppression rule 3 carries.
		 */
		expect(
			canonicalFindings({
				pages: [
					page("/en/pricing", {
						metadata: { canonicals: ["https://elsewhere.test/pricing"] },
					}),
				],
			}),
		).toEqual([]);
	});

	it("reports an in-scope canonical the finished crawl never reached", () => {
		const findings = canonicalFindings({
			pages: [
				page("/en/pricing", {
					metadata: { canonicals: [`${BASE}/en/plans`] },
				}),
			],
		});

		expect(findings).toHaveLength(1);
		expect(findings[0]?.type).toBe("canonical_target_broken");
		expect(findings[0]?.detail).toMatchObject({
			kind: "unreached",
			canonical: `${BASE}/en/plans`,
		});
	});

	it("stays quiet on a crawl that stopped early", () => {
		/**
		 * Both inferences that reason from absence. A truncated run can be looking
		 * at exactly the half of a site that carries no canonicals, and the page a
		 * canonical names may sit beyond where we stopped.
		 */
		expect(
			canonicalFindings({
				crawlComplete: false,
				pages: [
					page("/en/about", { metadata: { canonicals: [`${BASE}/en/about`] } }),
					page("/en/pricing"),
					page("/en/plans", {
						metadata: { canonicals: [`${BASE}/en/tariffs`] },
					}),
				],
			}),
		).toEqual([]);
	});

	it("says nothing about a page that failed", () => {
		expect(
			canonicalFindings({
				pages: [
					page("/en/about", { metadata: { canonicals: [`${BASE}/en/about`] } }),
					page("/en/gone", { status: 404 }),
					page("/en/down", { status: 500 }),
				],
			}),
		).toEqual([]);
	});

	it("says nothing about a response that was never HTML", () => {
		/**
		 * A PDF has no canonical link element and never should. Reporting one would
		 * be a finding about the format the URL serves rather than about the site.
		 */
		expect(
			canonicalFindings({
				pages: [
					page("/en/about", { metadata: { canonicals: [`${BASE}/en/about`] } }),
					page("/en/brochure", { content: { isHtml: false } }),
				],
			}),
		).toEqual([]);
	});

	it("does not call a page conflicted for repeating one canonical two ways", () => {
		/**
		 * One URL written twice, once with a trailing slash. The page has declared
		 * a single canonical and said so clumsily; deduplicating before comparing
		 * is what stops that reading as "this page cannot decide".
		 */
		expect(
			canonicalFindings({
				pages: [
					page("/en/pricing", {
						metadata: {
							canonicals: [`${BASE}/en/pricing`, `${BASE}/en/pricing/`],
						},
					}),
				],
			}),
		).toEqual([]);
	});

	it("leaves a page whose canonical target declares none to the missing rule", () => {
		/**
		 * A→B where B declares nothing. That is B missing a canonical, not A
		 * pointing down a chain — and filing it against A would name the wrong
		 * page in the finding the reader has to act on.
		 */
		const findings = canonicalFindings({
			pages: [
				page("/en/a", { metadata: { canonicals: [`${BASE}/en/b`] } }),
				page("/en/b"),
			],
		});

		expect(findings).toHaveLength(1);
		expect(findings[0]?.type).toBe("canonical_missing");
		expect(findings[0]?.url).toBe(`${BASE}/en/b`);
	});
});

describe("pages asking not to be indexed", () => {
	const noindex = (finding: { type: string }) =>
		finding.type === "noindex_present";

	/** A generic `<meta name="robots">`, the shape the extractor produces. */
	const markup = (...directives: string[]) => ({
		robots: [{ crawler: null, directives }],
	});

	it("reports a noindex in markup, naming the channel", () => {
		const findings = detailedFindingsFor({
			pages: [page("/en/staging", { metadata: markup("noindex") })],
		}).filter(noindex);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.url).toBe(`${BASE}/en/staging`);
		expect(findings[0]?.detail).toMatchObject({
			channels: ["markup"],
			sources: [{ channel: "markup", crawler: null, directive: "noindex" }],
			indexingChannels: [],
		});
	});

	it("reports a noindex carried only by the response header", () => {
		/**
		 * The case a markup-only check is blind to, and the reason `CrawledPage`
		 * keeps a header at all. A `noindex` served at the CDN or framework layer
		 * is invisible in page source — everyone reviewing the page sees nothing
		 * wrong while the site is being removed from search.
		 */
		const findings = detailedFindingsFor({
			pages: [page("/en/staging", { xRobotsTag: "noindex" })],
		}).filter(noindex);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail).toMatchObject({
			channels: ["header"],
			sources: [{ channel: "header", crawler: null, directive: "noindex" }],
			indexingChannels: [],
		});
	});

	it("reports both channels in one finding when both carry it", () => {
		const findings = detailedFindingsFor({
			pages: [
				page("/en/staging", {
					metadata: markup("noindex"),
					xRobotsTag: "noindex",
				}),
			],
		}).filter(noindex);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail).toMatchObject({
			channels: ["header", "markup"],
			indexingChannels: [],
		});
	});

	it("records the disagreement when the markup says index and the header does not", () => {
		/**
		 * The dangerous shape, and the reason disagreement is evidence rather than
		 * a finding of its own: the outcome is identical — the page is deindexed —
		 * but this is what explains why nobody noticed.
		 */
		const findings = detailedFindingsFor({
			pages: [
				page("/en/staging", {
					metadata: markup("index", "follow"),
					xRobotsTag: "noindex",
				}),
			],
		}).filter(noindex);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail).toMatchObject({
			channels: ["header"],
			indexingChannels: ["markup"],
		});
	});

	it("treats content=none as a noindex, quoting the word published", () => {
		/**
		 * `none` is defined as equivalent to `noindex, nofollow`. The equivalence
		 * is vocabulary the rule applies; the evidence stays the word the site
		 * actually wrote, so a reader searching their template can find it.
		 */
		const findings = detailedFindingsFor({
			pages: [page("/en/staging", { metadata: markup("none") })],
		}).filter(noindex);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail).toMatchObject({
			sources: [{ channel: "markup", crawler: null, directive: "none" }],
		});
	});

	it("names the crawler a scoped directive was addressed to", () => {
		/**
		 * A `googlebot`-scoped noindex and a generic one have different blast
		 * radii, and a finding that cannot say which it saw is asking the reader
		 * to go and look.
		 */
		const findings = detailedFindingsFor({
			pages: [
				page("/en/staging", {
					metadata: {
						robots: [{ crawler: "googlebot", directives: ["noindex"] }],
					},
				}),
			],
		}).filter(noindex);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail).toMatchObject({
			sources: [
				{ channel: "markup", crawler: "googlebot", directive: "noindex" },
			],
		});
	});

	it("names the crawler a scoped header was addressed to", () => {
		const findings = detailedFindingsFor({
			pages: [page("/en/staging", { xRobotsTag: "googlebot: noindex" })],
		}).filter(noindex);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail).toMatchObject({
			sources: [
				{ channel: "header", crawler: "googlebot", directive: "noindex" },
			],
		});
	});

	it("says nothing about a page both channels ask to be indexed", () => {
		expect(
			detailedFindingsFor({
				pages: [
					page("/en/pricing", {
						metadata: markup("index", "follow"),
						xRobotsTag: "index, follow",
					}),
				],
			}).filter(noindex),
		).toEqual([]);
	});

	it("says nothing about a page that declared nothing either way", () => {
		expect(
			detailedFindingsFor({ pages: [page("/en/pricing")] }).filter(noindex),
		).toEqual([]);
	});

	it("says nothing about a page that failed", () => {
		expect(
			detailedFindingsFor({
				pages: [
					page("/en/gone", {
						status: 404,
						metadata: markup("noindex"),
						xRobotsTag: "noindex",
					}),
				],
			}).filter(noindex),
		).toEqual([]);
	});

	it("still reports a header noindex on a response that was not HTML", () => {
		/**
		 * Deliberately *not* skipped, unlike every other metadata rule. Serving
		 * `X-Robots-Tag` on a PDF is the header's textbook use, so this is exactly
		 * where it is the only channel available — a rule skipping non-HTML would
		 * be blind precisely where the header matters most.
		 */
		expect(
			detailedFindingsFor({
				pages: [
					page("/en/brochure", {
						content: { isHtml: false },
						xRobotsTag: "noindex",
					}),
				],
			}).filter(noindex),
		).toHaveLength(1);
	});

	it("still reports what it saw on a crawl that stopped early", () => {
		/**
		 * No `crawlComplete` guard, and none is wanted: the evidence is on the page
		 * in front of us rather than in the shape of what we reached.
		 */
		expect(
			detailedFindingsFor({
				crawlComplete: false,
				pages: [page("/en/staging", { xRobotsTag: "noindex" })],
			}).filter(noindex),
		).toHaveLength(1);
	});
});

describe("one page's content at several URLs", () => {
	const duplicatedContent = (f: { type: string }) =>
		f.type === "content_duplicated";

	/**
	 * A page whose content the extractor isolated and that carries enough text to
	 * be worth comparing. The default `page` helper produces neither, so every
	 * case here states both — and the cases that mean "not comparable" say so by
	 * leaving one of them out.
	 */
	const body = (digest: string, textLength = 800) => ({
		isolated: true,
		textDigest: digest,
		textLength,
	});

	it("reports two URLs serving the same content, once, naming both", () => {
		/**
		 * The case rule 7 deliberately declines: two URLs, one language, one body.
		 * Its comment calls this out in as many words — "two URLs serving one
		 * language identically is duplicate content — a real problem, a different
		 * one" — and this is that different problem, which is FR-020.
		 */
		const findings = detailedFindingsFor({
			pages: [
				page("/en/article", { content: body("d1") }),
				page("/en/article-copy", { content: body("d1") }),
			],
		}).filter(duplicatedContent);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.url).toBeNull();
		expect(findings[0]?.detail).toMatchObject({
			digest: "d1",
			textLength: 800,
			urls: [`${BASE}/en/article`, `${BASE}/en/article-copy`],
		});
	});

	it("reports across languages too, where no family connects the pages", () => {
		/**
		 * Indifferent to language on purpose. Whether two URLs serve the same bytes
		 * is not a question about what language those bytes are in — and with no
		 * hreflang between them there is no family for rule 7 to have spoken about.
		 */
		expect(
			detailedFindingsFor({
				pages: [
					page("/en/article", { content: body("d1") }),
					page("/de/artikel", { content: body("d1") }),
				],
			}).filter(duplicatedContent),
		).toHaveLength(1);
	});

	it("says nothing about a set rule 7 already reported", () => {
		/**
		 * Two declared siblings serving one body. Rule 7 names the more specific
		 * defect — a translation that was never made — so repeating the same URLs
		 * here would be one problem under two headings.
		 */
		const alternates = { en: "/en/x", de: "/de/x" };
		const findings = detailedFindingsFor({
			pages: [
				page("/en/x", { hreflang: alternates, content: body("d1") }),
				page("/de/x", { hreflang: alternates, content: body("d1") }),
			],
		});

		expect(findings.filter(duplicatedContent)).toEqual([]);
		expect(
			findings.filter((f) => f.type === "content_untranslated"),
		).toHaveLength(1);
	});

	it("still reports when a page outside the family shares the content", () => {
		/**
		 * A larger fact than rule 7 observed. Suppressing on the digest alone would
		 * lose the third URL entirely, so the suppression is keyed on the exact set
		 * rule 7 named.
		 */
		const alternates = { en: "/en/x", de: "/de/x" };
		expect(
			detailedFindingsFor({
				pages: [
					page("/en/x", { hreflang: alternates, content: body("d1") }),
					page("/de/x", { hreflang: alternates, content: body("d1") }),
					page("/archive/x", { content: body("d1") }),
				],
			}).filter(duplicatedContent),
		).toHaveLength(1);
	});

	it("says nothing when the site canonicalises the copies to one address", () => {
		/**
		 * The documented remedy for duplicate content, working. A site that names
		 * one canonical for both URLs has already said which address counts, and
		 * reporting it would blame the site for doing the thing this finding exists
		 * to ask for.
		 */
		expect(
			detailedFindingsFor({
				pages: [
					page("/en/article", {
						content: body("d1"),
						metadata: { canonicals: [`${BASE}/en/article`] },
					}),
					page("/en/article-copy", {
						content: body("d1"),
						metadata: { canonicals: [`${BASE}/en/article`] },
					}),
				],
			}).filter(duplicatedContent),
		).toEqual([]);
	});

	it("says nothing about pages whose content was never isolated", () => {
		/**
		 * A fallback summary carries the navigation with it, and across arbitrary
		 * URLs the two sides may not even describe the same region — a `<main>` on
		 * one and a whole body on the other. Declining is the honest answer, and the
		 * same one rule 8 gives.
		 */
		expect(
			detailedFindingsFor({
				pages: [
					page("/en/article", {
						content: { isolated: false, textDigest: "d1", textLength: 800 },
					}),
					page("/en/article-copy", {
						content: { isolated: false, textDigest: "d1", textLength: 800 },
					}),
				],
			}).filter(duplicatedContent),
		).toEqual([]);
	});

	it("says nothing about pages with too little text to compare", () => {
		/**
		 * The comparable-length floor, inherited rather than restated: the extractor
		 * publishes no digest below it, so two nearly-empty pages cannot match.
		 */
		expect(
			detailedFindingsFor({
				pages: [
					page("/en/thin", { content: { isolated: true, textLength: 40 } }),
					page("/en/thin-copy", {
						content: { isolated: true, textLength: 40 },
					}),
				],
			}).filter(duplicatedContent),
		).toEqual([]);
	});

	it("says nothing about a response that was never HTML", () => {
		expect(
			detailedFindingsFor({
				pages: [
					page("/brochure.pdf", {
						content: { ...body("d1"), isHtml: false },
					}),
					page("/brochure-copy.pdf", {
						content: { ...body("d1"), isHtml: false },
					}),
				],
			}).filter(duplicatedContent),
		).toEqual([]);
	});

	it("does not count a failed page towards a duplicate", () => {
		expect(
			detailedFindingsFor({
				pages: [
					page("/en/article", { content: body("d1") }),
					page("/en/article-copy", { status: 404, content: body("d1") }),
				],
			}).filter(duplicatedContent),
		).toEqual([]);
	});

	it("says nothing about a duplicate on a truncated crawl", () => {
		/**
		 * The same guard rule 10 carries, for the same reason. The finding's
		 * substance is the list of URLs serving the content, and a run that stopped
		 * at its ceiling can hold one member of a pair and not the other.
		 */
		expect(
			detailedFindingsFor({
				crawlComplete: false,
				pages: [
					page("/en/article", { content: body("d1") }),
					page("/en/article-copy", { content: body("d1") }),
				],
			}).filter(duplicatedContent),
		).toEqual([]);
	});

	it("says nothing when every page serves its own content", () => {
		expect(
			detailedFindingsFor({
				pages: [
					page("/en/article", { content: body("d1") }),
					page("/en/other", { content: body("d2") }),
				],
			}).filter(duplicatedContent),
		).toEqual([]);
	});
});

describe("links to a page that does not load", () => {
	const broken = (f: { type: string }) => f.type === "link_broken";

	/** A page that links somewhere, written the way the crawler records it. */
	const linking = (path: string, links: string[]): CrawledPage => ({
		...page(path),
		links: links.map((href) => `${BASE}${href}`),
	});

	it("reports one finding per dead target, naming every page that links to it", () => {
		/**
		 * The shape this rule exists for. A dead URL in site-wide navigation is
		 * linked from every page on the site, and per-page reporting would turn one
		 * defect into a finding for each — the failure rule 5's family-level shape
		 * was written to prevent, in the setting where it bites hardest.
		 */
		const findings = detailedFindingsFor({
			pages: [
				linking("/", ["/gone"]),
				linking("/about", ["/gone"]),
				linking("/contact", ["/gone"]),
				page("/gone", { status: 404 }),
			],
		}).filter(broken);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.url).toBeNull();
		expect(findings[0]?.detail).toMatchObject({
			target: `${BASE}/gone`,
			httpStatus: 404,
			linkedFrom: [`${BASE}/`, `${BASE}/about`, `${BASE}/contact`],
		});
	});

	it("says nothing about a link to a page that loads", () => {
		expect(
			detailedFindingsFor({
				pages: [linking("/", ["/about"]), page("/about")],
			}).filter(broken),
		).toEqual([]);
	});

	it("says nothing about a link the crawl never recorded", () => {
		/**
		 * The URL may sit beyond the page ceiling, or behind a redirect to a page
		 * already recorded under another name. Calling either one dead would report
		 * where we stopped, or our own identity rules, as the client's defect —
		 * which is the failure `lessons.md` was written after.
		 */
		expect(
			detailedFindingsFor({
				pages: [linking("/", ["/never-crawled"])],
			}).filter(broken),
		).toEqual([]);
	});

	it("says nothing about a link that leaves the configured scope", () => {
		/**
		 * The crawl was told not to go there, so its absence is the configuration
		 * working. The same guard rules 3 and 13 carry.
		 */
		expect(
			detailedFindingsFor({
				pages: [linking("/", ["/private/secret"])],
				inScope: (url) => !url.startsWith(`${BASE}/private`),
			}).filter(broken),
		).toEqual([]);
	});

	it("defers to the rule that already named the target as a broken sibling", () => {
		/**
		 * Rule 2 says the same URL is broken *and* that a page declared it as a
		 * language variant, which is the fact worth acting on. "It is also linked
		 * from one page" does not earn a second heading in the list.
		 */
		const findings = detailedFindingsFor({
			pages: [
				{
					...linking("/en/contact", ["/de/kontakt"]),
					hreflangTargets: {
						en: `${BASE}/en/contact`,
						de: `${BASE}/de/kontakt`,
					},
				},
				page("/de/kontakt", { status: 404 }),
			],
		});

		expect(findings.filter(broken)).toEqual([]);
		expect(
			findings.filter((f) => f.type === "hreflang_target_failed"),
		).toHaveLength(1);
	});

	it("defers to the rule that already named the target as a broken canonical", () => {
		const findings = detailedFindingsFor({
			pages: [
				{
					...linking("/article", ["/canonical-target"]),
					metadata: {
						...page("/article").metadata,
						canonicals: [`${BASE}/canonical-target`],
					},
				},
				page("/canonical-target", { status: 404 }),
			],
		});

		expect(findings.filter(broken)).toEqual([]);
		expect(
			findings.filter((f) => f.type === "canonical_target_broken"),
		).toHaveLength(1);
	});

	it("reports a 5xx only once a second request has confirmed it", () => {
		const pages = [linking("/", ["/down"]), page("/down", { status: 503 })];

		expect(
			detailedFindingsFor({
				pages,
				reverified: [
					{
						url: `${BASE}/down`,
						first: { httpStatus: 503, fetchError: null },
						second: { httpStatus: 503, fetchError: null },
						confirmed: true,
					},
				],
			}).filter(broken),
		).toHaveLength(1);
	});

	it("says nothing about a 5xx that recovered when asked again", () => {
		/**
		 * The transient-502 scar, end to end at the rule's own level.
		 *
		 * The crawl keeps the later observation, so the page arrives here answering
		 * 200 and the `reverified` entry records what it looked like before.
		 * Asserted as one case rather than trusting the two halves to compose,
		 * because "the crawl fixes it" and "the rule respects the fix" are exactly
		 * the pair that can drift apart later.
		 */
		expect(
			detailedFindingsFor({
				pages: [linking("/", ["/recovered"]), page("/recovered")],
				reverified: [
					{
						url: `${BASE}/recovered`,
						first: { httpStatus: 502, fetchError: null },
						second: { httpStatus: 200, fetchError: null },
						confirmed: false,
					},
				],
			}).filter(broken),
		).toEqual([]);
	});

	it("says nothing about a 5xx that was never asked about twice", () => {
		/**
		 * No second look happened, which on this codebase means the crawl aborted —
		 * and an aborting crawl is one where the site is struggling. The honest
		 * reading is a bad moment, not a dead link.
		 */
		expect(
			detailedFindingsFor({
				pages: [linking("/", ["/down"]), page("/down", { status: 503 })],
				reverified: [],
			}).filter(broken),
		).toEqual([]);
	});

	it("reports a 404 without requiring confirmation", () => {
		/**
		 * A 404 is a stable answer, and reporting it is what this product is for.
		 * Requiring a second observation would make the commonest true finding the
		 * hardest one to earn.
		 */
		const findings = detailedFindingsFor({
			pages: [linking("/", ["/gone"]), page("/gone", { status: 404 })],
			reverified: [],
		}).filter(broken);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail.confirmed).toBe(false);
	});

	it("does not report a page for linking to itself", () => {
		expect(
			detailedFindingsFor({
				pages: [{ ...page("/gone", { status: 404 }), links: [`${BASE}/gone`] }],
			}).filter(broken),
		).toEqual([]);
	});

	it("names each linking page once, however many times it links", () => {
		const findings = detailedFindingsFor({
			pages: [
				{
					...page("/"),
					links: [`${BASE}/gone`, `${BASE}/gone`],
				},
				page("/gone", { status: 404 }),
			],
		}).filter(broken);

		expect(findings[0]?.detail.linkedFrom).toEqual([`${BASE}/`]);
	});
});

describe("a certificate that is not what it should be", () => {
	const certProblem = (f: { type: string }) => f.type === "certificate_problem";

	/**
	 * An observation stated directly, the way `page` states a content digest.
	 *
	 * Minting a real certificate would need OpenSSL or a certificate authority,
	 * and would make every case here depend on the probe as well as on the rule —
	 * so a failure would no longer say which of the two was wrong. `tls.test.ts`
	 * covers the reading; this covers the judging.
	 */
	const observed = (days: number | null, error: string | null = null) => ({
		origin: BASE,
		issuer: "Test CA",
		subject: "shop.test",
		validFrom: new Date(Date.now() - 86_400_000 * 300).toISOString(),
		validTo:
			days === null
				? null
				: new Date(Date.now() + 86_400_000 * days).toISOString(),
		subjectAltNames: ["shop.test"],
		authorizationError: error,
	});

	it("reports a certificate that has already expired", () => {
		const findings = detailedFindingsFor({
			pages: [page("/")],
			certificate: observed(-3),
		}).filter(certProblem);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.url).toBeNull();
		expect(findings[0]?.detail).toMatchObject({
			kind: "expired",
			origin: BASE,
			issuer: "Test CA",
		});
	});

	it("reports a certificate inside the renewal window", () => {
		/**
		 * Thirty days is anchored outside our own taste: Let's Encrypt issues
		 * ninety-day certificates and renews at thirty remaining, so a certificate
		 * inside that window on an automated site has already missed a renewal.
		 */
		const findings = detailedFindingsFor({
			pages: [page("/")],
			certificate: observed(10),
		}).filter(certProblem);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail).toMatchObject({
			kind: "expiring_soon",
			daysRemaining: 10,
		});
	});

	it("says nothing about a certificate with months left", () => {
		expect(
			detailedFindingsFor({
				pages: [page("/")],
				certificate: observed(60),
			}).filter(certProblem),
		).toEqual([]);
	});

	it("reports a certificate issued for a different hostname", () => {
		const findings = detailedFindingsFor({
			pages: [page("/")],
			certificate: observed(60, "ERR_TLS_CERT_ALTNAME_INVALID"),
		}).filter(certProblem);

		expect(findings[0]?.detail.kind).toBe("hostname_mismatch");
	});

	it("reports a chain that could not be verified", () => {
		/**
		 * Usually a missing intermediate, which is why the code travels with the
		 * finding: the fix differs from a name mismatch entirely.
		 */
		const findings = detailedFindingsFor({
			pages: [page("/")],
			certificate: observed(60, "UNABLE_TO_VERIFY_LEAF_SIGNATURE"),
		}).filter(certProblem);

		expect(findings[0]?.detail).toMatchObject({
			kind: "untrusted_chain",
			authorizationError: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
		});
	});

	it("calls an expired certificate expired even when the chain also rejected it", () => {
		/**
		 * One certificate to replace is one finding. Reporting expiry and rejection
		 * separately would be two headings for one job.
		 */
		const findings = detailedFindingsFor({
			pages: [page("/")],
			certificate: observed(-1, "CERT_HAS_EXPIRED"),
		}).filter(certProblem);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail.kind).toBe("expired");
	});

	it("says nothing when there was no certificate to read", () => {
		/**
		 * A plain-http origin, or a probe that could not connect. Reporting "we
		 * could not check" as a defect would be a claim about us.
		 */
		expect(
			detailedFindingsFor({ pages: [page("/")], certificate: null }).filter(
				certProblem,
			),
		).toEqual([]);
	});
});

describe("security headers the site disagrees with itself about", () => {
	const headerIssue = (f: { type: string }) =>
		f.type === "security_header_contradiction";

	const withHeaders = (path: string, securityHeaders: Record<string, string>) =>
		page(path, { securityHeaders });

	it("says nothing about a header the site never sends", () => {
		/**
		 * The negative assertion this whole rule rests on. "Every page should carry
		 * a Content Security Policy" is our standard, not the site's assertion, and
		 * a rule resting on it would be a claim about our preferences rather than a
		 * finding about anybody's site.
		 */
		expect(
			detailedFindingsFor({
				pages: [withHeaders("/", {}), withHeaders("/about", {})],
			}).filter(headerIssue),
		).toEqual([]);
	});

	it("says nothing when every page carries the same header", () => {
		expect(
			detailedFindingsFor({
				pages: [
					withHeaders("/", { "x-frame-options": "SAMEORIGIN" }),
					withHeaders("/about", { "x-frame-options": "SAMEORIGIN" }),
				],
			}).filter(headerIssue),
		).toEqual([]);
	});

	it("reports a header the site sends on some pages and not others", () => {
		/**
		 * Rule 11's narrowing applied to a second optional thing: the site using the
		 * header somewhere is what makes its absence elsewhere evidence rather than
		 * a preference of ours. This is the real defect in the area — a template or
		 * edge rule that covers most routes and misses a few.
		 */
		const findings = detailedFindingsFor({
			pages: [
				withHeaders("/", {
					"strict-transport-security": "max-age=63072000",
				}),
				withHeaders("/about", {
					"strict-transport-security": "max-age=63072000",
				}),
				withHeaders("/legacy", {}),
			],
		}).filter(headerIssue);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.url).toBeNull();
		expect(findings[0]?.detail).toMatchObject({
			kind: "inconsistent",
			header: "strict-transport-security",
			pagesPublishing: 2,
			affectedUrls: [`${BASE}/legacy`],
		});
	});

	it("says nothing about an inconsistency on a truncated crawl", () => {
		/**
		 * This half reasons from absence — the pages that did not carry the header —
		 * and a truncated run can hold exactly the subset that omits it. The guard
		 * written after a page ceiling was reported as eighteen defects on a live
		 * client site.
		 */
		expect(
			detailedFindingsFor({
				crawlComplete: false,
				pages: [
					withHeaders("/", { "referrer-policy": "no-referrer" }),
					withHeaders("/legacy", {}),
				],
			}).filter(headerIssue),
		).toEqual([]);
	});

	it("reports an HSTS header with no max-age", () => {
		/**
		 * `max-age` is the header's one required directive, so a value without it
		 * cannot mean what it says. Anchored in the specification rather than in a
		 * preference about how long the policy should last.
		 */
		const findings = detailedFindingsFor({
			pages: [
				withHeaders("/", { "strict-transport-security": "includeSubDomains" }),
			],
		}).filter(headerIssue);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail).toMatchObject({
			kind: "malformed",
			header: "strict-transport-security",
			value: "includeSubDomains",
		});
	});

	it("accepts an HSTS header that does carry a max-age", () => {
		expect(
			detailedFindingsFor({
				pages: [
					withHeaders("/", {
						"strict-transport-security": "max-age=31536000; includeSubDomains",
					}),
				],
			}).filter(headerIssue),
		).toEqual([]);
	});

	it("reports an X-Content-Type-Options that is not nosniff", () => {
		/** The specification defines exactly one value for this header. */
		const findings = detailedFindingsFor({
			pages: [withHeaders("/", { "x-content-type-options": "sniff" })],
		}).filter(headerIssue);

		expect(findings[0]?.detail).toMatchObject({
			kind: "malformed",
			header: "x-content-type-options",
		});
	});

	it("reports a header published with an empty value", () => {
		/**
		 * Different from absence, and the reason the crawler records an absent
		 * header as an absent key: the site published this one and put nothing in
		 * it, which no specification allows.
		 */
		const findings = detailedFindingsFor({
			pages: [withHeaders("/", { "content-security-policy": "   " })],
		}).filter(headerIssue);

		expect(findings[0]?.detail).toMatchObject({
			kind: "malformed",
			header: "content-security-policy",
		});
	});

	it("does not judge a page that failed", () => {
		expect(
			detailedFindingsFor({
				pages: [
					withHeaders("/", { "referrer-policy": "no-referrer" }),
					page("/gone", { status: 404 }),
				],
			}).filter(headerIssue),
		).toEqual([]);
	});
});

describe("what the sitemap submits, and what robots.txt blocks", () => {
	const sitemapFailed = (f: { type: string }) =>
		f.type === "sitemap_url_failed";
	const missingFromSitemap = (f: { type: string }) =>
		f.type === "page_missing_from_sitemap";
	const blocked = (f: { type: string }) => f.type === "robots_blocks_indexable";

	/** A sitemap listing the given paths, as the crawl would have parsed one. */
	const sitemapOf = (...paths: string[]): SitemapDocument => ({
		discovery: "robots",
		sources: [`${BASE}/sitemap.xml`],
		entries: paths.map((path) => ({
			raw: `${BASE}${path}`,
			url: `${BASE}${path}`,
			source: `${BASE}/sitemap.xml`,
		})),
		truncated: false,
	});

	it("reports a sitemap URL the crawl recorded as failing", () => {
		const findings = detailedFindingsFor({
			pages: [page("/"), page("/gone", { status: 404 })],
			sitemap: sitemapOf("/", "/gone"),
		}).filter(sitemapFailed);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.url).toBeNull();
		expect(findings[0]?.detail.entries).toMatchObject([
			{ normalised: `${BASE}/gone`, httpStatus: 404 },
		]);
	});

	it("says nothing about a sitemap URL the crawl simply never recorded", () => {
		/**
		 * The redirect trap, and it has no precedent in this codebase yet.
		 *
		 * The crawl records the URL the server *served* and discards a response
		 * that redirects to a page already recorded — so a sitemap URL that 301s to
		 * its canonical address was fetched successfully, is perfectly healthy, and
		 * never appears under its own name. Deriving failure from absence would
		 * report the site's own tidy redirects as broken sitemap entries: the
		 * redirect-alias false positive, in a third setting.
		 */
		expect(
			detailedFindingsFor({
				pages: [page("/")],
				sitemap: sitemapOf("/", "/redirects-somewhere"),
			}).filter(sitemapFailed),
		).toEqual([]);
	});

	it("says nothing about a failing sitemap URL on a truncated crawl", () => {
		expect(
			detailedFindingsFor({
				crawlComplete: false,
				pages: [page("/"), page("/gone", { status: 404 })],
				sitemap: sitemapOf("/", "/gone"),
			}).filter(sitemapFailed),
		).toEqual([]);
	});

	it("reports a live page the sitemap does not list", () => {
		const findings = detailedFindingsFor({
			pages: [page("/"), page("/orphaned-from-sitemap")],
			sitemap: sitemapOf("/"),
		}).filter(missingFromSitemap);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail).toMatchObject({
			urls: [`${BASE}/orphaned-from-sitemap`],
			sitemapEntryCount: 1,
		});
	});

	it("still reports a page missing from the sitemap on a truncated crawl", () => {
		/**
		 * Deliberately ungated, unlike almost everything else here.
		 *
		 * This rule reasons from the sitemap's completeness plus a *positive*
		 * observation — we fetched this page and it returned 200. Truncating the
		 * crawl can only make it quieter, never wrong: a page we never fetched is
		 * simply not among the pages being asked about.
		 */
		expect(
			detailedFindingsFor({
				crawlComplete: false,
				pages: [page("/"), page("/orphaned-from-sitemap")],
				sitemap: sitemapOf("/"),
			}).filter(missingFromSitemap),
		).toHaveLength(1);
	});

	it("says nothing about a noindex page the sitemap leaves out", () => {
		/**
		 * The site told search engines to skip this page, so omitting it from an
		 * index submission is the site agreeing with itself. Reporting it would be
		 * reporting a site for doing two things that match.
		 */
		expect(
			detailedFindingsFor({
				pages: [
					page("/"),
					page("/hidden", {
						metadata: { robots: [{ crawler: null, directives: ["noindex"] }] },
					}),
				],
				sitemap: sitemapOf("/"),
			}).filter(missingFromSitemap),
		).toEqual([]);
	});

	it("says nothing about a page whose canonical names another address", () => {
		/**
		 * The site nominated a different URL for this content, so a sitemap listing
		 * that URL instead is consistent. A self-referential canonical is not this
		 * case and stays reportable.
		 */
		expect(
			detailedFindingsFor({
				pages: [
					page("/"),
					page("/duplicate", {
						metadata: { canonicals: [`${BASE}/`] },
					}),
				],
				sitemap: sitemapOf("/"),
			}).filter(missingFromSitemap),
		).toEqual([]);
	});

	it("says nothing about a page that failed, or one out of scope", () => {
		expect(
			detailedFindingsFor({
				pages: [page("/"), page("/gone", { status: 404 })],
				sitemap: sitemapOf("/"),
			}).filter(missingFromSitemap),
		).toEqual([]);
	});

	it("reports one finding per blocking rule, listing every URL it matches", () => {
		/**
		 * FR-018 asks which robots.txt *rules* block pages — the rule is the
		 * subject, the pages are the evidence. A single `Disallow: /` matching four
		 * hundred sitemap URLs is one line to fix, not four hundred findings.
		 */
		const findings = detailedFindingsFor({
			pages: [page("/")],
			sitemap: sitemapOf("/admin/a", "/admin/b", "/admin/c", "/admin/d", "/"),
			robots: parseRobots(["User-agent: *", "Disallow: /admin"].join("\n")),
		}).filter(blocked);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.url).toBeNull();
		expect(findings[0]?.detail).toMatchObject({
			rule: "/admin",
			ruleLine: "Disallow: /admin",
			ruleLineNumber: 2,
			userAgentGroup: "*",
			urls: [
				`${BASE}/admin/a`,
				`${BASE}/admin/b`,
				`${BASE}/admin/c`,
				`${BASE}/admin/d`,
			],
		});
	});

	it("prefers the googlebot group over a permissive wildcard", () => {
		/**
		 * Reads backwards until you remember whose instruction the finding is
		 * about. We send no distinct user-agent, so on paper our group is `*` — but
		 * the claim is about what the site tells *search engines*, and Googlebot
		 * ignores the wildcard entirely once a group names it.
		 */
		const findings = detailedFindingsFor({
			pages: [page("/")],
			sitemap: sitemapOf("/anything"),
			robots: parseRobots(
				[
					"User-agent: *",
					"Disallow:",
					"User-agent: googlebot",
					"Disallow: /",
				].join("\n"),
			),
		}).filter(blocked);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail.userAgentGroup).toBe("googlebot");
	});

	it("says nothing when robots.txt and the sitemap do not overlap", () => {
		expect(
			detailedFindingsFor({
				pages: [page("/")],
				sitemap: sitemapOf("/public"),
				robots: parseRobots(["User-agent: *", "Disallow: /admin"].join("\n")),
			}).filter(blocked),
		).toEqual([]);
	});

	it("says nothing about a Disallow matching a URL the sitemap does not list", () => {
		/**
		 * The rejected formulation, asserted as an absence. "Blocked but linked
		 * from N pages" would fire on `/search`, `/cart`, `/login` and faceted
		 * navigation — the canonical *correct* uses of Disallow — and `page.links`
		 * is already in hand, which is what makes it tempting.
		 */
		expect(
			detailedFindingsFor({
				pages: [
					{ ...page("/"), links: [`${BASE}/admin/panel`] },
					page("/admin/panel"),
				],
				sitemap: sitemapOf("/"),
				robots: parseRobots(["User-agent: *", "Disallow: /admin"].join("\n")),
			}).filter(blocked),
		).toEqual([]);
	});

	it("reports a blocked sitemap URL even where the crawl was told not to go", () => {
		/**
		 * The one rule here that ignores the configured scope, deliberately.
		 *
		 * Elsewhere `inScope` suppresses a finding because the evidence would be an
		 * absence our configuration caused. Nothing is absent here — both facts are
		 * published, in two files, by the same site — and a section excluded from
		 * crawling is exactly where a contradiction is least likely to be noticed
		 * by hand.
		 */
		const findings = detailedFindingsFor({
			pages: [page("/")],
			inScope: (url) => !url.startsWith(`${BASE}/private`),
			sitemap: sitemapOf("/private/secret"),
			robots: parseRobots(["User-agent: *", "Disallow: /private"].join("\n")),
		}).filter(blocked);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail.urls).toEqual([`${BASE}/private/secret`]);
	});

	it("says nothing at all when the site published no sitemap", () => {
		/**
		 * Null is silence. All three rules rest on the sitemap being an assertion,
		 * and a site that made none has asserted nothing to contradict.
		 */
		const findings = detailedFindingsFor({
			pages: [page("/"), page("/gone", { status: 404 })],
			sitemap: null,
			robots: parseRobots(["User-agent: *", "Disallow: /"].join("\n")),
		});

		expect(findings.filter(sitemapFailed)).toEqual([]);
		expect(findings.filter(missingFromSitemap)).toEqual([]);
		expect(findings.filter(blocked)).toEqual([]);
	});
});

describe("pages the sitemap lists that nothing links to", () => {
	const orphaned = (f: { type: string }) => f.type === "page_orphaned";

	const sitemapOf = (...paths: string[]): SitemapDocument => ({
		discovery: "robots",
		sources: [`${BASE}/sitemap.xml`],
		entries: paths.map((path) => ({
			raw: `${BASE}${path}`,
			url: `${BASE}${path}`,
			source: `${BASE}/sitemap.xml`,
		})),
		truncated: false,
	});

	const linking = (path: string, links: string[]): CrawledPage => ({
		...page(path),
		links: links.map((href) => `${BASE}${href}`),
	});

	it("reports a sitemap URL the crawl never even requested", () => {
		/**
		 * The common orphan, and the only shape a link-following crawl can see —
		 * by its absence. Nothing on the site points at the page, so the frontier
		 * never held it and no page record exists to inspect.
		 *
		 * This is why the rule reads the requested-URL set rather than `pages`. An
		 * earlier draft checked `pages` for a record with no inbound link, which
		 * could never fire on this case at all: being absent from the crawl is
		 * precisely what being an orphan means.
		 */
		const findings = detailedFindingsFor({
			pages: [linking("/", ["/about"]), page("/about")],
			requested: [`${BASE}/`, `${BASE}/about`],
			entryUrl: `${BASE}/`,
			sitemap: sitemapOf("/", "/about", "/archive/unlinked"),
		}).filter(orphaned);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.url).toBeNull();
		expect(findings[0]?.detail.urls).toEqual([`${BASE}/archive/unlinked`]);
	});

	it("reports a page reached only because a sibling declared it", () => {
		/**
		 * The rarer shape: the crawl found it through the hreflang graph, which is
		 * a channel no reader navigates. It loads, it is submitted, and nothing
		 * links to it.
		 */
		const findings = detailedFindingsFor({
			pages: [
				linking("/", ["/about"]),
				page("/about"),
				page("/de/nur-hreflang"),
			],
			requested: [`${BASE}/`, `${BASE}/about`, `${BASE}/de/nur-hreflang`],
			entryUrl: `${BASE}/`,
			sitemap: sitemapOf("/", "/about", "/de/nur-hreflang"),
		}).filter(orphaned);

		expect(findings[0]?.detail.urls).toEqual([`${BASE}/de/nur-hreflang`]);
	});

	it("says nothing about a page something links to", () => {
		expect(
			detailedFindingsFor({
				pages: [linking("/", ["/about"]), page("/about")],
				requested: [`${BASE}/`, `${BASE}/about`],
				entryUrl: `${BASE}/`,
				sitemap: sitemapOf("/", "/about"),
			}).filter(orphaned),
		).toEqual([]);
	});

	it("never reports the page the crawl started from", () => {
		/**
		 * An entry page has no inbound link by construction — that is what makes it
		 * the entry. Reporting it would be a finding about where we chose to start.
		 */
		expect(
			detailedFindingsFor({
				pages: [linking("/", ["/about"]), page("/about")],
				requested: [`${BASE}/`, `${BASE}/about`],
				entryUrl: `${BASE}/`,
				sitemap: sitemapOf("/"),
			}).filter(orphaned),
		).toEqual([]);
	});

	it("says nothing about a URL the sitemap does not list", () => {
		/**
		 * FR-019 asks about pages "reachable via sitemap but linked from nowhere".
		 * An unlinked page the sitemap also omits is not published at all, which is
		 * a different thing and not this rule's claim.
		 */
		expect(
			detailedFindingsFor({
				pages: [linking("/", ["/about"]), page("/about")],
				requested: [`${BASE}/`, `${BASE}/about`],
				entryUrl: `${BASE}/`,
				sitemap: sitemapOf("/", "/about"),
			}).filter(orphaned),
		).toEqual([]);
	});

	it("says nothing about a sitemap URL that redirected somewhere linked", () => {
		/**
		 * The alias trap once more. A sitemap URL that 301s to a page already
		 * recorded *was* linked to — it is simply recorded under the name the
		 * server served. Judging by `pages` alone would call the site's own
		 * redirects orphans, which is the false-positive class `lessons.md` exists
		 * to prevent.
		 */
		expect(
			detailedFindingsFor({
				pages: [linking("/", ["/alias"]), page("/target")],
				// The alias was requested; only its target was recorded.
				requested: [`${BASE}/`, `${BASE}/alias`],
				entryUrl: `${BASE}/`,
				sitemap: sitemapOf("/alias"),
			}).filter(orphaned),
		).toEqual([]);
	});

	it("says nothing on a truncated crawl", () => {
		/**
		 * The guard every absence-reasoning rule here carries. A run that stopped
		 * early has not seen the pages that might link to this one, and reporting
		 * anyway would blame the site for where we stopped — which once produced
		 * eighteen false findings on a live client site.
		 */
		expect(
			detailedFindingsFor({
				crawlComplete: false,
				pages: [linking("/", ["/about"]), page("/about")],
				requested: [`${BASE}/`, `${BASE}/about`],
				entryUrl: `${BASE}/`,
				sitemap: sitemapOf("/", "/archive/unlinked"),
			}).filter(orphaned),
		).toEqual([]);
	});

	it("says nothing when the site published no sitemap", () => {
		expect(
			detailedFindingsFor({
				pages: [linking("/", []), page("/unlinked")],
				requested: [`${BASE}/`, `${BASE}/unlinked`],
				entryUrl: `${BASE}/`,
				sitemap: null,
			}).filter(orphaned),
		).toEqual([]);
	});
});

describe("links that leave the site", () => {
	const externalBroken = (f: { type: string }) =>
		f.type === "link_external_broken";

	const linking = (path: string, links: string[]): CrawledPage => ({
		...page(path),
		links,
	});

	const sweep = (
		checked: Array<{
			url: string;
			httpStatus: number | null;
			fetchError?: string | null;
			confirmed?: boolean;
		}>,
		complete = true,
	) => ({
		complete,
		checked: checked.map((check) => ({
			url: check.url,
			httpStatus: check.httpStatus,
			fetchError: check.fetchError ?? null,
			confirmed: check.confirmed ?? false,
		})),
	});

	it("reports a link to a page another site says is gone", () => {
		const findings = detailedFindingsFor({
			pages: [linking("/", ["https://elsewhere.test/gone"])],
			external: sweep([
				{ url: "https://elsewhere.test/gone", httpStatus: 404 },
			]),
		}).filter(externalBroken);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.url).toBeNull();
		expect(findings[0]?.detail).toMatchObject({
			target: "https://elsewhere.test/gone",
			httpStatus: 404,
			linkedFrom: [`${BASE}/`],
		});
	});

	it("says nothing about a host that merely refused us", () => {
		/**
		 * The narrowing that matters most here. A `403` is the host saying *we* may
		 * not have it — a fact about being an automated client — and reporting it
		 * would file someone else's access policy as the client's broken link.
		 * Bot-hostile hosts are common, and with no suppression mechanism yet such a
		 * finding would repeat in every future run forever.
		 */
		expect(
			detailedFindingsFor({
				pages: [linking("/", ["https://elsewhere.test/closed"])],
				external: sweep([
					{ url: "https://elsewhere.test/closed", httpStatus: 403 },
				]),
			}).filter(externalBroken),
		).toEqual([]);
	});

	it("says nothing about a host that was briefly down", () => {
		expect(
			detailedFindingsFor({
				pages: [linking("/", ["https://elsewhere.test/down"])],
				external: sweep([
					{ url: "https://elsewhere.test/down", httpStatus: 503 },
				]),
			}).filter(externalBroken),
		).toEqual([]);
	});

	it("reports a network failure only once it has been confirmed", () => {
		const pages = [linking("/", ["https://gone.test/x"])];

		expect(
			detailedFindingsFor({
				pages,
				external: sweep([
					{
						url: "https://gone.test/x",
						httpStatus: null,
						fetchError: "ENOTFOUND",
						confirmed: true,
					},
				]),
			}).filter(externalBroken),
		).toHaveLength(1);

		expect(
			detailedFindingsFor({
				pages,
				external: sweep([
					{
						url: "https://gone.test/x",
						httpStatus: null,
						fetchError: "ENOTFOUND",
						confirmed: false,
					},
				]),
			}).filter(externalBroken),
		).toEqual([]);
	});

	it("says nothing at all when the sweep did not finish", () => {
		/**
		 * An unchecked link is not a broken one. The sweep stops when its request
		 * budget runs out, when too much fails at the transport layer, or when the
		 * crawl aborted — and in none of those cases does what it managed to check
		 * describe the site.
		 */
		expect(
			detailedFindingsFor({
				pages: [linking("/", ["https://elsewhere.test/gone"])],
				external: sweep(
					[{ url: "https://elsewhere.test/gone", httpStatus: 404 }],
					false,
				),
			}).filter(externalBroken),
		).toEqual([]);
	});
});
