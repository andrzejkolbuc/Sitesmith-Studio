import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Fixture, startFixtureSite } from "../../../test/fixtures/site";
import { emptyContent } from "./content";
import { type CrawledPage, crawl } from "./crawler";
import { detectMissingVariants, FINDING_TYPES } from "./findings";
import { emptyMetadata } from "./metadata";
import { groupVariants, localeFromUrl } from "./variants";

let site: Fixture;

beforeAll(async () => {
	site = await startFixtureSite();
});

afterAll(async () => {
	await site.close();
});

/** Minimal page record, for grouping tests that need no HTTP. */
const page = (
	url: string,
	hreflangTargets: Record<string, string> = {},
): CrawledPage => ({
	url,
	httpStatus: 200,
	hreflangTargets,
	links: [],
	content: emptyContent(true),
	metadata: emptyMetadata(),
	xRobotsTag: null,
	fetchError: null,
});

describe("localeFromUrl", () => {
	it("recognises locale segments", () => {
		expect(localeFromUrl("https://x.test/de/preise")).toBe("de");
		expect(localeFromUrl("https://x.test/fr-ca/tarifs")).toBe("fr-ca");
		expect(localeFromUrl("https://x.test/pt_BR/precos")).toBe("pt-br");
	});

	it("does not mistake ordinary path segments for locales", () => {
		// The narrowing depends on this: a loose pattern would manufacture
		// findings on monolingual sites.
		expect(localeFromUrl("https://x.test/design/system")).toBeNull();
		expect(localeFromUrl("https://x.test/blog/post")).toBeNull();
		expect(localeFromUrl("https://x.test/")).toBeNull();
	});
});

describe("groupVariants", () => {
	it("produces the same grouping regardless of page order", () => {
		const a = page("https://x.test/a", {
			en: "https://x.test/a",
			de: "https://x.test/b",
		});
		const b = page("https://x.test/b", {
			en: "https://x.test/a",
			de: "https://x.test/b",
		});
		const c = page("https://x.test/c");

		const forward = groupVariants([a, b, c]);
		const reversed = groupVariants([c, b, a]);

		expect(forward.get(a.url)?.groupKey).toBe(reversed.get(a.url)?.groupKey);
		expect(forward.get(b.url)?.groupKey).toBe(reversed.get(b.url)?.groupKey);
		expect(forward.get(a.url)?.groupKey).toBe(forward.get(b.url)?.groupKey);
	});

	it("treats a one-directional declaration as a relationship", () => {
		// Real sites frequently declare hreflang on only one side of a pair.
		const a = page("https://x.test/a", { de: "https://x.test/b" });
		const b = page("https://x.test/b");

		const groups = groupVariants([a, b]);

		expect(groups.get(a.url)?.groupKey).toBe(groups.get(b.url)?.groupKey);
	});

	it("does not group a declared sibling the crawl never reached", () => {
		// An unreachable URL must stay a finding, not silently satisfy a locale.
		const a = page("https://x.test/a", { de: "https://x.test/never-crawled" });

		const groups = groupVariants([a]);

		expect(groups.size).toBe(1);
		expect(groups.get(a.url)?.groupKey).toBe(a.url);
	});

	it("leaves an unrelated page in its own group", () => {
		const groups = groupVariants([page("https://x.test/solo")]);

		expect(groups.get("https://x.test/solo")?.groupKey).toBe(
			"https://x.test/solo",
		);
	});
});

describe("detectMissingVariants against the fixture site", () => {
	async function detect() {
		const result = await crawl({
			startUrl: site.baseUrl,
			includePaths: [],
			excludePaths: ["/private", "/flaky"],
			maxConcurrency: 2,
			requestDelayMs: 0,
			maxPages: 50,
		});

		const inScope = (url: string) => {
			const path = new URL(url).pathname;
			return !path.startsWith("/private") && !path.startsWith("/flaky");
		};

		return {
			pages: result.pages,
			findings: detectMissingVariants({
				pages: result.pages,
				expectedLocales: ["en", "de", "fr"],
				inScope,
				// The fixture is small enough that every crawl here reaches the end.
				crawlComplete: true,
			}),
		};
	}

	it("reports families that publish only two of three expected locales", async () => {
		const { findings } = await detect();
		const missing = findings.filter(
			(f) => f.type === FINDING_TYPES.MISSING_LOCALE,
		);

		/**
		 * Two families qualify, both missing French:
		 *   /pricing + /de/preise  — en and de both healthy
		 *   /contact + /de/kontakt — de present but broken, which rule 2 reports
		 *
		 * The single-page families (/about, /de/blog-post) are deliberately absent:
		 * one page is not evidence the site translates that content.
		 */
		expect(missing).toHaveLength(2);
		expect(missing.every((f) => f.detail.missingLocale === "fr")).toBe(true);
	});

	it("does not report a lone locale-shaped page as missing its siblings", async () => {
		const { findings } = await detect();

		// /de/blog-post has no family. It should produce a no-hreflang finding
		// and nothing about absent English or French versions.
		const aboutBlogPost = findings.filter(
			(f) => f.detail.groupKey === `${site.baseUrl}/de/blog-post`,
		);

		expect(aboutBlogPost).toHaveLength(0);
	});

	it("reports a declared sibling that returned an error", async () => {
		const { findings } = await detect();
		const failed = findings.filter(
			(f) => f.type === FINDING_TYPES.HREFLANG_TARGET_FAILED,
		);

		// /contact declares /de/kontakt, which 404s.
		expect(failed).toHaveLength(1);
		expect(failed[0]?.detail.target).toBe(`${site.baseUrl}/de/kontakt`);
		expect(failed[0]?.detail.httpStatus).toBe(404);
	});

	it("does not report a declared sibling that is out of scope", async () => {
		const { findings } = await detect();
		const unreached = findings.filter(
			(f) => f.type === FINDING_TYPES.HREFLANG_TARGET_UNREACHED,
		);

		// /about declares /private/ueber-uns, which the scope excludes.
		expect(unreached).toHaveLength(0);
	});

	it("reports a locale-shaped URL that declares nothing", async () => {
		const { findings } = await detect();
		const silent = findings.filter((f) => f.type === FINDING_TYPES.NO_HREFLANG);

		expect(silent).toHaveLength(1);
		expect(silent[0]?.url).toBe(`${site.baseUrl}/de/blog-post`);
		expect(silent[0]?.detail.impliedLocale).toBe("de");
	});

	/**
	 * The single most important assertion in this change.
	 *
	 * Rule 4 was narrowed specifically so an ordinary monolingual page stays
	 * silent. If this ever fails, the narrowing has regressed and the first run
	 * anyone looks at will be mostly noise.
	 */
	it("says nothing about a monolingual page with no hreflang", async () => {
		const { findings } = await detect();
		const monolingual = `${site.baseUrl}/blog/monolingual`;

		expect(findings.filter((f) => f.url === monolingual)).toHaveLength(0);
	});

	it("produces identical output across two runs of the same site", async () => {
		const first = await detect();
		const second = await detect();

		expect(JSON.stringify(second.findings)).toBe(
			JSON.stringify(first.findings),
		);
	});

	it("reports the page whose template never rendered", async () => {
		const { findings } = await detect();
		const markers = findings.filter(
			(f) =>
				f.type === FINDING_TYPES.CONTENT_UNTRANSLATED &&
				f.detail.kind === "placeholder_markers",
		);

		expect(markers).toHaveLength(1);
		expect(markers[0]?.url).toBe(`${site.baseUrl}/blog/draft`);
		expect(markers[0]?.detail.markers).toEqual(["unrendered_expression"]);
	});

	it("reports the German page that serves the English body, once", async () => {
		/**
		 * End to end from real HTML: the fixture serves `/de/handbuch` the same body
		 * as `/handbook`, and nothing else on the site shares content with anything.
		 * One finding naming both pages — not one finding per page.
		 */
		const { findings } = await detect();
		const identical = findings.filter(
			(f) =>
				f.type === FINDING_TYPES.CONTENT_UNTRANSLATED &&
				f.detail.kind === "identical_to_siblings",
		);

		expect(identical).toHaveLength(1);
		expect(identical[0]?.detail.urls).toEqual([
			`${site.baseUrl}/de/handbuch`,
			`${site.baseUrl}/handbook`,
		]);
		expect(identical[0]?.detail.locales).toEqual(["de", "en"]);
	});

	it("says nothing about three honest translations of different lengths", async () => {
		/**
		 * The assertion this whole slice rests on, and the direct answer to the PRD's
		 * unresolved objection that content drift is noise by default.
		 *
		 * `/story`, `/de/geschichte` and `/fr/histoire` run to 212, 414 and 243
		 * characters — materially different, as honest translations are. If this ever
		 * fails, the rule has started reporting translation for being translation.
		 */
		const { findings } = await detect();
		const family = [
			`${site.baseUrl}/story`,
			`${site.baseUrl}/de/geschichte`,
			`${site.baseUrl}/fr/histoire`,
		];

		const about = findings.filter((f) => {
			if (f.type !== FINDING_TYPES.CONTENT_UNTRANSLATED) return false;
			const urls = Array.isArray(f.detail.urls)
				? (f.detail.urls as string[])
				: [];
			return (
				family.includes(f.url ?? "") || urls.some((url) => family.includes(url))
			);
		});

		expect(about).toEqual([]);
	});

	it("reports the English page carrying a form its translations lack", async () => {
		const { findings } = await detect();
		const differs = findings.filter(
			(f) => f.type === FINDING_TYPES.CONTENT_STRUCTURE_DIFFERS,
		);

		expect(differs).toHaveLength(1);
		expect(differs[0]?.detail.differences).toEqual([
			{
				block: "form",
				present: [`${site.baseUrl}/quote`],
				absent: [`${site.baseUrl}/de/angebot`, `${site.baseUrl}/fr/devis`],
			},
		]);
	});

	it("says nothing about a family whose headings merely differ in number", async () => {
		/**
		 * The counterpart to the length objection, and the reason rule 8 compares
		 * presence rather than counts. `/de/geschichte` carries an extra `<h3>` its
		 * siblings do not — translators split and merge sections routinely — while
		 * every member still contains headings and a list.
		 *
		 * A rule counting headings would report this family. A reader would not.
		 */
		const { findings } = await detect();
		const family = [
			`${site.baseUrl}/story`,
			`${site.baseUrl}/de/geschichte`,
			`${site.baseUrl}/fr/histoire`,
		];

		/**
		 * Matched on membership, not on `groupKey`. The key is the lexicographically
		 * smallest member URL — `/de/geschichte` here, not `/story` — so filtering
		 * by the name a human would use silently matches nothing and asserts
		 * nothing. Found by mutation: making headings count-sensitive left this case
		 * green while breaking three others.
		 */
		const about = findings.filter((f) => {
			if (f.type !== FINDING_TYPES.CONTENT_STRUCTURE_DIFFERS) return false;
			const members = Array.isArray(f.detail.memberUrls)
				? (f.detail.memberUrls as string[])
				: [];
			return members.some((url) => family.includes(url));
		});

		expect(about).toEqual([]);
	});
});

describe("detectMissingVariants edge cases", () => {
	const allInScope = () => true;

	it("does not report missing locales for a family with no locale evidence", async () => {
		// Two unrelated pages, neither declaring anything. Expecting three locales
		// must not turn each into three findings.
		const findings = detectMissingVariants({
			pages: [page("https://x.test/a"), page("https://x.test/b")],
			expectedLocales: ["en", "de", "fr"],
			crawlComplete: true,
			inScope: allInScope,
		});

		expect(findings).toHaveLength(0);
	});

	/**
	 * Regression guard, found by running the real interface rather than by a test.
	 *
	 * A page whose declared German variant 404s was reported twice: once as
	 * "declared variant is broken", once as "no German version". One problem
	 * wearing two names, on the very screen a user judges the product by.
	 */
	it("does not also report a locale as missing when its page merely failed", () => {
		const healthy: CrawledPage = {
			url: "https://x.test/about",
			httpStatus: 200,
			hreflangTargets: {
				en: "https://x.test/about",
				de: "https://x.test/ueber-uns",
			},
			links: [],
			content: emptyContent(true),
			metadata: emptyMetadata(),
			xRobotsTag: null,
			fetchError: null,
		};
		// The declared German page exists but is broken, and its URL carries no
		// locale — so only the sibling's declaration identifies it.
		const broken: CrawledPage = {
			url: "https://x.test/ueber-uns",
			httpStatus: 404,
			hreflangTargets: {},
			links: [],
			content: emptyContent(true),
			metadata: emptyMetadata(),
			xRobotsTag: null,
			fetchError: null,
		};

		const findings = detectMissingVariants({
			pages: [healthy, broken],
			expectedLocales: ["en", "de"],
			crawlComplete: true,
			inScope: allInScope,
		});

		// The breakage is reported...
		expect(
			findings.filter((f) => f.type === FINDING_TYPES.HREFLANG_TARGET_FAILED),
		).toHaveLength(1);
		// ...and not a second time as an absence.
		expect(
			findings.filter((f) => f.type === FINDING_TYPES.MISSING_LOCALE),
		).toHaveLength(0);
	});

	it("still reports a locale no page claims at all", () => {
		// The correction above must not silence a genuine gap: French is expected
		// and nothing — working or broken — claims to be French.
		const en: CrawledPage = {
			url: "https://x.test/about",
			httpStatus: 200,
			hreflangTargets: {
				en: "https://x.test/about",
				de: "https://x.test/ueber-uns",
			},
			links: [],
			content: emptyContent(true),
			metadata: emptyMetadata(),
			xRobotsTag: null,
			fetchError: null,
		};
		const de: CrawledPage = {
			url: "https://x.test/ueber-uns",
			httpStatus: 200,
			hreflangTargets: {
				en: "https://x.test/about",
				de: "https://x.test/ueber-uns",
			},
			links: [],
			content: emptyContent(true),
			metadata: emptyMetadata(),
			xRobotsTag: null,
			fetchError: null,
		};

		const findings = detectMissingVariants({
			pages: [en, de],
			expectedLocales: ["en", "de", "fr"],
			crawlComplete: true,
			inScope: allInScope,
		});

		const missing = findings.filter(
			(f) => f.type === FINDING_TYPES.MISSING_LOCALE,
		);
		expect(missing).toHaveLength(1);
		expect(missing[0]?.detail.missingLocale).toBe("fr");
	});

	it("ignores a family in which every member errored", () => {
		const broken: CrawledPage = {
			url: "https://x.test/de/gone",
			httpStatus: 500,
			hreflangTargets: {},
			links: [],
			content: emptyContent(true),
			metadata: emptyMetadata(),
			xRobotsTag: null,
			fetchError: null,
		};

		const findings = detectMissingVariants({
			pages: [broken],
			expectedLocales: ["en", "de"],
			crawlComplete: true,
			inScope: allInScope,
		});

		expect(
			findings.filter((f) => f.type === FINDING_TYPES.MISSING_LOCALE),
		).toHaveLength(0);
	});
});
